<#
  theaestheticslyrics media bridge.

  Reads Windows' media sessions (System Media Transport Controls) and prints one
  JSON object per line on stdout:
    {"type":"hello","ps":"5.1…"}
    {"type":"sessions","t":<epoch ms>,"current":"<app id>|null","sessions":[…]}
    {"type":"art","key":"<app|title|artist|album>","mime":"image/jpeg","data":"<base64>"}
    {"type":"error","message":"…"}

  Must run under Windows PowerShell 5.1: PowerShell 7 cannot load WinRT types.
  Must be started with -MTA: the album art helper performs COM casts that hang
  on an STA thread (the app's MediaWatcher spawns it with -MTA).
#>
param(
  [int]$ParentPid = 0,
  [int]$IntervalMs = 250
)

$ErrorActionPreference = 'Stop'

# Write UTF-8 straight to the raw stdout stream so non-English titles survive,
# whatever the console code page is.
$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$script:Out.AutoFlush = $true

function Emit($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
  try {
    $script:Out.WriteLine($json)
  } catch {
    exit 0 # The parent closed the pipe.
  }
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
} catch {
  Emit @{ type = 'error'; message = "WinRT is unavailable: $($_.Exception.Message)" }
  exit 3
}

# --- Album art: C# helper ------------------------------------------------------
# PowerShell 5.1 on current Windows 11 builds cannot project the object that
# RandomAccessStreamReference.OpenReadAsync() returns: `$stream.Size` and
# ContentType never resolve, so every album art read failed silently. The tiny
# C# helper below is compiled against System32's WinRT metadata instead and is
# unaffected. It is compiled once per source version into TEMP; if compilation
# or the apartment is unsuitable, the pure-PowerShell reader further down stays
# available (it works on Windows builds where 5.1 projects WinRT streams).
$script:ArtHelper = $null    # [Type] once the helper compiled, otherwise $null
$script:ArtHelperReason = ''

$script:ArtHelperCSharp = @'
using System;
using System.Runtime.InteropServices;
using Windows.Foundation;
using Windows.Storage.Streams;

public static class ArtBridgeHelper
{
    // Waits for a WinRT IAsyncOperation<TResult> to finish without AsTask (the
    // System.Runtime.WindowsRuntime extension binds to a unified Windows.winmd
    // identity that is not present here). We poll IAsyncInfo instead.
    private static TResult Block<TResult>(IAsyncOperation<TResult> op)
    {
        IAsyncInfo info = (IAsyncInfo)op;
        int spins = 0;
        while ((int)info.Status == 0) // AsyncStatus.Started
        {
            System.Threading.Thread.Sleep(16);
            if (++spins > 3750) throw new TimeoutException("WinRT async operation did not complete");
        }
        Marshal.ThrowExceptionForHR(Marshal.GetHRForException(info.ErrorCode));
        return op.GetResults();
    }

    // Reads the picture behind an SMTC thumbnail reference. Accepts the raw COM
    // object (RCW) PowerShell holds so no metadata is needed on the caller side.
    public static byte[] ReadThumbBytes(object thumbRefRcw, out string mime)
    {
        mime = "";
        IRandomAccessStreamReference reference = (IRandomAccessStreamReference)thumbRefRcw;
        IRandomAccessStreamWithContentType stream = Block(reference.OpenReadAsync());
        try
        {
            mime = stream.ContentType ?? "";
            ulong streamSize = stream.Size;
            if (streamSize == 0 || streamSize > 8388608UL) return new byte[0];
            var reader = new DataReader(stream);
            try
            {
                uint loaded = Block<uint>((IAsyncOperation<uint>)reader.LoadAsync((uint)streamSize));
                byte[] data = new byte[loaded];
                reader.ReadBytes(data);
                return data;
            }
            finally { reader.Dispose(); }
        }
        finally { stream.Dispose(); }
    }
}
'@

$script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, [Type]$resultType, [int]$timeoutMs = 3000) {
  $task = $script:AsTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) { throw 'WinRT call timed out' }
  return $task.Result
}

function UnixMs($value) {
  try { return ([DateTimeOffset]$value).ToUnixTimeMilliseconds() } catch { return 0 }
}

function Read-Art($thumbnail) {
  if ($null -eq $thumbnail) { return $null }
  if ($null -ne $script:ArtHelper) {
    # Primary path: the compiled C# helper (see its header comment for why).
    $type = $script:ArtHelper
    [string]$mime = ''
    try {
      $bytes = $type::ReadThumbBytes($thumbnail, [ref]$mime)
      if ($null -eq $bytes -or $bytes.Length -eq 0) { return $null }
      if ([string]::IsNullOrWhiteSpace($mime)) { $mime = 'image/jpeg' }
      # Some publishers join variants ("image/jpeg,image/jpe,image/jpg");
      # the first entry is the real media type.
      $mime = ($mime -split ',')[0].Trim()
      return @{ mime = $mime; bytes = $bytes }
    } catch {
      return $null
    }
  }
  # Fallback: pure PowerShell (Windows builds where 5.1 projects WinRT streams).
  $stream = Await ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  try {
    $size = [uint32]$stream.Size
    if ($size -le 0 -or $size -gt 8MB) { return $null }
    $reader = New-Object Windows.Storage.Streams.DataReader($stream)
    try {
      $loaded = Await ($reader.LoadAsync($size)) ([uint32])
      $bytes = New-Object byte[] $loaded
      $reader.ReadBytes($bytes)
      return @{ mime = [string]$stream.ContentType; bytes = $bytes }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$script:Sha1 = New-Object System.Security.Cryptography.SHA1Managed
function HashOf([byte[]]$bytes) { return [BitConverter]::ToString($script:Sha1.ComputeHash($bytes)) }

function Compile-ArtHelper {
  # Compiles $script:ArtHelperCSharp once (cached in TEMP, keyed by a source
  # hash) and sets $script:ArtHelper to the loaded type. Returns $false rather
  # than failing loudly: the pure-PowerShell reader stays usable everywhere.
  try {
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::MTA) {
      # The helper's COM casts need a message pump; on an STA thread they hang.
      # The PS fallback never hangs, so it is the safe default in an STA host.
      $script:ArtHelperReason = 'apartment is STA (restart with -MTA)'
      return $false
    }
    $base = Join-Path ([IO.Path]::GetTempPath()) 'theaestheticslyrics'
    $null = [IO.Directory]::CreateDirectory($base)
    $srcPath = Join-Path $base 'ArtBridgeHelper.cs'
    [IO.File]::WriteAllText($srcPath, $script:ArtHelperCSharp)
    $sha = New-Object System.Security.Cryptography.SHA1Managed
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($script:ArtHelperCSharp))).Replace('-', '')
    $sha.Dispose()
    $dllPath = Join-Path $base ("ArtBridgeHelper-{0}.dll" -f $hash.Substring(0, 12))
    if (-not (Test-Path $dllPath)) {
      $fwdir = "$env:windir\Microsoft.NET\Framework64\v4.0.30319"
      if (-not (Test-Path $fwdir)) { $script:ArtHelperReason = 'no .NET Framework csc'; return $false }
      $csc = Join-Path $fwdir 'csc.exe'
      $gac = "$env:windir\Microsoft.NET\assembly\GAC_MSIL"
      $refs = @()
      foreach ($name in @('System.Runtime', 'System.ObjectModel', 'System.Threading.Tasks',
          'System.Runtime.InteropServices.WindowsRuntime', 'System.Collections', 'System.IO', 'System.Reflection')) {
        $dir = Join-Path $gac $name
        if (Test-Path $dir) {
          $hit = Get-ChildItem $dir -Filter '*.dll' -Recurse | Select-Object -First 1
          if ($hit) { $refs += $hit.FullName }
        }
      }
      $lines = New-Object System.Collections.ArrayList
      $null = $lines.Add('/nologo'); $null = $lines.Add('/t:library')
      $null = $lines.Add("`"/out:$dllPath`"")
      foreach ($r in $refs) { $null = $lines.Add("`"/r:$r`"") }
      $null = $lines.Add("`"/r:$fwdir\System.dll`""); $null = $lines.Add("`"/r:$fwdir\System.Core.dll`"")
      $null = $lines.Add("`"/r:$env:windir\System32\WinMetadata\Windows.Foundation.winmd`"")
      $null = $lines.Add("`"/r:$env:windir\System32\WinMetadata\Windows.Storage.winmd`"")
      $null = $lines.Add("`"$srcPath`"")
      $rspPath = Join-Path $base 'ArtBridgeHelper.rsp'
      [IO.File]::WriteAllText($rspPath, (($lines.ToArray()) -join "`r`n") + "`r`n")
      $cscOut = & $csc "@$rspPath" 2>&1
      if (-not (Test-Path $dllPath)) {
        $script:ArtHelperReason = 'compile failed: ' + (($cscOut | Select-Object -First 3 | ForEach-Object { [string]$_ }) -join ' ')
        return $false
      }
    }
    Add-Type -Path $dllPath
    $script:ArtHelper = [ArtBridgeHelper]
    return $true
  } catch {
    $script:ArtHelperReason = [string]$_.Exception.Message
    return $false
  }
}

$null = Compile-ArtHelper
if ($null -eq $script:ArtHelper -and $script:ArtHelperReason) {
  # One diagnostic so a silent fallback is never the reason art stops flowing.
  Emit @{ type = 'error'; message = "art: PowerShell reader in use ($script:ArtHelperReason)" }
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
try {
  $manager = Await ($managerType::RequestAsync()) $managerType 10000
} catch {
  Emit @{ type = 'error'; message = "Media session manager is unavailable: $($_.Exception.Message)" }
  exit 4
}

Emit @{ type = 'hello'; ps = "$($PSVersionTable.PSVersion)" }

# Album art per track key: read shortly after a track appears (players often publish
# the picture a moment after the title), then once more to catch late updates. The
# window covers ~20 s because some publishers (Kodama pushes state every ~15 s) make
# the thumbnail available later than the title.
$artState = @{}
$tick = 0
$lastJson = ''
$lastEmit = [DateTime]::MinValue
$lastError = [DateTime]::MinValue

while ($true) {
  $tick++
  try {
    if ($ParentPid -gt 0 -and ($tick % 8) -eq 0) {
      try { $null = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { exit 0 }
    }

    $current = $null
    try {
      $currentSession = $manager.GetCurrentSession()
      if ($null -ne $currentSession) { $current = [string]$currentSession.SourceAppUserModelId }
    } catch { }

    $list = New-Object System.Collections.ArrayList
    foreach ($session in $manager.GetSessions()) {
      try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType 2000
        $timeline = $session.GetTimelineProperties()
        $playback = $session.GetPlaybackInfo()
        $app = [string]$session.SourceAppUserModelId
        $title = [string]$props.Title
        $artist = [string]$props.Artist
        $album = [string]$props.AlbumTitle
        $status = [string]$playback.PlaybackStatus
        $rate = 1.0
        if ($null -ne $playback.PlaybackRate) { $rate = [double]$playback.PlaybackRate }

        $null = $list.Add([ordered]@{
            app     = $app
            status  = $status
            title   = $title
            artist  = $artist
            album   = $album
            pos     = [math]::Round($timeline.Position.TotalSeconds, 3)
            start   = [math]::Round($timeline.StartTime.TotalSeconds, 3)
            end     = [math]::Round($timeline.EndTime.TotalSeconds, 3)
            updated = (UnixMs $timeline.LastUpdatedTime)
            rate    = $rate
          })

        $key = "$app|$title|$artist|$album"
        $state = $artState[$key]
        if ($null -eq $state) {
          $state = @{ first = $tick; seen = $tick; hash = ''; done = $false }
          $artState[$key] = $state
        }
        $state.seen = $tick
        $age = $tick - $state.first
        if ($age -ge 2 -and $age -le 80 -and ($age % 4) -eq 2 -and ((-not $state.done) -or $age -eq 10)) {
          try {
            $art = Read-Art $props.Thumbnail
            if ($null -ne $art) {
              $hash = HashOf $art.bytes
              if ($hash -ne $state.hash) {
                $state.hash = $hash
                Emit ([ordered]@{ type = 'art'; key = $key; mime = $art.mime; data = [Convert]::ToBase64String($art.bytes) })
              }
              $state.done = $true
            }
          } catch {
            if (-not $state.artError) {
              # One diagnostic per key so a failing read is never fully silent.
              $state.artError = $true
              Emit @{ type = 'error'; message = "art: read threw for '$title' ($($_.Exception.Message))" }
            }
          }
        }
      } catch {
        # A session can disappear while it is being read; skip it this round.
      }
    }

    if (($tick % 400) -eq 0) {
      foreach ($k in @($artState.Keys)) { if ($tick - $artState[$k].seen -gt 400) { $artState.Remove($k) } }
    }

    $snapshot = [ordered]@{ type = 'sessions'; current = $current; sessions = @($list.ToArray()) }
    $json = ConvertTo-Json -InputObject $snapshot -Compress -Depth 6
    $now = [DateTime]::UtcNow
    if ($json -ne $lastJson -or ($now - $lastEmit).TotalMilliseconds -ge 2000) {
      $lastJson = $json
      $lastEmit = $now
      $snapshot['t'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      Emit $snapshot
    }
  } catch {
    if (([DateTime]::UtcNow - $lastError).TotalSeconds -ge 5) {
      $lastError = [DateTime]::UtcNow
      Emit @{ type = 'error'; message = [string]$_.Exception.Message }
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
