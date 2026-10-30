import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_COLORS, HEX_COLOR } from '@shared/palette-defaults'
import { STYLE_IDS, type ColorRole, type ShowOn, type StyleId } from '@shared/types'
import { makeDirSync } from './dirs'

export type IdleMinutes = 0 | 1 | 2 | 5

/** Which Windows media sessions to follow: the defaults, Kodama only, or everything. */
export type PlayerSource = 'default' | 'kodama' | 'all'

export interface Settings {
  version: 1
  style: StyleId
  showOn: ShowOn
  /** Electron display id; `null` follows the primary display. */
  displayId: number | null
  autoSync: boolean
  colors: Record<ColorRole, string>
  /** Positive shows words later (compensates Bluetooth / output latency). */
  offsetMs: number
  /** Minutes of no input before the lyrics screen opens during playback; 0 = off. */
  idleMinutes: IdleMinutes
  /** Which player to follow (Spotify and Apple Music, Kodama, or every media app). */
  source: PlayerSource
  /** Derived from `source` for older versions that only knew "All Media Apps". */
  allPlayers: boolean
  launchAtLogin: boolean
  /** The first-run "theaestheticslyrics is running" notice has been shown. */
  welcomed: boolean
  /**
   * Ctrl+Alt+L locks Windows when you come back (any input closes the lyrics screen).
   * Off: the lyrics screen stays up until Esc (or Ctrl+Alt+L again) and nothing is locked.
   */
  lockOnReturn: boolean
  /** Also ask NetEase (unofficial) for real per-word timing; LRCLIB stays the fallback. */
  wordLevel: boolean
}

export const IDLE_CHOICES: readonly IdleMinutes[] = [0, 1, 2, 5]
export const OFFSET_LIMIT_MS = 1000
export const PLAYER_SOURCES: readonly PlayerSource[] = ['default', 'kodama', 'all']

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  style: 'ship',
  showOn: 'lock',
  displayId: null,
  autoSync: false,
  colors: Object.freeze({ ...DEFAULT_COLORS }),
  offsetMs: 0,
  idleMinutes: 2,
  source: 'default',
  allPlayers: false,
  launchAtLogin: false,
  welcomed: false,
  lockOnReturn: false,
  wordLevel: true
}) as Readonly<Settings>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const pickColor = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback

/**
 * Validates every field independently, so one bad value never resets the rest.
 * The player choice reads the new `source` field; a settings file from an older
 * version only has the `allPlayers` flag, which becomes the "all" source.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {}
  const colors = isRecord(r.colors) ? r.colors : {}
  const offset = typeof r.offsetMs === 'number' && Number.isFinite(r.offsetMs) ? Math.round(r.offsetMs) : 0
  const source: PlayerSource = PLAYER_SOURCES.includes(r.source as PlayerSource)
    ? (r.source as PlayerSource)
    : r.allPlayers === true
      ? 'all'
      : DEFAULT_SETTINGS.source

  return {
    version: 1,
    style: STYLE_IDS.includes(r.style as StyleId) ? (r.style as StyleId) : DEFAULT_SETTINGS.style,
    showOn: r.showOn === 'always' || r.showOn === 'lock' ? r.showOn : DEFAULT_SETTINGS.showOn,
    displayId: typeof r.displayId === 'number' && Number.isInteger(r.displayId) ? r.displayId : null,
    autoSync: typeof r.autoSync === 'boolean' ? r.autoSync : DEFAULT_SETTINGS.autoSync,
    colors: {
      lyric: pickColor(colors.lyric, DEFAULT_COLORS.lyric),
      highlight: pickColor(colors.highlight, DEFAULT_COLORS.highlight),
      secondary: pickColor(colors.secondary, DEFAULT_COLORS.secondary)
    },
    offsetMs: Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, offset)),
    idleMinutes: IDLE_CHOICES.includes(r.idleMinutes as IdleMinutes)
      ? (r.idleMinutes as IdleMinutes)
      : DEFAULT_SETTINGS.idleMinutes,
    source,
    allPlayers: source === 'all',
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    welcomed: typeof r.welcomed === 'boolean' ? r.welcomed : DEFAULT_SETTINGS.welcomed,
    lockOnReturn: typeof r.lockOnReturn === 'boolean' ? r.lockOnReturn : DEFAULT_SETTINGS.lockOnReturn,
    wordLevel: typeof r.wordLevel === 'boolean' ? r.wordLevel : DEFAULT_SETTINGS.wordLevel
  }
}

const freeze = (s: Settings): Settings => Object.freeze({ ...s, colors: Object.freeze({ ...s.colors }) }) as Settings

export class SettingsStore {
  private current: Settings
  private readonly listeners = new Set<(s: Settings) => void>()

  constructor(private readonly file: string) {
    this.current = freeze(this.load())
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = freeze(
      sanitizeSettings({ ...this.current, ...patch, colors: { ...this.current.colors, ...patch.colors } })
    )
    this.persist()
    for (const listener of this.listeners) listener(this.current)
    return this.current
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private load(): Settings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return sanitizeSettings(undefined)
    }
  }

  private persist(): void {
    const json = JSON.stringify(this.current, null, 2)
    makeDirSync(dirname(this.file))
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, json, 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // A virus scanner can briefly hold the target open; a direct write is the fallback.
      writeFileSync(this.file, json, 'utf8')
    }
  }
}
