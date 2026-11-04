<p align="center">
  <img src="docs/images/banner.png" alt="theaestheticslyrics: every word lights up" width="100%">
</p>

<p align="center">
  <a href="https://github.com/darshanseenivasakumar/theaestheticslyrics/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/darshanseenivasakumar/theaestheticslyrics?color=ca415e&label=download"></a>
  <a href="https://github.com/darshanseenivasakumar/theaestheticslyrics/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/darshanseenivasakumar/theaestheticslyrics/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-ca415e">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-ca415e"></a>
</p>

**theaestheticslyrics** lights up the lyrics of the song you're playing one word at a time, right as each word is sung. It sits in the Windows system tray and follows Spotify, Apple Music or the [Kodama](https://github.com/KiyoshiTheDevil/Kodama) YouTube Music client. The lyrics show on a full-screen lyrics screen when you step away, or float over your desktop while you work.

It's a Windows take on [Verci](https://verci.xyz), a Mac app. It's free and open source, and you don't need an account or an API key.

## Download

1. Download the **`theaestheticslyrics-<version>-win-x64.zip`** file from the [latest release](https://github.com/darshanseenivasakumar/theaestheticslyrics/releases/latest). It needs Windows 10 or 11, 64-bit.
2. Unzip it anywhere you like.
3. Run **`theaestheticslyrics.exe`**. There's nothing to install. To uninstall, delete the folder.

> [!NOTE]
> The app isn't code-signed, so Windows SmartScreen may say *"Windows protected your PC"* the first time. Click **More info → Run anyway**. Every release is built from the source in this repository, and you can build it yourself (see [Build from source](#build-from-source)).

**Tip:** to put an icon on your desktop, right-click `theaestheticslyrics.exe`, then **Show more options → Send to → Desktop (create shortcut)**. Opening that icon while the app is already running shows the lyrics right away.

## Four styles

| Ship | Fisheye |
|:---:|:---:|
| <img src="docs/images/style-ship.png" alt="Ship style" width="420"> | <img src="docs/images/style-fisheye.png" alt="Fisheye style" width="420"> |
| Words stack into a wall that drifts in 3D. The word being sung pops forward on a highlight box. | A convex stack of words under a real glass-lens shader. The word being sung sits closest to the glass. |
| **Fisheye Visual** | **Visual** |
| <img src="docs/images/style-fisheye-visual.png" alt="Fisheye Visual style" width="420"> | <img src="docs/images/style-visual.png" alt="Visual style" width="420"> |
| The same lens, with icons beside the words. | One word at a time, with a matching icon or emoji beside it. About 800 words have one. |

*The screenshots use an original demo song written for this project.*

## How to use it

1. Play a song in **Spotify**, **Apple Music** or **Kodama**.
2. Press **Ctrl+Alt+L**. The lyrics fill the screen. Press **Esc** to close them.
3. Every setting is in the tray icon (the pink **a**). On Windows 11 it may be hidden under the **^** arrow; drag it onto the taskbar to keep it visible.

### Where the lyrics show

Pick one in tray → **Show Lyrics**.

- **On the Lock Screen** (the default). Windows doesn't let apps draw on the real lock screen, so the app has its own full-screen lyrics screen with a clock.
  - **Ctrl+Alt+L** opens it. It stays up while you move the mouse or skip songs. **Esc** closes it, and so does pressing **Ctrl+Alt+L** again.
  - **When you're away:** after 2 minutes without input, while a song with lyrics is playing, the lyrics screen opens on its own and closes when you come back. Change the delay or turn it off in tray → **Lyrics Screen When Idle**.
  - **Lock Windows When I Come Back** (off by default) turns Ctrl+Alt+L into "lock my PC with lyrics". Any key or mouse move then closes the lyrics and locks Windows, so your PIN or password is needed.
- **Always.** The words float above everything. Clicks go straight through them, and they hide 3 seconds after you pause.

### Colours

- The default palette is red for sung words, a pink highlight and soft pink for words still to come.
- **Auto Sync** takes the colours from the album art and keeps them readable on black.
- **Lyric Text…**, **Highlight…** and **Secondary Text…** let you pick your own colours. **Reset Colors** goes back to the defaults.

### Everything else in the tray

| Setting | What it does |
|---|---|
| **Display** | Picks the monitor the lyrics appear on. |
| **Style** | Ship, Fisheye, Fisheye Visual or Visual. |
| **Timing** | Shifts the words earlier or later. Bluetooth headphones usually need *0.25–0.5 s Later*. |
| **Precise Word Timing (NetEase)** | Uses real per-word timing when NetEase has the song in *Automatic* (see below). Pinning *NetEase* uses it regardless of this toggle. |
| **Players** | *Spotify and Apple Music* (the default), *Kodama* only, or *All Media Apps* (browsers and anything else that shows in Windows' media controls). |
| **Lyrics Provider** | *Automatic* (the default) uses every source below in order. Pick *Local Files Only*, *Musixmatch*, *Karalyr*, *Better Lyrics*, *LRCLIB* or *NetEase* to use only that source. |
| **Open Lyrics Folder** | Opens the folder for your own `.lrc` files. |
| **Start with Windows** | Starts the app quietly in the tray when you sign in. |

While a song with lyrics plays, your display stays awake. When the music stops, Windows' normal sleep and lock timers take over again.

By default, built-in sources ask [Karalyr](https://karalyr.com) first for word-by-word karaoke timing, then [Better Lyrics](https://docs.betterlyrics.org) for syllable timing, then [LRCLIB](https://lrclib.net) and [NetEase](https://music.163.com). Developers who paste their own [Musixmatch](https://developer.musixmatch.com) key into `src/main/secrets.ts` (copy the included `secrets.example.ts`; the file stays uncommitted) get Musixmatch's word-by-word timing too — with no key, everything still works through the usual fallbacks. Pin one source in tray → **Lyrics Provider** when you want to skip the fallbacks entirely.

### Following Kodama (YouTube Music)

[Kodama](https://github.com/KiyoshiTheDevil/Kodama) is a free desktop YouTube Music client for Windows. theaestheticslyrics follows it through Windows' own media controls — the same system Spotify and Apple Music use — so titles, artists, album art and progress arrive on their own; no plugin is needed in either app.

- Pick tray → **Players → Kodama** to follow only Kodama. Browsers and other apps stop competing for the lyrics, even with a paused YouTube session in the background.
- **All Media Apps** follows Kodama too, but it prefers whatever Windows considers the current session, so a second playing app can take over the lyrics. Choose *Kodama* when you want it to be the one and only source.

Two things to know, both coming from how Kodama updates Windows' media timeline (about every 15 seconds):

- After you seek inside Kodama, the lyrics catch up to the new spot at its next update — up to ~15 s. Pausing, resuming and changing tracks appear right away (within a second or so).
- The album art and the exact song length can lag a few seconds at first, while Windows fetches the YouTube thumbnail and Kodama learns the real duration. Lyrics matching adapts while the length is unknown.

## Where the lyrics come from

In **Automatic**, four free sources are tried in order:

- **[Karalyr](https://karalyr.com)**, an open karaoke lyrics database with real *word-by-word* timing for its songs. It is asked first; if it doesn't have the track, the app silently moves on.
- **[Better Lyrics](https://docs.betterlyrics.org)**, a cache-first API that serves Apple-Music-style TTML with *syllable-level* timing. Cached songs need no key; a song it has not seen is a quick miss and the app moves on. Set `BETTER_LYRICS_API_KEY` only if you have one, or point `BETTER_LYRICS_PROXY_URL` at the bundled proxy.
- **[LRCLIB](https://lrclib.net)**, an open, community-run lyrics database. It has exact *line* timing for a huge number of songs. Inside each line, the app estimates when each word is sung from its syllables, punctuation and the song's pace. Every line re-syncs to the real time, so small errors never add up.
- **NetEase Cloud Music**, through its public but undocumented web API. For many songs it has real *per-word* timing, so every word lights exactly when it's sung. You can turn it off in the tray.

If a Musixmatch key is configured, Musixmatch is asked before the cache and the free sources. LRCLIB and NetEase are asked at the same time; real per-word timing wins. Better Lyrics is asked before them, so its syllable timing is used whenever it has the song.

**Lyrics Provider** in the tray pins one source. *Automatic* keeps the chain above, *Local Files Only* never goes online, and *Musixmatch*, *Karalyr*, *Better Lyrics*, *LRCLIB* or *NetEase* use only that source with no fallback. Each network mode has its own cache, so switching providers never shows another source's stored lyrics.

In *Automatic*, your own lyrics come first. Put `.lrc` files in the lyrics folder (tray → **Open Lyrics Folder**, which is `%APPDATA%\theaestheticslyrics\Lyrics`), named `Artist - Title.lrc`. Enhanced LRC with `<mm:ss.xx>` word tags is used exactly as written. If you pin a provider, only that provider is used; choose **Local Files Only** to use just your own files.

Lyrics you've played before load instantly from a local cache. Songs with no synced lyrics show nothing, and the tray tells you so.

## Privacy

- To look lyrics up, the app sends only the song's **title, artist, album and length** to the sources that can answer: `karalyr.com`, `api.betterlyrics.org`, `lrclib.net`, `music.163.com` when precise word timing is on (or NetEase is pinned), and `api.musixmatch.com` only if you added a Musixmatch key. Pinning a provider limits requests to that provider; *Local Files Only* makes no lyrics requests.
- It has no accounts, analytics, telemetry or ads.
- Everything else stays on your PC, in `%APPDATA%\theaestheticslyrics`: settings, the lyrics cache, the log and your own lyrics.

## Troubleshooting

| Problem | Fix |
|---|---|
| The first launch takes a few seconds | Windows scans a newly downloaded app once. The lyrics screen appears as soon as the scan finishes, and later launches are instant. |
| The tray says *Cannot read what is playing* | The app reads Windows' media controls through Windows PowerShell 5.1, which comes with Windows. Check that `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` exists and isn't blocked by a policy. The log (below) has the details. |
| *No synced lyrics for …* | The selected source (or every source, in *Automatic*) has no timed lyrics for that song. Add your own `.lrc` file or choose another provider. |
| **Musixmatch** is greyed out | It needs a Musixmatch API key in `src/main/secrets.ts`. Without one, the other sources still work. |
| Words light up a little early or late | Use tray → **Timing**. Bluetooth audio usually runs 0.25–0.5 s behind. |
| Ctrl+Alt+L does nothing | Another app already uses that shortcut, and the tray then shows no shortcut next to the lyrics-screen item. Use the tray item instead. |
| Touching anything after Ctrl+Alt+L shows the Windows sign-in screen | **Lock Windows When I Come Back** is on. Turn it off in the tray. |
| **Start with Windows** is greyed out | It only works in the released app, not when running from source. If you move the app folder, turn it off and on again. |
| Kodama plays but no lyrics follow | Choose tray → **Players → Kodama**. If it still doesn't follow, open the log: every app id Windows reports is written as a `media session: …` line. If your build of Kodama reports an unexpected id (a fork or a renamed exe), start the app with `THEAESTHETICSLYRICS_KODAMA_ID` set to a comma-separated list of case-insensitive name fragments to trust (e.g. `set THEAESTHETICSLYRICS_KODAMA_ID=music-helper`), and it will follow those sessions too. |
| The words jump back after seeking inside Kodama | Kodama refreshes Windows' media timeline about every 15 seconds and doesn't announce seeks separately, so the lyrics move to the new spot only at its next update. This is Kodama's own behaviour; nothing is wrong with the app. |
| Album art is missing or arrives late | Windows fetches the player's artwork in its own time (YouTube thumbnails for Kodama can take a few seconds). The app keeps checking for about 10 seconds and also lets you pick your own colours instead. |

- **Log:** `%APPDATA%\theaestheticslyrics\logs\theaestheticslyrics.log`
- **Settings:** `%APPDATA%\theaestheticslyrics\settings.json`

## Build from source

You need Windows 10 or 11 and [Node.js](https://nodejs.org) 22.12 or newer (24 LTS recommended).

```powershell
git clone https://github.com/darshanseenivasakumar/theaestheticslyrics.git
cd theaestheticslyrics
npm ci
npm run dev
```

The first run downloads Electron.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload. |
| `npm test` | Runs the unit tests (Vitest). |
| `npm run typecheck` | Runs strict TypeScript for the main process and the pages. |
| `npm run package` | Builds the portable folder and zip into `release\`. |
| `npm run snapshot` | Renders every style offscreen into `snapshots\*.png`. |
| `npm run fake-player` | Starts a silent test "player" that shows up in Windows' media controls. |
| `npm run check:lrclib` | Runs a live check against lrclib.net that prints metadata only. |
| `npm run lyrics:server` | Starts the optional zero-dependency Better Lyrics proxy on `127.0.0.1:8787`. |
| `npm run icons` | Regenerates the Fluent icon subset and the app icons. |

### Optional Better Lyrics proxy

`server/server.mjs` is a single-file, **zero-dependency** Node proxy for
[The Better Lyrics API](https://docs.betterlyrics.org). It exists for two cases: a browser
frontend that needs CORS, and keeping an API key out of the frontend bundle. It is not
required by the Electron app, whose main process calls the API directly without CORS.

```powershell
# No extra packages: Node's built-in http + fetch are all it uses.
npm run lyrics:server

# With a key, or on another port:
$env:BETTER_LYRICS_API_KEY = "your-key"
$env:PORT = "8788"
npm run lyrics:server
```

| Endpoint | Purpose |
|---|---|
| `GET /api/lyrics?song=…&artist=…&album=…&duration=…` | Fetches TTML for one track. Aliases: `s`, `a`, `al`, `d`, `title`, `songName`, `artistName`, `albumName`. |
| `GET /getLyrics?…` | Same handler, for clients that already use the upstream path. |
| `GET /health` | `{ "ok": true, "upstream": "…", "apiKey": false }`. |

```powershell
curl.exe "http://127.0.0.1:8787/api/lyrics?song=E85&artist=Don%20Toliver&album=OCTANE&duration=154"
```

```js
const res = await fetch(
  'http://127.0.0.1:8787/api/lyrics?' +
    new URLSearchParams({ song: 'E85', artist: 'Don Toliver', album: 'OCTANE', duration: '154' })
)
if (!res.ok) throw new Error((await res.json()).message)
const { ttml } = await res.json() // keep the raw string: its spaces carry the syllable timing
```

The proxy never crashes on an upstream problem; it maps them to clean statuses:

| Status | Meaning |
|---|---|
| `200` | `{ ttml, score? }` — lyrics found. |
| `400` | Missing `song`/`artist`, or the API rejected the parameters (`422` upstream). |
| `404` | The song has no lyrics (`404`/negative cache upstream). |
| `429` | Rate limited; `Retry-After` is passed through when present. |
| `502` | A cache miss that needs an API key (`401` upstream), or the upstream failed. |
| `504` | The upstream timed out. |

| Environment variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Keep it local unless you mean to expose it. |
| `PORT` | `8787` | Port. |
| `BETTER_LYRICS_API_KEY` | *(empty)* | Sent upstream as `X-API-Key`; never sent to the browser. |
| `BETTER_LYRICS_API_URL` | `https://api.betterlyrics.org` | Upstream base (self-hosting/testing). |
| `BETTER_LYRICS_TIMEOUT_MS` | `8000` | Upstream request cap. |
| `BETTER_LYRICS_CACHE_TTL_MS` | `600000` | In-memory TTL for successful proxy replies. |

To make the desktop app use the proxy too, start it and set the origin before launching:

```powershell
$env:BETTER_LYRICS_PROXY_URL = "http://127.0.0.1:8787"
npm run dev
```

Without `BETTER_LYRICS_PROXY_URL`, the app calls `api.betterlyrics.org` directly and keeps the
key (`BETTER_LYRICS_API_KEY`, if any) in the main process. The renderer needs **no changes**:
it already renders `TimedLyrics` received over IPC, so Better Lyrics results show up through
the same path as every other provider, and the tray's **Lyrics Provider → Better Lyrics** pin
forces it. The proxy is only the browser-facing door.

### Testing without real music

These switches let you test at any hour without touching your real settings:

| Switch | Effect |
|---|---|
| `TAL_PROFILE=<dir>` | Uses a separate folder for settings, cache and log. |
| `TAL_LYRICS_DIR=<dir>` | Uses a different folder for your own lyrics. |
| `TAL_NO_LOCK=1` | Logs instead of really locking Windows. |
| `--open-lock-after=<ms>` | Opens the lyrics screen. |
| `--return-after=<ms>` | Simulates someone coming back. |
| `--capture-after=<ms> --capture-file=<png>` | Saves what the lyrics screen shows. |
| `--capture-colors=<png>` | Saves the Colors window. |
| `--quit-after=<ms>` | Quits on its own. |

Run `npm run fake-player`, then start the app with the switches above. `tests\fixtures` holds an original test song written for this project.

### Project layout

```
src/main/       tray app: media bridge, lyrics sources and cache, palette, windows, power
src/preload/    the only bridge between the sandboxed pages and the app
src/renderer/   the lyrics screen (four styles) and the Colors window
src/shared/     types and the IPC contract used by both sides
resources/      smtc-bridge.ps1 (Windows media sessions → JSON lines) and the icons
server/         the optional zero-dependency Better Lyrics proxy (server.mjs)
docs/           screenshots, plus the original design spec and plan
```

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and `npm test` before opening a pull request.

**Never commit real song lyrics:** tests, fixtures and screenshots use original text only.

## Credits

- Inspired by [Verci](https://verci.xyz) for macOS.
- Lyrics come from [Karalyr](https://karalyr.com), [Better Lyrics](https://docs.betterlyrics.org), [LRCLIB](https://lrclib.net) and NetEase Cloud Music.
- The font is [Inter](https://rsms.me/inter/) (SIL OFL 1.1).
- Icons are [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) (MIT) and Segoe UI Emoji.
- Built with [Electron](https://www.electronjs.org), [electron-vite](https://electron-vite.org) and TypeScript.
- Third-party licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

theaestheticslyrics is an independent project. It isn't affiliated with or endorsed by Verci, Spotify, Apple, Karalyr, Better Lyrics, NetEase, LRCLIB or Kodama. Lyrics belong to their songwriters and publishers, and no lyrics are stored in this repository.

## License

[MIT](LICENSE) © 2026 darshanseenivasakumar
