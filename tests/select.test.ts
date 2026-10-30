import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawSession } from '../src/main/media/protocol'
import { isAllowedApp, isKodamaApp, selectSession, toTrackInfo } from '../src/main/media/select'

const s = (app: string, status: string, title = 'Song'): RawSession => ({
  app,
  status,
  title,
  artist: 'Artist',
  album: 'Album',
  pos: 0,
  start: 0,
  end: 200,
  updated: 0,
  rate: 1
})

const SPOTIFY = 'Spotify.exe'
const APPLE = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'
const CHROME = 'Chrome'
/** Windows most often reports an unpackaged app by its executable path. */
const KODAMA_PATH = 'C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe'
const KODAMA_ID = 'dev.kodama.music'

describe('isKodamaApp', () => {
  it('recognises the identifiers a Kodama install actually reports', () => {
    expect(isKodamaApp(KODAMA_PATH)).toBe(true)
    expect(isKodamaApp('Kodama.exe')).toBe(true)
    expect(isKodamaApp('kodama')).toBe(true)
    expect(isKodamaApp(KODAMA_ID)).toBe(true)
    expect(isKodamaApp('kodama-server')).toBe(true)
  })

  it('does not match other players', () => {
    expect(isKodamaApp(SPOTIFY)).toBe(false)
    expect(isKodamaApp(APPLE)).toBe(false)
    expect(isKodamaApp(CHROME)).toBe(false)
    expect(isKodamaApp('')).toBe(false)
  })

  it('accepts extra patterns from THEAESTHETICSLYRICS_KODAMA_ID', () => {
    vi.stubEnv('THEAESTHETICSLYRICS_KODAMA_ID', 'yt-music-helper|MyKodamaFork')
    expect(isKodamaApp('YT-Music-Helper.exe')).toBe(true)
    expect(isKodamaApp('mykodamafork')).toBe(true)
    expect(isKodamaApp(KODAMA_PATH)).toBe(true)
    expect(isKodamaApp(CHROME)).toBe(false)
  })

  it('ignores a broken override pattern instead of breaking selection', () => {
    vi.stubEnv('THEAESTHETICSLYRICS_KODAMA_ID', '[unclosed,normal-name')
    expect(isKodamaApp(KODAMA_PATH)).toBe(true)
    expect(isKodamaApp('normal-name')).toBe(true)
  })
})

describe('isAllowedApp', () => {
  it('allows Spotify (desktop and Store) and Apple Music by default', () => {
    expect(isAllowedApp(SPOTIFY, 'default')).toBe(true)
    expect(isAllowedApp('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'default')).toBe(true)
    expect(isAllowedApp(APPLE, 'default')).toBe(true)
    expect(isAllowedApp(CHROME, 'default')).toBe(false)
    expect(isAllowedApp(CHROME, 'all')).toBe(true)
  })

  it('does not follow Kodama unless it is chosen', () => {
    expect(isAllowedApp(KODAMA_PATH, 'default')).toBe(false)
    expect(isAllowedApp(KODAMA_PATH, 'kodama')).toBe(true)
  })

  it('follows only Kodama in Kodama mode', () => {
    expect(isAllowedApp(CHROME, 'kodama')).toBe(false)
    expect(isAllowedApp(SPOTIFY, 'kodama')).toBe(false)
    expect(isAllowedApp('C:\\Apps\\KODAMA\\kodama.exe', 'kodama')).toBe(true)
  })
})

describe('selectSession', () => {
  it('follows the current session when it is allowed', () => {
    const spotify = s(SPOTIFY, 'Playing')
    expect(selectSession({ current: SPOTIFY, sessions: [s(APPLE, 'Paused'), spotify] }, null, 'default')).toBe(spotify)
  })

  it('skips a disallowed current session in favour of a playing allowed one', () => {
    const spotify = s(SPOTIFY, 'Playing')
    expect(selectSession({ current: CHROME, sessions: [s(CHROME, 'Playing'), spotify] }, null, 'default')).toBe(spotify)
  })

  it('follows other players when allowed', () => {
    const chrome = s(CHROME, 'Playing')
    expect(selectSession({ current: CHROME, sessions: [chrome] }, null, 'all')).toBe(chrome)
  })

  it('prefers anything playing over a paused current session', () => {
    const apple = s(APPLE, 'Playing')
    expect(selectSession({ current: SPOTIFY, sessions: [s(SPOTIFY, 'Paused'), apple] }, null, 'default')).toBe(apple)
  })

  it('keeps the previously followed track while everything is paused', () => {
    const spotify = s(SPOTIFY, 'Paused', 'Old')
    const prevKey = `${SPOTIFY}|Old|Artist|Album`
    expect(selectSession({ current: APPLE, sessions: [spotify, s(APPLE, 'Paused')] }, prevKey, 'default')).toBe(spotify)
  })

  it('returns null when nothing allowed is present', () => {
    expect(selectSession({ current: CHROME, sessions: [s(CHROME, 'Playing')] }, null, 'default')).toBeNull()
    expect(selectSession({ current: null, sessions: [] }, null, 'all')).toBeNull()
  })

  describe('Kodama mode', () => {
    const kodama = (status: string, title = 'Song'): RawSession => s(KODAMA_PATH, status, title)

    it('follows a playing Kodama session and ignores background browsers', () => {
      const session = kodama('Playing', 'Now Playing')
      expect(selectSession({ current: CHROME, sessions: [s(CHROME, 'Playing'), session] }, null, 'kodama')).toBe(session)
    })

    it('follows a paused Kodama session while a browser plays', () => {
      const session = kodama('Paused')
      expect(selectSession({ current: CHROME, sessions: [session, s(CHROME, 'Playing')] }, null, 'kodama')).toBe(session)
    })

    it('pins the Kodama track that was being followed before a background pause', () => {
      const paused = kodama('Paused', 'Current Song')
      const other = kodama('Paused', 'Older Song')
      const prevKey = `${KODAMA_PATH}|Older Song|Artist|Album`
      expect(selectSession({ current: KODAMA_PATH, sessions: [paused, other] }, prevKey, 'kodama')).toBe(other)
    })

    it('never leaves Kodama mode for unrelated sessions', () => {
      expect(selectSession({ current: CHROME, sessions: [s(CHROME, 'Paused'), s(SPOTIFY, 'Playing')] }, null, 'kodama')).toBeNull()
    })

    it('follows Kodama starting after the lyrics application', () => {
      const session = kodama('Playing')
      expect(selectSession({ current: null, sessions: [session] }, null, 'kodama')).toBe(session)
    })

    it('keeps following Kodama after it closes and reopens with the same track', () => {
      const session = kodama('Playing')
      const prevKey = `${KODAMA_PATH}|Song|Artist|Album`
      expect(selectSession({ current: KODAMA_PATH, sessions: [session] }, prevKey, 'kodama')).toBe(session)
    })
  })

  describe('All Media Apps mode', () => {
    it('keeps supporting Spotify and Apple Music and lets Kodama join', () => {
      const apple = s(APPLE, 'Playing')
      expect(selectSession({ current: APPLE, sessions: [apple] }, null, 'all')).toBe(apple)
      expect(selectSession({ current: KODAMA_PATH, sessions: [s(APPLE, 'Paused'), s(KODAMA_PATH, 'Playing')] }, null, 'all')).toMatchObject({ app: KODAMA_PATH })
    })

    it('prefers Windows\' current session over the previously followed track', () => {
      const chrome = s(CHROME, 'Playing')
      const kodama = s(KODAMA_PATH, 'Playing')
      const prevKey = `${KODAMA_PATH}|Song|Artist|Album`
      expect(selectSession({ current: CHROME, sessions: [kodama, chrome] }, prevKey, 'all')).toBe(chrome)
    })
  })
})

describe('toTrackInfo', () => {
  it('splits Apple Music "Artist — Album" and computes the duration', () => {
    const info = toTrackInfo({ ...s(APPLE, 'Playing'), artist: 'Some Artist — Some Album', album: '', start: 0, end: 215.4 })
    expect(info).toMatchObject({ app: APPLE, artist: 'Some Artist', album: 'Some Album', durationMs: 215_400 })
  })

  it('leaves other players alone and trims whitespace', () => {
    const info = toTrackInfo({ ...s(SPOTIFY, 'Playing', '  Song  '), artist: 'A — B', album: '' })
    expect(info).toMatchObject({ title: 'Song', artist: 'A — B', album: '' })
    expect(info.key).toBe(`${SPOTIFY}|  Song  |A — B|`)
  })

  it('reports zero duration when the player gives none', () => {
    expect(toTrackInfo({ ...s(SPOTIFY, 'Playing'), end: 0 }).durationMs).toBe(0)
  })

  it('keeps Kodama metadata as published (joined artists, possible missing album and duration)', () => {
    const info = toTrackInfo({
      ...s(KODAMA_PATH, 'Playing', ' Paper Lanterns '),
      artist: 'One Artist, Another Artist',
      album: '',
      start: 0,
      end: 0
    })
    expect(info).toMatchObject({
      app: KODAMA_PATH,
      title: 'Paper Lanterns',
      artist: 'One Artist, Another Artist',
      album: '',
      durationMs: 0
    })
    expect(info.key).toBe(`${KODAMA_PATH}| Paper Lanterns |One Artist, Another Artist|`)
  })

  it('keeps using the raw key when Kodama fills the album in later', () => {
    // The raw key must track the exact published fields, so late-arriving album names
    // do not silently keep an older track followed.
    expect(toTrackInfo({ ...s(KODAMA_PATH, 'Playing'), album: 'Fixtures' }).key).toBe(`${KODAMA_PATH}|Song|Artist|Fixtures`)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})
