import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BetterLyricsClient,
  parseTtmlLines,
  ttmlTimeToMs,
  ttmlToTimedLyrics,
  type BetterLyricsOptions,
  type BetterLyricsResult
} from '../../src/main/lyrics/betterlyrics'
import { LyricsCache } from '../../src/main/lyrics/cache'
import { LocalLyrics } from '../../src/main/lyrics/local'
import type { FetchLike, FindResult, LrclibClient } from '../../src/main/lyrics/lrclib'
import type { LrclibRecord, TrackQuery } from '../../src/main/lyrics/match'
import { LyricsService } from '../../src/main/lyrics/service'

// Synthetic Apple-Music-style TTML for the same make-believe song as the other provider
// tests. Adjacent spans exercise syllable merging; the x-bg subtree must not leak through.
const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>
<body dur="32.400">
<div begin="0.000" end="9.000">
<p begin="0.500" end="4.200"><span begin="0.500" end="1.300">Paper</span> <span begin="1.300" end="2.400">lan</span><span begin="2.400" end="3.000">terns</span> <span begin="3.000" end="4.200">drift&amp;ing</span></p>
<p begin="5.000" end="9.000"><span begin="5.000" end="5.600">Low</span> <span begin="5.600" end="6.200">over</span> <span begin="6.200" end="6.500">the</span> <span begin="6.500" end="9.000">roof</span><span begin="8.000" end="9.000">tops</span> <span ttm:role="x-bg"><span begin="7.500" end="8.500">(ooh)</span></span></p>
</div></body></tt>`

const query: TrackQuery = { title: 'Paper Lanterns', artist: 'Lantern Test Band', album: 'Fixtures', durationMs: 32_400 }

const record = (over: Partial<LrclibRecord> = {}): LrclibRecord => ({
  id: 1,
  trackName: 'Paper Lanterns',
  artistName: 'Lantern Test Band',
  albumName: 'Fixtures',
  duration: 32,
  instrumental: false,
  plainLyrics: 'Paper lanterns drifting\nLow over the rooftops',
  syncedLyrics: '[00:00.50]Paper lanterns drifting\n[00:05.00]Low over the rooftops',
  lyricsfile: null,
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

const client = (fetch: FetchLike, over: Partial<BetterLyricsOptions> = {}): BetterLyricsClient =>
  new BetterLyricsClient({
    fetch,
    baseUrl: 'https://bl.test',
    proxyUrl: '',
    apiKey: '',
    userAgent: 'theaestheticslyrics/test',
    ...over
  })

describe('Better Lyrics TTML parsing', () => {
  it('reads both documented time formats and plain seconds', () => {
    expect(ttmlTimeToMs('1:16.656')).toBe(76_656)
    expect(ttmlTimeToMs('00:01:30.500')).toBe(90_500)
    expect(ttmlTimeToMs('2.5')).toBe(2_500)
    expect(ttmlTimeToMs('nope')).toBeNaN()
  })

  it('maps syllable spans into native word timing', () => {
    const lyrics = ttmlToTimedLyrics(TTML, 32_400)
    expect(lyrics?.wordTiming).toBe('native')
    expect(lyrics?.lines[0]).toEqual({
      text: 'Paper lanterns drift&ing',
      start: 500,
      end: 4_200,
      words: [
        { text: 'Paper', start: 500, end: 1_300 },
        { text: 'lanterns', start: 1_300, end: 3_000 },
        { text: 'drift&ing', start: 3_000, end: 4_200 }
      ]
    })
    expect(lyrics?.lines[1]?.text).toBe('Low over the rooftops')
    expect(lyrics?.lines[1]?.words.at(-1)).toEqual({ text: 'rooftops', start: 6_500, end: 9_000 })
  })

  it('drops background-vocal subtrees', () => {
    const lines = parseTtmlLines(TTML) ?? []
    expect(lines.flatMap((line) => line.words?.map((word) => word.text) ?? [])).not.toContain('(ooh)')
  })

  it('rejects documents without timed words', () => {
    expect(parseTtmlLines('<tt><body/></tt>')).toBeNull()
    expect(parseTtmlLines('<tt><body><p begin="0">plain text</p></body></tt>')).toBeNull()
    expect(ttmlToTimedLyrics('not xml')).toBeNull()
  })
})

describe('BetterLyricsClient.find', () => {
  it('calls the direct API with all four parameters and the key header', async () => {
    const s = scripted([{ body: { ttml: TTML, score: 0.97 } }])
    const result = await client(s.fetch, { apiKey: 'secret' }).find(query)

    expect(result).toMatchObject({ status: 'found', score: 0.97 })
    const url = new URL(s.urls[0]!)
    expect(`${url.origin}${url.pathname}`).toBe('https://bl.test/getLyrics')
    expect(url.searchParams.get('song')).toBe('Paper Lanterns')
    expect(url.searchParams.get('artist')).toBe('Lantern Test Band')
    expect(url.searchParams.get('album')).toBe('Fixtures')
    expect(url.searchParams.get('duration')).toBe('32')
    expect(s.headers[0]).toMatchObject({
      Accept: 'application/json',
      'User-Agent': 'theaestheticslyrics/test',
      'X-API-Key': 'secret'
    })
  })

  it('uses the local proxy path and never sends the key to it', async () => {
    const s = scripted([{ body: { ttml: TTML } }])
    await client(s.fetch, { proxyUrl: 'http://127.0.0.1:8787', apiKey: 'secret' }).find(query)

    const url = new URL(s.urls[0]!)
    expect(`${url.origin}${url.pathname}`).toBe('http://127.0.0.1:8787/api/lyrics')
    expect(s.headers[0]?.['X-API-Key']).toBeUndefined()
  })

  it('strips player release noise before querying', async () => {
    const s = scripted([{ body: { ttml: TTML } }])
    await client(s.fetch).find({
      ...query,
      title: 'Paper Lanterns (Remastered 2011) [Live] feat. Extra Voice',
      artist: 'Lantern Test Band feat. Other Voice'
    })
    const url = new URL(s.urls[0]!)
    expect(url.searchParams.get('song')).toBe('Paper Lanterns')
    expect(url.searchParams.get('artist')).toBe('Lantern Test Band')
  })

  it('maps upstream statuses to clean provider results', async () => {
    expect(await client(scripted([{ status: 404 }]).fetch).find(query)).toEqual({ status: 'not-found' })
    expect(await client(scripted([{ status: 401 }]).fetch).find(query)).toMatchObject({ status: 'error' })
    expect(await client(scripted([{ status: 429 }]).fetch).find(query)).toMatchObject({ status: 'error' })
    expect(await client(scripted([{ status: 500 }]).fetch).find(query)).toMatchObject({ status: 'error' })
  })

  it('reports malformed replies and network failures as errors', async () => {
    expect(await client(scripted([{ body: {} }]).fetch).find(query)).toMatchObject({ status: 'error' })
    expect(await client(scripted([{ body: { ttml: '  ' } }]).fetch).find(query)).toMatchObject({ status: 'error' })
    expect(await client(scripted([new Error('offline')]).fetch).find(query)).toMatchObject({ status: 'error' })
  })

  it('does not ask with a placeholder artist', async () => {
    const s = scripted([])
    expect(await client(s.fetch).find({ ...query, artist: '   ' })).toEqual({ status: 'not-found' })
    expect(s.urls).toHaveLength(0)
  })
})

describe('LyricsService Better Lyrics integration', () => {
  function setup(opts: {
    provider?: 'auto' | 'betterlyrics'
    better?: () => Promise<BetterLyricsResult>
    lrclib?: () => Promise<FindResult>
  }) {
    const base = mkdtempSync(join(tmpdir(), 'tal-better-'))
    const betterFind = vi.fn(opts.better ?? (async (): Promise<BetterLyricsResult> => ({ status: 'not-found' })))
    const lrclibFind = vi.fn(opts.lrclib ?? (async (): Promise<FindResult> => ({ status: 'not-found' })))
    const state = { provider: opts.provider ?? 'auto' }

    const service = new LyricsService({
      local: new LocalLyrics(join(base, 'local')),
      cache: new LyricsCache(join(base, 'cache')),
      client: { find: lrclibFind } as unknown as LrclibClient,
      betterLyrics: { client: { find: betterFind } },
      log: () => {},
      provider: () => state.provider
    })
    return { service, betterFind, lrclibFind, state }
  }

  it('uses Better Lyrics in the automatic chain and caches its TTML', async () => {
    const s = setup({ better: async () => ({ status: 'found', ttml: TTML }) })

    const first = await s.service.get(query)
    expect(first).toMatchObject({ status: 'found', source: 'betterlyrics' })
    expect(first.lyrics?.wordTiming).toBe('native')
    expect(s.lrclibFind).not.toHaveBeenCalled()

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'cache' })
    expect(s.betterFind).toHaveBeenCalledTimes(1)
  })

  it('falls back to LRCLIB when Better Lyrics is not cached or unreachable', async () => {
    const s = setup({
      better: async () => ({ status: 'error', message: 'API key required (cache miss)' }),
      lrclib: async () => ({ status: 'found', record: record() })
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'lrclib' })
    expect(s.lrclibFind).toHaveBeenCalledTimes(1)
  })

  it('pins Better Lyrics without falling back and keeps its own cache slot', async () => {
    const s = setup({
      provider: 'betterlyrics',
      better: async () => ({ status: 'found', ttml: TTML }),
      lrclib: async () => ({ status: 'found', record: record() })
    })

    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'betterlyrics' })
    expect(await s.service.get(query)).toMatchObject({ status: 'found', source: 'betterlyrics' })
    expect(s.betterFind).toHaveBeenCalledTimes(1)
    expect(s.lrclibFind).not.toHaveBeenCalled()
  })
})
