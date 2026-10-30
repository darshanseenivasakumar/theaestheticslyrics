import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike, FindResult, LrclibClient } from '../../src/main/lyrics/lrclib'
import type { LrclibRecord, TrackQuery } from '../../src/main/lyrics/match'
import { MusixmatchProvider, type MusixmatchResult } from '../../src/main/lyrics/musixmatch'
import type { NeteaseClient, NeteaseResult } from '../../src/main/lyrics/netease'
import { parseRichsyncBody, richsyncToTimedLyrics } from '../../src/main/lyrics/richsync'
import { cacheKey, LyricsCache } from '../../src/main/lyrics/cache'
import { LocalLyrics } from '../../src/main/lyrics/local'
import { LyricsService } from '../../src/main/lyrics/service'
import { activeWordIndex, buildModel, msUntilNextWord } from '../../src/renderer/src/stage/model'

// Synthetic fixtures in the shape Musixmatch's /track.richsync.get answers with
// (timestamps in seconds), written for a make-believe song, not a real one.
const FIXTURES = join(__dirname, '..', 'fixtures')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function richsyncBodyOf(envelope: Record<string, unknown>): unknown {
  const message = isRecord(envelope.message) ? envelope.message : null
  const body = message && isRecord(message.body) ? message.body : null
  const richsync = body && isRecord(body.richsync) ? body.richsync : null
  if (!richsync || !Array.isArray(richsync.richsync_body)) throw new Error('fixture carries no richsync_body')
  return richsync.richsync_body
}

const COMPLETE_BODY = richsyncBodyOf(fixture('musixmatch-richsync-complete.json'))
const TRUNCATED_BODY = richsyncBodyOf(fixture('musixmatch-richsync-truncated.json'))
const UNAUTHORIZED = fixture('musixmatch-401.json')

const query: TrackQuery = { title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationMs: 32_400 }

const track = (id: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  track: {
    track_id: id,
    track_name: 'Paper Lanterns',
    track_name_version: '',
    track_rating: 100,
    track_length: 32,
    instrumental: 0,
    has_richsync: 1,
    album_id: 1234,
    album_name: 'Fixtures',
    artist_id: 5678,
    artist_name: 'Lantern Test Band',
    ...over
  }
})

const searchReply = (tracks: unknown[]): Record<string, unknown> => ({
  message: { header: { status_code: 200, execute_time: 0.02 }, body: { track_list: tracks } }
})

const richsyncReply = (body: unknown): Record<string, unknown> => ({
  message: {
    header: { status_code: 200, execute_time: 0.09 },
    body: { richsync: { richsync_id: 8991411, track_id: 63203636, sync_type: 'richsync', provider: 'Musixmatch', richsync_body: body } }
  }
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

const client = (fetch: FetchLike, apiKey = 'test-key'): MusixmatchProvider =>
  new MusixmatchProvider({ apiKey, fetch, baseUrl: 'https://mx.test' })

describe('MusixmatchProvider.find', () => {
  it('bypasses silently when secrets.ts has no key', async () => {
    const s = scripted([])
    expect(await client(s.fetch, '').find(query)).toEqual({ status: 'bypass' })
    expect(s.urls).toHaveLength(0)
  })

  it('asks track.search, then track.richsync.get for the best candidate', async () => {
    const s = scripted([{ body: searchReply([track(11)]) }, { body: richsyncReply(COMPLETE_BODY) }])
    const result = await client(s.fetch).find(query)
    expect(result.status === 'found' && result.track.id).toBe(11)
    expect(result.status === 'found' && result.track.title).toBe('Paper Lanterns')
    expect(result.status === 'found' && result.richsyncBody).toBe(COMPLETE_BODY)
    expect(s.urls[0]).toContain('/track.search?')
    expect(s.urls[0]).toContain('apikey=test-key')
    expect(s.urls[0]).toContain('qtrack=Paper+Lanterns')
    expect(s.urls[0]).toContain('qartist=Lantern+Test+Band')
    expect(s.urls[1]).toContain('/track.richsync.get?')
    expect(s.urls[1]).toContain('track_id=11')
    expect(s.headers[0]?.['User-Agent']).toContain('theaestheticslyrics')
  })

  it('URL-encodes the media metadata before querying', async () => {
    const s = scripted([{ body: searchReply([]) }, { body: searchReply([]) }])
    expect(await client(s.fetch).find({ ...query, title: 'Paper & Lanterns' })).toEqual({ status: 'not-found' })
    expect(s.urls[0]).toContain('qtrack=Paper+%26+Lanterns')
    expect(s.urls[0]).toContain('qartist=Lantern+Test+Band')
  })

  it('searches by title and album when the player gives no artist', async () => {
    const s = scripted([{ body: searchReply([]) }, { body: searchReply([]) }])
    await client(s.fetch).find({ ...query, artist: '' })
    expect(s.urls[0]).toContain('qalbum=Fixtures')
    expect(s.urls[1]).not.toContain('qalbum=')
  })

  it('searches once when the player publishes neither artist nor album', async () => {
    const s = scripted([{ body: searchReply([]) }])
    expect(await client(s.fetch).find({ ...query, artist: '', album: '' })).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(1)
  })

  it('never syncs words for a different-length recording', async () => {
    const s = scripted([{ body: searchReply([track(21, { track_length: 96 })]) }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'not-found' })
    // The empty-for-this-query search is widened to a title-only second look.
    expect(s.urls).toHaveLength(2)
    expect(s.urls[1]).toContain('qtrack=Paper+Lanterns')
    expect(s.urls[1]).not.toContain('qartist=')
  })

  it('skips candidates without richsync data instead of spending a request', async () => {
    const s = scripted([
      { body: searchReply([track(11, { has_richsync: 0 }), track(12)]) },
      { body: richsyncReply(TRUNCATED_BODY) }
    ])
    expect((await client(s.fetch).find(query)).status).toBe('found')
    expect(s.urls[1]).toContain('track_id=12')
    expect(s.urls).toHaveLength(2)
  })

  it('tries the next candidate when richsync is missing for the first', async () => {
    const s = scripted([
      { body: searchReply([track(31), track(32, { track_length: 33 })]) },
      { status: 404, body: {} },
      { body: richsyncReply(COMPLETE_BODY) }
    ])
    const result = await client(s.fetch).find(query)
    expect(result.status === 'found' && result.track.id).toBe(32)
    expect(s.urls).toHaveLength(3)
  })

  it('widens the query when the first search answers nothing', async () => {
    const s = scripted([
      { body: searchReply([]) },
      { body: searchReply([track(41, { artist_name: 'Lantern Band' })]) },
      { body: richsyncReply(COMPLETE_BODY) }
    ])
    const result = await client(s.fetch).find(query)
    expect(result.status === 'found' && result.track.id).toBe(41)
    expect(s.urls[1]).not.toContain('qartist=')
  })

  it('hands control down the chain instantly on 401, without a second request', async () => {
    const s = scripted([{ status: 401, body: UNAUTHORIZED }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'error', message: 'HTTP 401' })
    expect(s.urls).toHaveLength(1)
  })

  it('stays cool after a refusal so rapid skipping stops burning quota', async () => {
    const s = scripted([{ status: 401, body: UNAUTHORIZED }])
    const mx = client(s.fetch)
    expect(await mx.find(query)).toEqual({ status: 'error', message: 'HTTP 401' })
    expect(await mx.find(query)).toEqual({ status: 'bypass' })
    expect(s.urls).toHaveLength(1)
  })

  it('treats a body-level 401 the same way (service codes ride inside HTTP 200)', async () => {
    const s = scripted([{ body: UNAUTHORIZED }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'error', message: 'api code 401' })
    expect(s.urls).toHaveLength(1)
  })

  it('passes 403 and 429 down the chain', async () => {
    const forbidden = scripted([{ body: { message: { header: { status_code: 403 } } } }])
    expect((await client(forbidden.fetch).find(query)).status).toBe('error')
    expect((await client(scripted([{ status: 429, body: {} }]).fetch).find(query)).status).toBe('error')
  })

  it('reports unreachable, server-broken or unusable replies as errors', async () => {
    expect((await client(scripted([new Error('aborted')]).fetch).find(query)).status).toBe('error')
    expect((await client(scripted([{ status: 500, body: {} }]).fetch).find(query)).status).toBe('error')
    const s = scripted([{ body: searchReply([track(51)]) }, { body: { message: { header: { status_code: 200 }, body: {} } } }])
    expect(await client(s.fetch).find(query)).toEqual({ status: 'error', message: 'richsync payload unusable' })
  })

  it('returns the truncated payload as-is; truncation is a rendering concern', async () => {
    const s = scripted([{ body: searchReply([track(61)]) }, { body: richsyncReply(TRUNCATED_BODY) }])
    const result = await client(s.fetch).find(query)
    expect(result.status).toBe('found')
    expect(result.status === 'found' && result.richsyncBody).toBe(TRUNCATED_BODY)
  })
})

describe('richsync parser', () => {
  const DURATION_MS = 32_400

  it('maps the complete fixture word-for-word without dropping anything', () => {
    const lyrics = richsyncToTimedLyrics(COMPLETE_BODY, DURATION_MS)
    expect(lyrics?.wordTiming).toBe('native')
    expect(lyrics?.lines).toHaveLength(7)
    expect(lyrics?.lines.flatMap((line) => line.words.map((w) => w.text))).toHaveLength(26)
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
    expect(lyrics?.lines.at(-1)).toEqual({
      text: 'The light through the glass',
      start: 28_300,
      end: 31_900,
      words: [
        { text: 'The', start: 28_300, end: 28_900 },
        { text: 'light', start: 28_900, end: 29_600 },
        { text: 'through', start: 29_600, end: 30_400 },
        { text: 'the', start: 30_400, end: 30_900 },
        { text: 'glass', start: 30_900, end: 31_900 }
      ]
    })
  })

  it('caps the array on the truncated fixture instead of inventing coverage', () => {
    const lyrics = richsyncToTimedLyrics(TRUNCATED_BODY, DURATION_MS)
    expect(lyrics).not.toBeNull()
    expect(lyrics?.lines).toHaveLength(2)
    expect((lyrics?.lines ?? []).every((line) => line.start >= 0 && line.end <= DURATION_MS)).toBe(true)
    expect(lyrics?.lines.at(-1)?.end).toBe(8000)
    expect(lyrics?.wordTiming).toBe('native')
  })

  it('keeps the renderer safe past the end of a truncated payload', () => {
    const model = buildModel(richsyncToTimedLyrics(TRUNCATED_BODY, DURATION_MS)!)
    expect(model.words.length).toBe(7)
    // The song keeps playing at 60 s: the last sung word holds and no next word exists.
    expect(activeWordIndex(model, 60_000)).toBe(6)
    expect(msUntilNextWord(model, 60_000)).toBe(Number.POSITIVE_INFINITY)
  })

  it('drops lines that would start past the player-reported end', () => {
    const over: unknown[] = [...(COMPLETE_BODY as unknown[]), { ts: 35.0, te: 36.0, x: 0, l: 'nonsense', w: [] }]
    expect(parseRichsyncBody(over, DURATION_MS)?.some((line) => line.start >= 33_400)).toBe(false)
    expect(parseRichsyncBody(over, DURATION_MS)?.some((line) => line.start > DURATION_MS)).toBe(false)
  })

  it('keeps the flattened words ascending when a payload overlaps its own lines', () => {
    const overlap: unknown[] = [
      {
        ts: 1.0,
        te: 4.0,
        l: 'aa bb cc',
        w: [
          { w: 'aa ', ts: 1.0, te: 2.0 },
          { w: 'bb ', ts: 2.0, te: 3.5 },
          { w: 'cc', ts: 3.0, te: 3.8 }
        ]
      },
      {
        ts: 3.6,
        te: 6.0,
        l: 'dd ee',
        w: [
          { w: 'dd ', ts: 3.4, te: 4.4 },
          { w: 'ee', ts: 4.4, te: 5.4 }
        ]
      }
    ]
    const model = buildModel(richsyncToTimedLyrics(overlap)! ) // duration unknown: no cap applied
    const starts = model.words.map((w) => w.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    // Overlap clamp: a line is floored at the previous line's last placed word START
    // (cc starts at 3000, so the floor is 3000), then each word inside a line is floored
    // at that line's clamped start — dd's raw 3400 hold no claim and sits at 3600.
    expect(model.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ['aa', 1000, 2000],
      ['bb', 2000, 3500],
      ['cc', 3000, 3800],
      ['dd', 3600, 4400],
      ['ee', 4400, 5400]
    ])
  })

  it('degrades estimate-style when a line arrives without word timings', () => {
    const sparse: unknown[] = [{ ts: 1, te: 5, l: 'Soft light in the yard' }, { ts: 6, te: 9, l: ' ', w: [] }]
    const lyrics = richsyncToTimedLyrics(sparse, DURATION_MS)
    expect(lyrics?.lines).toHaveLength(1)
    expect(lyrics?.wordTiming).toBe('estimated')
    expect(lyrics?.lines[0]?.words.at(-1)?.end).toBeGreaterThan(0)
  })

  it('rejects payloads that are not a usable line array', () => {
    expect(parseRichsyncBody(null, DURATION_MS)).toBeNull()
    expect(parseRichsyncBody('oops', DURATION_MS)).toBeNull()
    expect(parseRichsyncBody([{ l: 'no times here' }], DURATION_MS)).toBeNull()
    expect(parseRichsyncBody([42], DURATION_MS)).toBeNull()
  })
})

function serviceSetup(
  primary: () => Promise<MusixmatchResult>,
  lrclib?: () => Promise<FindResult>
): { cache: LyricsCache; client: { find: ReturnType<typeof vi.fn> }; service: LyricsService; logs: string[] } {
  const base = mkdtempSync(join(tmpdir(), 'tal-mx-'))
  const local = new LocalLyrics(join(base, 'local'))
  const cache = new LyricsCache(join(base, 'cache'))
  const client = { find: vi.fn(lrclib ?? (async (): Promise<FindResult> => ({ status: 'not-found' }))) }
  const wordClient = { find: vi.fn(async (): Promise<NeteaseResult> => ({ status: 'not-found' })) }
  const logs: string[] = []
  const service = new LyricsService({
    local,
    cache,
    client: client as unknown as LrclibClient,
    log: (message) => logs.push(message),
    primary: { client: { find: vi.fn(primary) } as unknown as MusixmatchProvider },
    wordLevel: { client: wordClient as unknown as NeteaseClient, enabled: () => true }
  })
  return { cache, client, service, logs }
}

const record: LrclibRecord = {
  id: 1,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: null,
  syncedLyrics:
    '[00:01.00]Paper lanterns drifting\n[00:05.00]Low over the rooftops\n[00:09.00]Every window keeps\n[00:14.00]Hold the light',
  lyricsfile: null
}

const mxTrack = { id: 11, title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationSec: 32 }

describe('LyricsService with Musixmatch first', () => {
  it('queries Musixmatch ahead of the cache and the network', async () => {
    const s = serviceSetup(
      async () => ({ status: 'found', richsyncBody: COMPLETE_BODY, track: mxTrack }),
      async () => {
        throw new Error('lrclib must not be consulted')
      }
    )
    await s.cache.set(cacheKey(query), { status: 'found', record, fetchedAt: Date.now() })
    const result = await s.service.get(query)
    expect(result).toMatchObject({ status: 'found', source: 'musixmatch' })
    expect(result.lyrics?.wordTiming).toBe('native')
    expect(s.client.find).not.toHaveBeenCalled()
  })

  it('falls through to LRCLIB when Musixmatch has nothing', async () => {
    const s = serviceSetup(async () => ({ status: 'not-found' }), async () => ({ status: 'found', record }))
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
  })

  it('passes refusals down the chain and logs once, without crashing', async () => {
    const s = serviceSetup(async () => ({ status: 'error', message: 'HTTP 401' }), async () => ({ status: 'found', record }))
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.logs.some((m) => m.includes('musixmatch unavailable (HTTP 401)'))).toBe(true)
  })

  it('lets a bypassed provider hand the song to the cache untouched', async () => {
    const s = serviceSetup(async () => ({ status: 'bypass' }), async () => ({ status: 'found', record }))
    await s.cache.set(cacheKey(query), { status: 'found', record, fetchedAt: Date.now() })
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'cache' })
  })

  it('falls through quietly when "found" comes without a usable payload', async () => {
    const s = serviceSetup(
      async () => ({ status: 'found', richsyncBody: 'oops', track: mxTrack }),
      async () => ({ status: 'found', record })
    )
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.logs.some((m) => m.includes('musixmatch payload unusable'))).toBe(true)
  })
})
