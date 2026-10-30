import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PlaybackAnchor, TrackInfo } from '@shared/types'
import { parseBridgeLine, rawKey, type BridgeMessage, type RawSession } from './protocol'
import { isKodamaApp, selectSession, toTrackInfo } from './select'
import type { PlayerSource } from '../settings'
import { AnchorTracker, positionAt } from './timeline'

export interface ArtworkEvent {
  key: string
  mime: string
  data: Buffer
}

export interface HealthEvent {
  ok: boolean
  message?: string
}

interface WatcherEvents {
  track: [TrackInfo | null]
  anchor: [PlaybackAnchor]
  artwork: [ArtworkEvent]
  health: [HealthEvent]
}

export interface MediaWatcherOptions {
  scriptPath: string
  log: (message: string) => void
  source: () => PlayerSource
  powershellPath?: string
}

const MAX_RESTART_DELAY_MS = 30_000
const ART_CACHE_SIZE = 12
/** Anchors closer than this to the previous prediction are not worth re-sending. */
const ANCHOR_EPSILON_MS = 40
/** Playing-position jumps bigger than this are logged as seeks/corrections (diagnostics only). */
const SEEK_LOG_MS = 1500

const defaultPowershell = (): string =>
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * Supervises `smtc-bridge.ps1` (Windows PowerShell 5.1) and turns its snapshots into
 * `track` / `anchor` / `artwork` events for the one session theaestheticslyrics follows.
 */
export class MediaWatcher extends EventEmitter<WatcherEvents> {
  private child: ChildProcess | null = null
  private stopped = true
  private restartTimer: NodeJS.Timeout | null = null
  private restartDelay = 1000
  private failures = 0
  private followedKey: string | null = null
  private lastAnchor: PlaybackAnchor | null = null
  private lastSnapshot: Extract<BridgeMessage, { type: 'sessions' }> | null = null
  private lastNoMatchApps = ''
  private readonly tracker = new AnchorTracker()
  private readonly art = new Map<string, { mime: string; data: Buffer }>()
  private readonly errorTimes = new Map<string, number>()
  /** Every source id seen once; each new one is logged, so detection problems can be diagnosed. */
  private readonly announcedApps = new Set<string>()
  private track: TrackInfo | null = null

  constructor(private readonly opts: MediaWatcherOptions) {
    super()
  }

  get currentTrack(): TrackInfo | null {
    return this.track
  }

  get currentAnchor(): PlaybackAnchor | null {
    return this.lastAnchor
  }

  artworkFor(key: string): ArtworkEvent | null {
    const art = this.art.get(key)
    return art ? { key, ...art } : null
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.spawnBridge()
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.child?.kill()
    this.child = null
  }

  /** Re-evaluates which session to follow (e.g. after the player setting changes). */
  refreshPolicy(): void {
    if (this.lastSnapshot) this.apply(this.lastSnapshot)
  }

  private spawnBridge(): void {
    const exe = this.opts.powershellPath ?? defaultPowershell()
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      // MTA: the bridge's album-art helper performs COM casts that hang on an
      // STA thread (PowerShell 5.1 defaults to STA without this flag).
      '-MTA',
      '-File',
      this.opts.scriptPath,
      '-ParentPid',
      String(process.pid)
    ]
    let child: ChildProcess
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      this.opts.log(`bridge: spawn failed (${String(err)})`)
      this.scheduleRestart()
      return
    }
    this.child = child

    createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) =>
      this.handleLine(line)
    )
    createInterface({ input: child.stderr!, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
      if (line.trim()) this.logThrottled(`bridge stderr: ${line.trim()}`)
    })
    child.once('error', (err) => this.opts.log(`bridge: process error (${err.message})`))
    child.once('exit', (code) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.opts.log(`bridge: exited with code ${code ?? 'null'}`)
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped) return
    this.failures++
    if (this.failures >= 2) {
      this.emit('health', { ok: false, message: 'Cannot read Windows media sessions (retrying)' })
    }
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.spawnBridge()
    }, delay)
  }

  private handleLine(line: string): void {
    // Temporary debug gate (THEAESTHETICSLYRICS_BRIDGE_DEBUG=1): prints every raw
    // bridge line so a payload from an unknown publisher can be inspected as-is.
    if (process.env.THEAESTHETICSLYRICS_BRIDGE_DEBUG) this.opts.log(`bridge raw: ${line}`)
    const msg = parseBridgeLine(line)
    if (!msg) return
    switch (msg.type) {
      case 'hello':
        this.failures = 0
        this.restartDelay = 1000
        this.opts.log(`bridge: hello (PowerShell ${msg.ps})`)
        this.emit('health', { ok: true })
        break
      case 'sessions':
        this.lastSnapshot = msg
        this.apply(msg)
        break
      case 'art':
        this.storeArt(msg.key, msg.mime, Buffer.from(msg.data, 'base64'))
        break
      case 'error':
        this.logThrottled(`bridge: ${msg.message}`)
        break
    }
  }

  private storeArt(key: string, mime: string, data: Buffer): void {
    this.art.delete(key)
    this.art.set(key, { mime, data })
    while (this.art.size > ART_CACHE_SIZE) this.art.delete(this.art.keys().next().value!)
    this.opts.log(`media: album art ${data.length} bytes (${mime || 'unknown mime'}) for "${key}"`)
    if (key === this.followedKey) this.emit('artwork', { key, mime, data })
  }

  private apply(snapshot: Extract<BridgeMessage, { type: 'sessions' }>): void {
    this.announce(snapshot.sessions)
    const source = this.opts.source()
    const session = selectSession(snapshot, this.followedKey, source)
    const key = session ? rawKey(session) : null

    if (!session && snapshot.sessions.length) {
      // Nothing followed while other apps are playing: the log shows which app ids
      // Windows reported, so a missed player can be fixed (see THEAESTHETICSLYRICS_KODAMA_ID).
      const apps = snapshot.sessions.map((s) => s.app).join(', ')
      if (apps !== this.lastNoMatchApps) {
        this.lastNoMatchApps = apps
        this.logThrottled(
          source === 'all' ? `select: sessions reported but none followed (apps: ${apps})` : `select: no ${source === 'kodama' ? 'Kodama' : 'supported'} session found (apps: ${apps})`
        )
      }
    } else {
      this.lastNoMatchApps = ''
    }

    if (key !== this.followedKey) {
      this.followedKey = key
      this.lastAnchor = null
      this.track = session ? toTrackInfo(session) : null
      this.emit('track', this.track)
      const art = key ? this.artworkFor(key) : null
      if (art) this.emit('artwork', art)
    }
    if (!session) return

    const anchor = this.tracker.update(session, snapshot.t)
    if (this.anchorChanged(anchor, snapshot.t)) {
      this.lastAnchor = anchor
      this.emit('anchor', anchor)
    }
  }

  /** Logs each distinct source id once, plus an explicit line when Kodama appears. */
  private announce(sessions: RawSession[]): void {
    for (const s of sessions) {
      if (this.announcedApps.has(s.app)) continue
      this.announcedApps.add(s.app)
      this.opts.log(`media session: ${s.app} (${s.status}, "${s.title}")`)
      if (isKodamaApp(s.app)) this.opts.log(`kodama: media session detected (${s.app})`)
    }
  }

  private anchorChanged(next: PlaybackAnchor, at: number): boolean {
    const prev = this.lastAnchor
    if (!prev) return true
    if (prev.trackKey !== next.trackKey || prev.playing !== next.playing || prev.rate !== next.rate) return true
    const drift = Math.abs(positionAt(prev, at) - positionAt(next, at))
    if (prev.playing && drift > SEEK_LOG_MS) {
      // A seek inside the other app corrects the extrapolation; log the magnitude once per second.
      this.logThrottled(`smtc: position jumped ~${Math.round(drift / 1000)} s (seek or stream correction)`)
    }
    return drift > ANCHOR_EPSILON_MS
  }

  private logThrottled(message: string): void {
    const now = Date.now()
    if (now - (this.errorTimes.get(message) ?? 0) < 30_000) return
    this.errorTimes.set(message, now)
    this.opts.log(message)
  }
}
