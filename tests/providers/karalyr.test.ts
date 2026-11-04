import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LyricsCache, cacheKey } from '../../src/main/lyrics/cache'
import {
  KaraLyrClient,
  hasKaraLyrWordTiming,
  isSameRecording,
  karalyrSyncType,
  karalyrToTimedLyrics,
  karalyrTrackToRecord,
  parseKaraLyrPayload,
  payloadToParsedLines,
  sanitizeKaralyrTitle,
  type KaraLyrOptions,
  type KaraLyrPayload,
  type KaraLyrResult
} from '../../src/main/lyrics/karalyr'
import { LocalLyrics } from '../../src/main/lyrics/local'
import type { FetchLike, FindResult, LrclibClient } from '../../src/main/lyrics/lrclib'
import type { LrclibRecord, TrackQuery } from '../../src/main/lyrics/match'
import type { NeteaseClient, NeteaseResult } from '../../src/main/lyrics/netease'
import { LyricsService } from '../../src/main/lyrics/service'

// Synthetic fixtures in the shape karalyr.com's LRCLIB-compatible /api/get answers with,
// written for the same make-believe song as the other provider tests.
const query: TrackQuery = { title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationMs: 32_400 }

const PAYLOAD: KaraLyrPayload = {
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
      singer: 'BOTH',
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

const LINE_ONLY: KaraLyrPayload = {
  format_version: 1,
  lines: [
    { start_ms: 500, end_ms: 4200, singer: null, text: 'Paper lanterns drifting' },
    { start_ms: 5000, end_ms: 9000, singer: null, text: 'Low over the rooftops' }
  ],
  meta: { language: 'en', has_word_timing: false, countdown_lines: [] }
}

const trackBody = (over: Record<string, unknown> = {}, payload: KaraLyrPayload | null = PAYLOAD): Record<string, unknown> => ({
  id: 101,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: 'Paper lanterns drifting\nLow over the rooftops',
  syncedLyrics: '[00:00.50]Paper lanterns drifting\n[00:05.00]Low over the rooftops',
  ...(payload
    ? {
        karalyr: {
          payload,
          tier: 'verified',
          source: 'fixture',
          revision_id: 7,
          has_word_timing: true,
          has_chords: false
        }
      }
    : {}),
  ...over
})

type Reply = { status?: number; body?: unknown } | Error

function scripted(replies: Reply[]): { fetch: FetchLike; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  const fetch: FetchLike = async (url, init) => {
    urls.push(url)
    headers.push(init?.headers ?? {})
    const reply = replies.shift()
    if (!reply) throw new Error(`unexpected request ${url}`)
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    return { status, ok: status >= 200 && status < 300, json: async () => reply.body }
  }
  return { fetch, urls, headers }
}

// apiKey: '' pins the key off so a developer's KARALYR_API_KEY cannot change these tests.
const client = (fetch: FetchLike, over: Partial<KaraLyrOptions> = {}): KaraLyrClient =>
  new KaraLyrClient({ fetch, baseUrl: 'https://kl.test', userAgent: 'theaestheticslyrics/test', apiKey: '', ...over })

const ENV_URL = 'KARALYR_API_URL'
const ENV_KEY = 'KARALYR_API_KEY'
const savedEnv = { url: process.env[ENV_URL], key: process.env[ENV_KEY] }

afterEach(() => {
  for (const [name, value] of [
    [ENV_URL, savedEnv.url],
    [ENV_KEY, savedEnv.key]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('KaraLyr payload conversion', () => {
  it('maps word timings directly into native word-by-word lines', () => {
    const lyrics = karalyrToTimedLyrics(PAYLOAD, 32_400)
    expect(lyrics?.wordTiming).toBe('native')
    expect(lyrics?.lines[0]).toEqual({
      text: 'Paper lanterns drifting',
      start: 500,
      end: 4200,
      words: [
        { text: 'Paper', start: 500, end: 1300 },
        { text: 'lanterns', start: 1300, end: 2400 },
        { text: 'drifting', start: 2400, end: 4200 }
      ]
    })
    expect(lyrics?.lines[1]?.words.at(-1)).toEqual({ text: 'rooftops', start: 6500, end: 9000 })
  })

  it('refines a word span with its syllables when the word splits', () => {
    const payload: KaraLyrPayload = {
      format_version: 1,
      lines: [
        {
          start_ms: 500,
          end_ms: 4200,
          singer: null,
          text: 'lanterns',
          words: [
            {
              text: 'lanterns',
              start_ms: 1200,
              end_ms: 1800,
              syllables: [
                { text: 'lan', start_ms: 1000, end_ms: 1500 },
                { text: 'terns', start_ms: 1500, end_ms: 1900 }
              ]
            }
          ]
        }
      ],
      meta: { language: 'en', has_word_timing: true, countdown_lines: [] }
    }
    expect(karalyrSyncType(payload)).toBe('syllable')
    expect(karalyrToTimedLyrics(payload)?.lines[0]?.words[0]).toEqual({ text: 'lanterns', start: 1000, end: 1900 })
  })

  it('estimates word timing for a line-only payload', () => {
    const lyrics = karalyrToTimedLyrics(LINE_ONLY, 32_400)
    expect(lyrics?.lines).toHaveLength(2)
    expect(lyrics?.wordTiming).toBe('estimated')
    expect(lyrics?.lines[0]?.text).toBe('Paper lanterns drifting')
    expect(lyrics?.lines[0]?.words.length).toBeGreaterThan(0)
    expect(karalyrSyncType(LINE_ONLY)).toBe('line')
  })

  it('floors overlapping words so the flattened timeline stays ascending', () => {
    const payload: KaraLyrPayload = {
      format_version: 1,
      lines: [
        {
          start_ms: 1000,
          end_ms: 3800,
          singer: null,
          text: 'aa bb cc',
          words: [
            { text: 'aa', start_ms: 1000, end_ms: 2000 },
            { text: 'bb', start_ms: 2000, end_ms: 3500 },
            { text: 'cc', start_ms: 3000, end_ms: 3800 }
          ]
        },
        {
          start_ms: 2800,
          end_ms: 6000,
          singer: null,
          text: 'dd ee',
          words: [
            { text: 'dd', start_ms: 2800, end_ms: 4400 },
            { text: 'ee', start_ms: 4400, end_ms: 5400 }
          ]
        }
      ],
      meta: { language: 'en', has_word_timing: true, countdown_lines: [] }
    }
    const lines = payloadToParsedLines(payload) ?? []
    const starts = lines.flatMap((line) => (line.words ?? []).map((word) => word.start))
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    // The second line's raw start (2800) sits before the first line's last placed word
    // start (3000), so both it and its first word are floored at 3000.
    expect(lines[1]?.start).toBe(3000)
    expect(lines[1]?.words?.[0]).toEqual({ text: 'dd', start: 3000, end: 4400 })
  })

  it('drops lines that would start past the player-reported end', () => {
    const payload: KaraLyrPayload = {
      format_version: 1,
      lines: [
        { start_ms: 500, end_ms: 4200, singer: null, text: 'In range', words: [{ text: 'In', start_ms: 500, end_ms: 900 }] },
        { start_ms: 40_000, end_ms: 42_000, singer: null, text: 'After the song' }
      ],
      meta: { language: 'en', has_word_timing: true, countdown_lines: [] }
    }
    const lyrics = karalyrToTimedLyrics(payload, 32_400)
    expect(lyrics?.lines.map((line) => line.text)).toEqual(['In range'])
  })

  it('rejects missing, foreign-version or empty payloads', () => {
    expect(parseKaraLyrPayload(undefined)).toBeNull()
    expect(parseKaraLyrPayload('not json')).toBeNull()
    expect(parseKaraLyrPayload(JSON.stringify({ format_version: 2, lines: [] }))).toBeNull()
    expect(parseKaraLyrPayload(JSON.stringify({ format_version: 1, lines: [] }))).toBeNull()
    expect(parseKaraLyrPayload(JSON.stringify(PAYLOAD))).toEqual(PAYLOAD)
    expect(karalyrSyncType(PAYLOAD)).toBe('line')
    expect(karalyrSyncType(LINE_ONLY)).toBe('line')
    expect(hasKaraLyrWordTiming(PAYLOAD)).toBe(true)
    expect(hasKaraLyrWordTiming(LINE_ONLY)).toBe(false)
    expect(hasKaraLyrWordTiming(null)).toBe(false)
    expect(karalyrSyncType(null)).toBe('plain')
  })
})

describe('Karalyr strict matching', () => {
  it('strips bracket noise and featuring credits from the query title', () => {
    expect(sanitizeKaralyrTitle('Paper Lanterns (Official Video) [Remastered] ft. Extra Voice')).toBe('Paper Lanterns')
    expect(sanitizeKaralyrTitle('Paper Lanterns (2011)')).toBe('Paper Lanterns')
    expect(sanitizeKaralyrTitle('Paper Lanterns [From the Film]')).toBe('Paper Lanterns')
    expect(sanitizeKaralyrTitle('  Paper   Lanterns  ')).toBe('Paper Lanterns')
    expect(sanitizeKaralyrTitle('(Official Video)')).toBe('')
  })

  it('requires the title, artist and known duration to agree', () => {
    const track = { trackName: 'Paper Lanterns', artistName: 'Lantern Test Band', duration: 32 }
    expect(isSameRecording(query, track)).toBe(true)
    expect(isSameRecording(query, { ...track, trackName: 'Paper Lanterns (Remastered 2011)' })).toBe(true)
    expect(isSameRecording(query, { ...track, trackName: 'The Paper Lanterns' })).toBe(true)
    expect(isSameRecording(query, { ...track, trackName: 'Paper Lanterns (Remix)' })).toBe(false)
    expect(isSameRecording(query, { ...track, trackName: 'Paper Lanterns (From the Film)' })).toBe(false)
    expect(isSameRecording(query, { ...track, trackName: 'Completely Different Song' })).toBe(false)
    expect(isSameRecording(query, { ...track, artistName: 'Some Other Band' })).toBe(false)
    expect(isSameRecording(query, { ...track, duration: 96 })).toBe(false)
    expect(isSameRecording({ ...query, durationMs: 0 }, { ...track, duration: 0 })).toBe(true)
  })
})

describe('KaraLyrClient.find', () => {
  it('asks /api/get with the exact recording and names itself in the headers', async () => {
    const s = scripted([{ body: trackBody() }])
    const result = await client(s.fetch).find(query)
    expect(result.status).toBe('found')
    expect(s.urls).toHaveLength(1)
    const url = new URL(s.urls[0]!)
    expect(`${url.origin}${url.pathname}`).toBe('https://kl.test/api/get')
    expect(url.searchParams.get('artist_name')).toBe('Lantern Test Band')
    expect(url.searchParams.get('track_name')).toBe('Paper Lanterns')
    expect(url.searchParams.get('album_name')).toBe('Fixtures')
    expect(url.searchParams.get('duration')).toBe('32')
    expect(s.headers[0]).toMatchObject({
      'X-Karalyr-Client': 'theaestheticslyrics/test',
      'User-Agent': 'theaestheticslyrics/test',
      Accept: 'application/json'
    })
    expect(s.headers[0]?.Authorization).toBeUndefined()
  })

  it('strips player release noise before querying', async () => {
    const s = scripted([{ body: trackBody() }])
    await client(s.fetch).find({
      ...query,
      title: 'Paper Lanterns (Remastered 2011) [Live] feat. Extra Voice',
      artist: 'Lantern Test Band feat. Other Voice'
    })
    const url = new URL(s.urls[0]!)
    expect(url.searchParams.get('track_name')).toBe('Paper Lanterns')
    expect(url.searchParams.get('artist_name')).toBe('Lantern Test Band')
  })

  it('widens once without album/duration after a 404', async () => {
    const s = scripted([{ status: 404 }, { body: trackBody() }])
    expect((await client(s.fetch).find(query)).status).toBe('found')
    expect(s.urls).toHaveLength(2)
    const widened = new URL(s.urls[1]!)
    expect(widened.searchParams.has('album_name')).toBe(false)
    expect(widened.searchParams.has('duration')).toBe(false)
    expect(widened.searchParams.get('track_name')).toBe('Paper Lanterns')
  })

  it('reports not-found after both attempts miss', async () => {
    const s = scripted([{ status: 404 }, { status: 404 }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(2)
  })

  it('rejects a reply for a different-length recording', async () => {
    const s = scripted([{ body: trackBody({ duration: 96 }) }, { status: 404 }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(2)
  })

  it('treats a same-artist, same-length reply with a different title as a 404', async () => {
    const s = scripted([
      { body: trackBody({ trackName: 'Completely Different Song' }) },
      { body: trackBody({ trackName: 'Completely Different Song' }) }
    ])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(2)
  })

  it('treats a same-title reply by a different artist as a 404', async () => {
    const s = scripted([
      { body: trackBody({ artistName: 'Some Other Band' }) },
      { body: trackBody({ artistName: 'Some Other Band' }) }
    ])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(2)
  })

  it('makes no request for placeholder artist metadata', async () => {
    const s = scripted([])
    expect(await client(s.fetch).find({ ...query, artist: 'Unknown Artist' })).toEqual({ status: 'not-found' })
    expect(await client(s.fetch).find({ ...query, artist: 'Various Artists' })).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(0)
  })

  it('falls back to the untouched title when parentheses are part of the song name', async () => {
    const s = scripted([
      { status: 404 },
      { status: 404 },
      { body: trackBody({ trackName: 'Paper Lanterns (From the Film)' }) }
    ])
    const result = await client(s.fetch).find({ ...query, title: 'Paper Lanterns (From the Film)' })
    expect(result.status).toBe('found')
    expect(s.urls.map((url) => new URL(url).searchParams.get('track_name'))).toEqual([
      'Paper Lanterns',
      'Paper Lanterns',
      'Paper Lanterns (From the Film)'
    ])
  })

  it('accepts a returned title that only differs by release noise', async () => {
    const s = scripted([{ body: trackBody({ trackName: 'Paper Lanterns (Remastered 2011)' }) }])
    expect((await client(s.fetch).find(query)).status).toBe('found')
    expect(s.urls).toHaveLength(1)
  })

  it('hands 429 and 5xx straight down the chain without retrying', async () => {
    for (const status of [429, 503]) {
      const s = scripted([{ status, body: {} }])
      expect(await client(s.fetch).find(query)).toEqual({ status: 'error', message: `HTTP ${status}` })
      expect(s.urls).toHaveLength(1)
    }
  })

  it('turns a timeout or refused connection into an error, never a throw', async () => {
    const s = scripted([new Error('The operation was aborted due to timeout')])
    const result = await client(s.fetch).find(query)
    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.message).toContain('aborted')
  })

  it('makes no request when the player publishes no artist or title', async () => {
    const s = scripted([])
    expect(await client(s.fetch).find({ ...query, artist: '' })).toEqual({ status: 'not-found' })
    expect(await client(s.fetch).find({ ...query, title: '  ' })).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(0)
  })

  it('accepts an LRCLIB-shaped reply with no karaoke object, for the LRC fallback', async () => {
    const s = scripted([{ body: trackBody({}, null) }])
    const result = await client(s.fetch).find(query)
    expect(result.status).toBe('found')
    expect(result.status === 'found' && result.payload).toBeNull()
  })

  it('treats a reply with no timed text at all as not-found', async () => {
    const s = scripted([{ body: trackBody({ plainLyrics: null, syncedLyrics: null }, null) }])
    expect(await client(s.fetch).find({ ...query, album: '', durationMs: 0 })).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(1)
  })

  it('reports a garbage 200 body as an error', async () => {
    const s = scripted([{ body: 'oops' }])
    expect(await client(s.fetch).find({ ...query, album: '', durationMs: 0 })).toEqual({
      status: 'error',
      message: 'unreadable reply'
    })
  })

  it('takes the API URL and key from the environment when not passed', async () => {
    process.env[ENV_URL] = 'https://env.kl.test/'
    process.env[ENV_KEY] = 'env-secret'
    const s = scripted([{ body: trackBody() }])
    const envClient = new KaraLyrClient({ fetch: s.fetch, userAgent: 'theaestheticslyrics/test' })
    expect((await envClient.find(query)).status).toBe('found')
    expect(s.urls[0]?.startsWith('https://env.kl.test/api/get?')).toBe(true)
    expect(s.headers[0]?.Authorization).toBe('Bearer env-secret')
  })
})

function serviceSetup(
  karalyrFind: () => Promise<KaraLyrResult>,
  lrclib: () => Promise<FindResult> = async () => ({ status: 'not-found' }),
  opts: { word?: boolean } = {}
): {
  cache: LyricsCache
  client: { find: ReturnType<typeof vi.fn> }
  wordClient: { find: ReturnType<typeof vi.fn> }
  service: LyricsService
  logs: string[]
} {
  const base = mkdtempSync(join(tmpdir(), 'tal-karalyr-'))
  const local = new LocalLyrics(join(base, 'local'))
  const cache = new LyricsCache(join(base, 'cache'))
  const client = { find: vi.fn(lrclib) }
  const wordClient = { find: vi.fn(async (): Promise<NeteaseResult> => ({ status: 'not-found' })) }
  const logs: string[] = []
  const service = new LyricsService({
    local,
    cache,
    client: client as unknown as LrclibClient,
    log: (message) => logs.push(message),
    karalyr: { client: { find: vi.fn(karalyrFind) } as unknown as KaraLyrClient },
    wordLevel:
      opts.word === false
        ? undefined
        : { client: wordClient as unknown as NeteaseClient, enabled: () => true }
  })
  return { cache, client, wordClient, service, logs }
}

const karaTrack = {
  id: 101,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: 'Paper lanterns drifting',
  syncedLyrics: '[00:00.50]Paper lanterns drifting\n[00:05.00]Low over the rooftops'
}

const found = (payload: KaraLyrPayload | null = PAYLOAD): KaraLyrResult => ({
  status: 'found',
  track: karaTrack,
  payload
})

const lrclibRecord: LrclibRecord = {
  id: 1,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics: '[00:01.00]Paper lanterns drifting\n[00:05.00]Low over the rooftops',
  lyricsfile: null
}

describe('LyricsService with Karalyr first', () => {
  it('uses Karalyr ahead of LRCLIB and serves the payload from cache on repeats', async () => {
    const s = serviceSetup(async () => found(), async () => {
      throw new Error('lrclib must not be consulted')
    })
    const first = await s.service.get(query)
    expect(first).toMatchObject({ status: 'found', source: 'karalyr' })
    expect(first.lyrics?.wordTiming).toBe('native')
    expect(s.client.find).not.toHaveBeenCalled()

    const second = await s.service.get(query)
    expect(second).toMatchObject({ status: 'found', source: 'cache' })
    expect(second.lyrics?.wordTiming).toBe('native')
    expect(second.lyrics?.lines).toEqual(first.lyrics?.lines)
    expect(s.client.find).not.toHaveBeenCalled()
  })

  it('cascades silently to LRCLIB when Karalyr has no such song', async () => {
    const s = serviceSetup(async () => ({ status: 'not-found' }), async () => ({ status: 'found', record: lrclibRecord }))
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
  })

  it('logs refusals and still delivers LRCLIB', async () => {
    const s = serviceSetup(async () => ({ status: 'error', message: 'HTTP 429' }), async () => ({
      status: 'found',
      record: lrclibRecord
    }))
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.logs.some((message) => message.includes('karalyr unavailable (HTTP 429)'))).toBe(true)
  })

  it('keeps the chain alive when the client throws', async () => {
    const s = serviceSetup(
      async () => {
        throw new Error('socket hang up')
      },
      async () => ({ status: 'found', record: lrclibRecord })
    )
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.logs.some((message) => message.includes('karalyr failed (Error: socket hang up)'))).toBe(true)
  })

  it('skips the NetEase upgrade when Karalyr already timed every word', async () => {
    const s = serviceSetup(async () => found())
    await s.service.get(query)
    await s.service.get(query)
    expect(s.wordClient.find).not.toHaveBeenCalled()
  })

  it('lets NetEase upgrade a line-only Karalyr payload once', async () => {
    const s = serviceSetup(async () => found(LINE_ONLY))
    s.wordClient.find.mockResolvedValue({
      status: 'found',
      yrc: '[500,3700](500,400,0)Paper (900,600,0)lanterns (1500,500,0)drifting',
      song: { id: 1, title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationSec: 32 }
    } satisfies NeteaseResult)
    const first = await s.service.get(query)
    expect(first).toMatchObject({ status: 'found', source: 'karalyr' })
    expect(first.lyrics?.wordTiming).toBe('estimated')

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'netease' })
    expect(s.wordClient.find).toHaveBeenCalledTimes(1)

    const third = await s.service.get(query)
    expect(third).toMatchObject({ status: 'found', source: 'cache' })
    expect(third.lyrics?.wordTiming).toBe('native')
    expect(s.wordClient.find).toHaveBeenCalledTimes(1)
  })

  it('serves a cached Karalyr payload without any network call', async () => {
    const s = serviceSetup(async () => {
      throw new Error('network must not be consulted')
    })
    await s.cache.set(cacheKey(query), {
      status: 'found',
      record: karalyrTrackToRecord(karaTrack),
      karalyr: JSON.stringify(PAYLOAD),
      wordChecked: true,
      fetchedAt: Date.now()
    })
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'cache' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(s.client.find).not.toHaveBeenCalled()
  })

  it('falls back to the LRC-compatible syncedLyrics when a reply has no payload', async () => {
    const s = serviceSetup(async () => found(null))
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'karalyr' })
    expect(result.lyrics?.wordTiming).toBe('estimated')
    const entry = await s.cache.get(cacheKey(query))
    expect(entry?.karalyr).toBeUndefined()
    expect(entry?.wordChecked).toBe(false)
  })

  it('leaves existing service behaviour untouched when no Karalyr client is wired', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tal-karalyr-off-'))
    const cache = new LyricsCache(join(base, 'cache'))
    const client = { find: vi.fn(async (): Promise<FindResult> => ({ status: 'found', record: lrclibRecord })) }
    const service = new LyricsService({
      local: new LocalLyrics(join(base, 'local')),
      cache,
      client: client as unknown as LrclibClient,
      log: () => {}
    })
    expect(await service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(client.find).toHaveBeenCalledTimes(1)
  })
})
