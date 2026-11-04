import type { TrackInfo } from '@shared/types'
import { splitAppleMusicArtist } from '../lyrics/normalize'
import type { PlayerSource } from '../settings'
import { rawKey, type RawSession } from './protocol'

const DEFAULT_APPS = [/spotify/i, /AppleInc\.AppleMusic/i, /itunes/i]
const APPLE_MUSIC = /AppleInc\.AppleMusic/i

/**
 * Kodama (https://kodama.kiyoshi.dev) is an unpackaged Tauri app that publishes its
 * YouTube Music playback through the same SMTC timeline as every other player. Windows
 * reports the session under the app's own identifier — most often the executable path
 * (`…\kodama.exe`) or its Tauri id (`dev.kodama.music`) — so recognition is a
 * case-insensitive "kodama" match rather than one literal id.
 */
const KODAMA_APP = /kodama/i
/** Extra trusted patterns, for users whose Kodama build reports an unexpected id. */
const KODAMA_OVERRIDE_ENV = 'THEAESTHETICSLYRICS_KODAMA_ID'

function kodamaPatterns(): RegExp[] {
  const patterns = [KODAMA_APP]
  const override = process.env[KODAMA_OVERRIDE_ENV]
  if (override) {
    for (const part of override.split(/[,;]/)) {
      const trimmed = part.trim()
      if (!trimmed) continue
      try {
        patterns.push(new RegExp(trimmed, 'i'))
      } catch {
        // An unparseable pattern must never break selection; skip it.
      }
    }
  }
  return patterns
}

export function isKodamaApp(app: string): boolean {
  return kodamaPatterns().some((re) => re.test(app))
}

export function isAllowedApp(app: string, source: PlayerSource): boolean {
  switch (source) {
    case 'kodama':
      return isKodamaApp(app)
    case 'all':
      return true
    default:
      return DEFAULT_APPS.some((re) => re.test(app))
  }
}

/**
 * Chooses the session to follow. Something playing beats something paused; among
 * those, Windows' own "current" session wins, then the track we were already following.
 */
export function selectSession(
  snapshot: { current: string | null; sessions: RawSession[] },
  prevKey: string | null,
  source: PlayerSource
): RawSession | null {
  const allowed = snapshot.sessions.filter((s) => isAllowedApp(s.app, source))
  if (!allowed.length) return null

  const isCurrent = (s: RawSession): boolean => snapshot.current !== null && s.app === snapshot.current
  const isPrev = (s: RawSession): boolean => prevKey !== null && rawKey(s) === prevKey

  const playing = allowed.filter((s) => s.status === 'Playing')
  if (playing.length) return playing.find(isCurrent) ?? playing.find(isPrev) ?? playing[0]!
  return allowed.find(isPrev) ?? allowed.find(isCurrent) ?? allowed[0]!
}

export function toTrackInfo(s: RawSession): TrackInfo {
  const fields = APPLE_MUSIC.test(s.app) ? splitAppleMusicArtist(s.artist, s.album) : { artist: s.artist, album: s.album }
  return {
    key: rawKey(s),
    app: s.app,
    title: s.title.trim(),
    artist: fields.artist.trim(),
    album: fields.album.trim(),
    durationMs: Math.max(0, Math.round((s.end - s.start) * 1000))
  }
}
