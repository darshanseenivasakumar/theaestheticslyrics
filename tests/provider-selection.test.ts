import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LyricsCache, cacheKey, providerCacheKey } from '../src/main/lyrics/cache'
import type { KaraLyrClient, KaraLyrPayload, KaraLyrResult } from '../src/main/lyrics/karalyr'
import { LocalLyrics } from '../src/main/lyrics/local'
import type { FindResult, LrclibClient } from '../src/main/lyrics/lrclib'
import type { LrclibRecord, TrackQuery } from '../src/main/lyrics/match'
import type { MusixmatchProvider, MusixmatchResult } from '../src/main/lyrics/musixmatch'
import type { NeteaseClient, NeteaseResult } from '../src/main/lyrics/netease'
import { LyricsService } from '../src/main/lyrics/service'
import type { LyricsProvider } from '../src/main/settings'

const fixtures = join(__dirname, 'fixtures')
const lrc = readFileSync(join(fixtures, 'original-song.lrc'), 'utf8')
const query: TrackQuery = { title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationMs: 32_000 }

const record = (over: Partial<LrclibRecord> = {}): LrclibRecord => ({
  id: 1,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: 'Paper lanterns drifting',
  syncedLyrics: lrc,
  lyricsfile: null,
  ...over
})

const YRC = [
  '[1000,3200](1000,400,0)Paper (1400,600,0)lanterns (2000,500,0)drifting',
  '[4200,1500](4200,300,0)Every (4500,300,0)window (4800,500,0)keeps',
  '[8000,1200](8000,600,0)Hold (8600,600,0)the (9200,600,0)light'
].join('\n')

const neteaseFound = async (): Promise<NeteaseResult> => ({
  status: 'found',
  yrc: YRC,
  song: { id: 1, title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationSec: 32 }
})

const KARALYR_PAYLOAD: KaraLyrPayload = {
  format_version: 1,
  lines: [
    {
      start_ms: 500,
      end_ms: 4200,
      singer: null,
      text: 'Paper lanterns drifting',
      words: [
        { text: 'Paper', start_ms: 500, end_ms: 1300 },
        { text: 'lanterns', start_ms: 1300, end_ms: 2400 },
        { text: 'drifting', start_ms: 2400, end_ms: 4200 }
      ]
    },
    {
      start_ms: 5000,
      end_ms: 9000,
      singer: null,
      text: 'Low over the rooftops',
      words: [
        { text: 'Low', start_ms: 5000, end_ms: 5600 },
        { text: 'over', start_ms: 5600, end_ms: 6200 },
        { text: 'the', start_ms: 6200, end_ms: 6500 },
        { text: 'rooftops', start_ms: 6500, end_ms: 9000 }
      ]
    }
  ],
  meta: { language: 'en', has_word_timing: true, countdown_lines: [] }
}

const karalyrFound = async (): Promise<KaraLyrResult> => ({
  status: 'found',
  track: {
    id: 101,
    trackName: 'Paper Lanterns',
    artistName: 'Lantern Test Band',
    albumName: 'Fixtures',
    duration: 32,
    instrumental: false,
    plainLyrics: 'Paper lanterns drifting',
    syncedLyrics: '[00:00.50]Paper lanterns drifting\n[00:05.00]Low over the rooftops'
  },
  payload: KARALYR_PAYLOAD
})

const MX_TRACK = { id: 11, title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationSec: 32 }
const MX_BODY = [
  {
    ts: 1,
    te: 4,
    l: 'Paper lanterns drifting',
    w: [
      { w: 'Paper', ts: 1, te: 2 },
      { w: 'lanterns', ts: 2, te: 3 },
      { w: 'drifting', ts: 3, te: 4 }
    ]
  }
]

const musixmatchFound = async (): Promise<MusixmatchResult> => ({
  status: 'found',
  richsyncBody: MX_BODY,
  track: MX_TRACK
})

interface SetupOptions {
  provider: LyricsProvider
  wordEnabled?: boolean
  lrclib?: () => Promise<FindResult>
  karalyr?: () => Promise<KaraLyrResult>
  musixmatch?: () => Promise<MusixmatchResult>
  netease?: () => Promise<NeteaseResult>
}

function setup(opts: SetupOptions) {
  const base = mkdtempSync(join(tmpdir(), 'tal-provider-'))
  const local = new LocalLyrics(join(base, 'local'))
  const cache = new LyricsCache(join(base, 'cache'))
  const lrclibFind = vi.fn(opts.lrclib ?? (async (): Promise<FindResult> => ({ status: 'not-found' })))
  const karalyrFind = vi.fn(opts.karalyr ?? (async (): Promise<KaraLyrResult> => ({ status: 'not-found' })))
  const mxFind = vi.fn(opts.musixmatch ?? (async (): Promise<MusixmatchResult> => ({ status: 'not-found' })))
  const neFind = vi.fn(opts.netease ?? (async (): Promise<NeteaseResult> => ({ status: 'not-found' })))
  const state = { provider: opts.provider, wordEnabled: opts.wordEnabled ?? true }

  const service = new LyricsService({
    local,
    cache,
    client: { find: lrclibFind } as unknown as LrclibClient,
    log: () => {},
    primary: { client: { find: mxFind } as unknown as Pick<MusixmatchProvider, 'find'> },
    karalyr: { client: { find: karalyrFind } as unknown as Pick<KaraLyrClient, 'find'> },
    wordLevel: { client: { find: neFind } as unknown as Pick<NeteaseClient, 'find'>, enabled: () => state.wordEnabled },
    provider: () => state.provider
  })

  return { base, local, cache, lrclibFind, karalyrFind, mxFind, neFind, state, service }
}

describe('LyricsService provider selection', () => {
  it('uses only local files when selected', async () => {
    const s = setup({
      provider: 'local',
      lrclib: async () => ({ status: 'found', record: record() })
    })
    await s.local.ensureDir()
    writeFileSync(join(s.base, 'local', 'Lantern Test Band - Paper Lanterns.lrc'), lrc, 'utf8')

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'local' })
    expect(s.lrclibFind).not.toHaveBeenCalled()
    expect(s.karalyrFind).not.toHaveBeenCalled()
    expect(s.mxFind).not.toHaveBeenCalled()
    expect(s.neFind).not.toHaveBeenCalled()
  })

  it('does not fall back from local files when the file is missing', async () => {
    const s = setup({
      provider: 'local',
      lrclib: async () => ({ status: 'found', record: record() })
    })
    expect(await s.service.get(query)).toMatchObject({ status: 'not-found', source: 'local' })
    expect(s.lrclibFind).not.toHaveBeenCalled()
    expect(s.karalyrFind).not.toHaveBeenCalled()
    expect(s.mxFind).not.toHaveBeenCalled()
    expect(s.neFind).not.toHaveBeenCalled()
  })

  it('uses only LRCLIB and keeps its cache separate from the automatic slot', async () => {
    const s = setup({
      provider: 'lrclib',
      lrclib: async () => ({ status: 'found', record: record() }),
      karalyr: karalyrFound,
      musixmatch: musixmatchFound,
      netease: neteaseFound
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.lrclibFind).toHaveBeenCalledTimes(1)
    expect(s.karalyrFind).not.toHaveBeenCalled()
    expect(s.mxFind).not.toHaveBeenCalled()
    expect(s.neFind).not.toHaveBeenCalled()
    expect(await s.cache.get(providerCacheKey(query, 'lrclib'))).toMatchObject({ status: 'found' })
    expect(await s.cache.get(cacheKey(query))).toBeNull()
  })

  it('uses only NetEase even when the word-level toggle is off', async () => {
    const s = setup({
      provider: 'netease',
      wordEnabled: false,
      lrclib: async () => ({ status: 'found', record: record() }),
      netease: neteaseFound
    })

    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'netease' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(s.lrclibFind).not.toHaveBeenCalled()
    expect(s.neFind).toHaveBeenCalledTimes(1)

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'netease' })
    expect(s.neFind).toHaveBeenCalledTimes(1)
    expect(await s.cache.get(providerCacheKey(query, 'netease'))).toMatchObject({ status: 'found' })
  })

  it('uses only Karalyr and reuses its own payload cache', async () => {
    const s = setup({
      provider: 'karalyr',
      lrclib: async () => ({ status: 'found', record: record() }),
      karalyr: karalyrFound,
      netease: neteaseFound
    })

    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'karalyr' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(s.lrclibFind).not.toHaveBeenCalled()
    expect(s.neFind).not.toHaveBeenCalled()

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'karalyr' })
    expect(s.karalyrFind).toHaveBeenCalledTimes(1)
    expect(await s.cache.get(providerCacheKey(query, 'karalyr'))).toMatchObject({ status: 'found' })
  })

  it('uses only Musixmatch and reuses its richsync cache', async () => {
    const s = setup({
      provider: 'musixmatch',
      lrclib: async () => ({ status: 'found', record: record() }),
      musixmatch: musixmatchFound
    })

    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'musixmatch' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(s.lrclibFind).not.toHaveBeenCalled()

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'musixmatch' })
    expect(s.mxFind).toHaveBeenCalledTimes(1)
    expect(await s.cache.get(providerCacheKey(query, 'musixmatch'))).toMatchObject({ status: 'found' })
  })

  it('does not fall back when the selected provider misses', async () => {
    const s = setup({
      provider: 'lrclib',
      lrclib: async () => ({ status: 'not-found' }),
      karalyr: karalyrFound,
      musixmatch: musixmatchFound,
      netease: neteaseFound
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'not-found', source: 'lrclib' })
    expect(s.karalyrFind).not.toHaveBeenCalled()
    expect(s.mxFind).not.toHaveBeenCalled()
    expect(s.neFind).not.toHaveBeenCalled()
    expect(await s.cache.get(providerCacheKey(query, 'lrclib'))).toMatchObject({ status: 'not-found' })

    expect(await s.service.get(query)).toMatchObject({ status: 'not-found', source: 'lrclib' })
    expect(s.lrclibFind).toHaveBeenCalledTimes(1)
  })

  it('reports a selected provider error without falling back', async () => {
    const s = setup({
      provider: 'karalyr',
      karalyr: async () => ({ status: 'error', message: 'HTTP 429' }),
      lrclib: async () => ({ status: 'found', record: record() })
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'error', source: 'karalyr' })
    expect(s.lrclibFind).not.toHaveBeenCalled()
    expect(await s.cache.get(providerCacheKey(query, 'karalyr'))).toBeNull()
  })

  it('reports not-found when Musixmatch has no API key', async () => {
    const s = setup({
      provider: 'musixmatch',
      musixmatch: async () => ({ status: 'bypass' }),
      lrclib: async () => ({ status: 'found', record: record() })
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'not-found', source: 'musixmatch' })
    expect(s.lrclibFind).not.toHaveBeenCalled()
  })

  it('ignores the automatic cache when an explicit provider is selected', async () => {
    const s = setup({
      provider: 'lrclib',
      lrclib: async () => ({ status: 'not-found' })
    })
    await s.cache.set(cacheKey(query), { status: 'found', record: record(), fetchedAt: Date.now() })

    expect(await s.service.get(query)).toMatchObject({ status: 'not-found', source: 'lrclib' })
    expect(s.lrclibFind).toHaveBeenCalledTimes(1)
  })

  it('switches providers without reusing the previous provider cache', async () => {
    const s = setup({
      provider: 'lrclib',
      lrclib: async () => ({ status: 'found', record: record() }),
      karalyr: karalyrFound
    })

    expect(await s.service.get(query)).toMatchObject({ source: 'lrclib' })
    s.state.provider = 'karalyr'
    expect(await s.service.get(query)).toMatchObject({ source: 'karalyr' })
    expect(s.karalyrFind).toHaveBeenCalledTimes(1)
  })
})
