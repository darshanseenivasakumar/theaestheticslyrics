import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LyricsCache, cacheKey } from '../src/main/lyrics/cache'
import { LocalLyrics } from '../src/main/lyrics/local'
import type { FindResult, LrclibClient } from '../src/main/lyrics/lrclib'
import type { NeteaseClient, NeteaseResult } from '../src/main/lyrics/netease'
import type { LrclibRecord, TrackQuery } from '../src/main/lyrics/match'
import { LyricsService, recordToTimedLyrics } from '../src/main/lyrics/service'

const fixtures = join(__dirname, 'fixtures')
const lrc = readFileSync(join(fixtures, 'original-song.lrc'), 'utf8')
const yamlDoc = readFileSync(join(fixtures, 'original-song.lyricsfile.yaml'), 'utf8')
const query: TrackQuery = { title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationMs: 32_000 }

const record = (over: Partial<LrclibRecord> = {}): LrclibRecord => ({
  id: 1,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: 'x',
  syncedLyrics: lrc,
  lyricsfile: null,
  ...over
})

// Original test text written for theaestheticslyrics (not a real song), in NetEase's word-timed format.
const YRC = [
  '[1000,3200](1000,400,0)Paper (1400,600,0)lanterns (2000,500,0)drifting',
  '[4200,1500](4200,300,0)Every (4500,300,0)window (4800,500,0)keeps',
  '[8000,1200](8000,600,0)Hold (8600,600,0)the (9200,600,0)light'
].join('\n')

function setup(find: () => Promise<FindResult>, word?: { find: () => Promise<NeteaseResult>; enabled?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'tal-service-'))
  const local = new LocalLyrics(join(base, 'local'))
  const cache = new LyricsCache(join(base, 'cache'))
  const client = { find: vi.fn(find) } as unknown as LrclibClient & { find: ReturnType<typeof vi.fn> }
  const wordClient = { find: vi.fn(word?.find ?? (async (): Promise<NeteaseResult> => ({ status: 'not-found' }))) }
  const state = { enabled: word?.enabled ?? true }
  const service = new LyricsService({
    local,
    cache,
    client,
    log: () => {},
    wordLevel: word ? { client: wordClient as unknown as NeteaseClient, enabled: () => state.enabled } : undefined
  })
  return { base, local, cache, client, wordClient, state, service }
}

const neteaseFound = async (): Promise<NeteaseResult> => ({
  status: 'found',
  yrc: YRC,
  song: { id: 1, title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationSec: 32 }
})

describe('recordToTimedLyrics', () => {
  it('prefers the lyricsfile, then synced lyrics', () => {
    const fromYaml = recordToTimedLyrics(record({ lyricsfile: yamlDoc }), 32_000)
    expect(fromYaml?.lines).toHaveLength(3)
    const fromLrc = recordToTimedLyrics(record(), 32_000)
    expect(fromLrc?.lines).toHaveLength(8)
  })

  it('falls back to synced lyrics when the lyricsfile is broken', () => {
    expect(recordToTimedLyrics(record({ lyricsfile: 'lines: [' }), 32_000)?.lines).toHaveLength(8)
  })

  it('returns null without timed text', () => {
    expect(recordToTimedLyrics(record({ syncedLyrics: null }), 32_000)).toBeNull()
  })
})

describe('LyricsService.get', () => {
  it('uses a local .lrc file before the network', async () => {
    const s = setup(async () => ({ status: 'not-found' }))
    await s.local.ensureDir()
    copyFileSync(join(fixtures, 'original-song.lrc'), join(s.base, 'local', 'Lantern Test Band - Paper Lanterns.lrc'))
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'local' })
    expect(s.client.find).not.toHaveBeenCalled()
  })

  it('fetches, caches and then serves from the cache', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }))
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'cache' })
    expect(s.client.find).toHaveBeenCalledTimes(1)
  })

  it('logs the sanitized title and artist before the external fetch', async () => {
    // The players' noise this lookup feeds on: the same track arrives as
    // "Paper Lanterns (Remastered 2011) [Live] feat. Extra Voice" from the media session.
    const noisy: TrackQuery = {
      title: 'Paper Lanterns (Remastered 2011) [Live] feat. Extra Voice',
      artist: 'Lantern Test Band feat. Other Voice',
      album: 'Fixtures',
      durationMs: 32_000
    }
    const s = setup(async () => ({ status: 'not-found' }))
    const events: string[] = []
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => events.push(line))
    s.client.find.mockImplementation(async () => {
      events.push('fetch')
      return { status: 'not-found' }
    })
    try {
      expect(await s.service.get(noisy)).toMatchObject({ status: 'not-found' })
    } finally {
      consoleSpy.mockRestore()
    }
    expect(events).toEqual(['lyrics: requesting title "Paper Lanterns" artist "Lantern Test Band"', 'fetch'])
  })

  it('remembers not-found without asking again', async () => {
    const s = setup(async () => ({ status: 'not-found' }))
    expect((await s.service.get(query)).status).toBe('not-found')
    expect((await s.service.get(query)).status).toBe('not-found')
    expect(s.client.find).toHaveBeenCalledTimes(1)
  })

  it('reports instrumental tracks', async () => {
    const s = setup(async () => ({ status: 'found', record: record({ instrumental: true, syncedLyrics: null }) }))
    expect(await s.service.get(query)).toMatchObject({ status: 'instrumental', lyrics: null })
  })

  it('does not cache errors', async () => {
    const s = setup(async () => ({ status: 'error', message: 'busy' }))
    expect((await s.service.get(query)).status).toBe('error')
    expect(await s.cache.get(cacheKey(query))).toBeNull()
    await s.service.get(query)
    expect(s.client.find).toHaveBeenCalledTimes(2)
  })

  it('uses real word timing from NetEase when it has the song', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }), { find: neteaseFound })
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'netease' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(result.lyrics?.lines[0]?.words[1]).toEqual({ text: 'lanterns', start: 1400, end: 2000 })
  })

  it('falls back to LRCLIB when NetEase has no word timing', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }), { find: async () => ({ status: 'not-found' }) })
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(result.lyrics?.wordTiming).toBe('estimated')
  })

  it('falls back to LRCLIB when NetEase fails, and asks NetEase again next time', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }), {
      find: async () => ({ status: 'error', message: 'down' })
    })
    expect((await s.service.get(query)).source).toBe('lrclib')
    s.wordClient.find.mockImplementation(neteaseFound)
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'netease' })
    expect(s.client.find).toHaveBeenCalledTimes(1)
  })

  it('upgrades a song cached before word timing existed, only once', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }), { find: neteaseFound })
    await s.cache.set(cacheKey(query), { status: 'found', record: record(), fetchedAt: Date.now() })
    expect(await s.service.get(query)).toMatchObject({ source: 'netease' })
    expect(await s.service.get(query)).toMatchObject({ source: 'cache' })
    expect((await s.service.get(query)).lyrics?.wordTiming).toBe('native')
    expect(s.wordClient.find).toHaveBeenCalledTimes(1)
    expect(s.client.find).not.toHaveBeenCalled()
  })

  it('finds lyrics only NetEase has', async () => {
    const s = setup(async () => ({ status: 'not-found' }), { find: neteaseFound })
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'netease' })
  })

  it('never contacts NetEase or uses its cached timing when turned off', async () => {
    const s = setup(async () => ({ status: 'found', record: record() }), { find: neteaseFound, enabled: false })
    expect((await s.service.get(query)).source).toBe('lrclib')
    expect(s.wordClient.find).not.toHaveBeenCalled()
    s.state.enabled = true
    expect(await s.service.get(query)).toMatchObject({ source: 'netease' })
    s.state.enabled = false
    const off = await s.service.get(query)
    expect(off.lyrics?.wordTiming).toBe('estimated')
  })

  it('treats a found record without usable timing as not-found', async () => {
    const s = setup(async () => ({ status: 'found', record: record({ syncedLyrics: '[ar:only metadata]' }) }))
    expect((await s.service.get(query)).status).toBe('not-found')
  })
})
