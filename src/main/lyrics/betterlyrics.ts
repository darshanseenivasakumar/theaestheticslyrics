import type { TimedLyrics, TimedWord } from '@shared/types'
import type { FetchLike } from './lrclib'
import type { ParsedLine } from './lrc'
import type { TrackQuery } from './match'
import { cleanTitle, primaryArtist } from './normalize'
import { buildTimedLyrics, flattenOverlaps } from './word-timing'

/**
 * The Better Lyrics API (api.betterlyrics.org) serves Apple-Music-style TTML with
 * syllable-level timing. It is cache-first: cached songs need no key, a cache miss needs one.
 * Read-only lookups are therefore always safe to try — a 401 simply means "not cached" and
 * the service moves on to the next provider.
 *
 * Point BETTER_LYRICS_PROXY_URL at the bundled proxy (server/server.mjs) to keep a key on
 * the server and avoid any CORS questions from a browser frontend. Without it, requests go
 * straight to the API with BETTER_LYRICS_API_KEY (when set).
 */

export type BetterLyricsResult =
  | { status: 'found'; ttml: string; score?: number }
  | { status: 'not-found' }
  | { status: 'error'; message: string }

export interface BetterLyricsOptions {
  fetch?: FetchLike
  /** Per-call cap so a slow API can never stall the fallback chain. */
  timeoutMs?: number
  /** Local proxy origin, e.g. http://127.0.0.1:8787. Overridden by BETTER_LYRICS_PROXY_URL. */
  proxyUrl?: string
  /** Direct API base. Overridden by BETTER_LYRICS_API_URL. */
  baseUrl?: string
  /** Sent as X-API-Key on direct requests only. Overridden by BETTER_LYRICS_API_KEY. */
  apiKey?: string
  userAgent?: string
}

const DEFAULT_BASE_URL = 'https://api.betterlyrics.org'
const DEFAULT_TIMEOUT_MS = 5000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const envOrUndefined = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/* ---------------------------------------------------------------------------------------
 * TTML parsing
 * ------------------------------------------------------------------------------------- */

const P_TAG = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
const TAG = /<(\/?)\s*([A-Za-z][\w:.-]*)([^>]*)>/g
const BEGIN = /\bbegin\s*=\s*["']([^"']+)["']/i
const END = /\bend\s*=\s*["']([^"']+)["']/i
const BG_ROLE = /\brole\s*=\s*["']x-bg["']/i

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/**
 * TTML times are `HH:MM:SS.mmm`, `M:SS.mmm`, or plain seconds. Returns NaN when unusable.
 */
export function ttmlTimeToMs(value: string): number {
  const text = value.trim()
  if (!text) return Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)

  const parts = text.split(':')
  if (parts.length !== 2 && parts.length !== 3) return Number.NaN
  const seconds = Number(parts.at(-1))
  const minutes = Number(parts.at(-2))
  const hours = parts.length === 3 ? Number(parts[0]) : 0
  if (![seconds, minutes, hours].every(Number.isFinite)) return Number.NaN
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000)
}

function attrTime(attrs: string, pattern: RegExp): number {
  const match = pattern.exec(attrs)
  return match ? ttmlTimeToMs(match[1]!) : Number.NaN
}

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1).toLowerCase()

/**
 * Reads the leaf `<span begin end>` elements of one `<p>`, merging spans with no whitespace
 * between them (syllables such as `brand-` + `new`, or `romp` + `er`). Background-vocal
 * subtrees (`ttm:role="x-bg"`) are skipped: the overlay renders one vocal layer, and their
 * timings overlap the lead line.
 */
function parseSpanWords(inner: string): TimedWord[] {
  const words: TimedWord[] = []
  const stack: boolean[] = []
  let inBackground = false
  let word: TimedWord | null = null
  let cursor = 0

  const flush = (): void => {
    if (!word) return
    const text = word.text.replace(/\s+/g, ' ').trim()
    if (text) words.push({ ...word, text })
    word = null
  }

  const appendText = (raw: string): void => {
    if (inBackground || !raw) return
    for (const piece of decodeEntities(raw).split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) flush()
      else if (word) word.text += piece
    }
  }

  for (const match of inner.matchAll(TAG)) {
    appendText(inner.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const closing = match[1] === '/'
    const name = localName(match[2]!)
    if (name !== 'span') {
      if (name === 'br') flush()
      continue
    }

    if (closing) {
      stack.pop()
      inBackground = stack.at(-1) === true
      continue
    }

    const attrs = match[3] ?? ''
    const startsBackground = !inBackground && BG_ROLE.test(attrs)
    if (startsBackground) flush()
    const background = inBackground || BG_ROLE.test(attrs)
    stack.push(background)
    inBackground = background
    if (background) continue

    const start = attrTime(attrs, BEGIN)
    const end = attrTime(attrs, END)
    // A wrapper span without `begin` only groups other spans; it owns no word.
    if (!Number.isFinite(start)) continue

    if (word) {
      // No whitespace separated this span from the previous one: same word.
      const currentEnd = Number.isFinite(word.end) ? word.end : Number.NEGATIVE_INFINITY
      if (Number.isFinite(end)) word.end = Math.max(currentEnd, end)
    } else {
      word = { text: '', start, end }
    }
  }

  appendText(inner.slice(cursor))
  flush()
  return words
}

/**
 * Converts a TTML document into the timeline's parsed-line form. Returns null when the
 * document carries no timed words (plain lyrics, a broken reply, or an error page).
 */
export function parseTtmlLines(ttml: string): ParsedLine[] | null {
  if (typeof ttml !== 'string' || !ttml.includes('<p')) return null
  const lines: ParsedLine[] = []

  for (const match of ttml.matchAll(P_TAG)) {
    const attrs = match[1] ?? ''
    const words = parseSpanWords(match[2] ?? '')
    if (!words.length) continue

    const begin = attrTime(attrs, BEGIN)
    const end = attrTime(attrs, END)
    const start = Number.isFinite(begin) ? begin : words[0]!.start
    const lastEnd = words[words.length - 1]!.end
    const lineEnd = Number.isFinite(end) ? end : lastEnd
    const text = words
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue

    lines.push({
      start,
      ...(Number.isFinite(lineEnd) && lineEnd > start ? { end: lineEnd } : {}),
      text,
      words
    })
  }

  return lines.length ? flattenOverlaps(lines) : null
}

/** TTML → the exact `TimedLyrics` the renderer styles expect (native word timing). */
export function ttmlToTimedLyrics(ttml: string, durationMs = 0): TimedLyrics | null {
  const lines = parseTtmlLines(ttml)
  return lines ? buildTimedLyrics(lines, durationMs > 0 ? durationMs : undefined) : null
}

/* ---------------------------------------------------------------------------------------
 * API client
 * ------------------------------------------------------------------------------------- */

export class BetterLyricsClient {
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly userAgent: string
  /** The proxy exposes /api/lyrics; the upstream API exposes /getLyrics. */
  private readonly path: string

  constructor(opts: BetterLyricsOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = opts.userAgent ?? 'theaestheticslyrics'

    const proxy = (opts.proxyUrl ?? envOrUndefined('BETTER_LYRICS_PROXY_URL') ?? '').trim()
    const base = proxy || opts.baseUrl || envOrUndefined('BETTER_LYRICS_API_URL') || DEFAULT_BASE_URL
    this.baseUrl = base.replace(/\/$/, '')
    this.path = proxy ? '/api/lyrics' : '/getLyrics'
    // The proxy owns the key; never leak it to a process that is pointed at one.
    this.apiKey = proxy ? '' : (opts.apiKey ?? envOrUndefined('BETTER_LYRICS_API_KEY') ?? '').trim()
  }

  async find(q: TrackQuery): Promise<BetterLyricsResult> {
    // The API rejects only when both are missing, but a title/artist pair is what makes a
    // match trustworthy, so a placeholder credit is treated as "cannot ask".
    const song = cleanTitle(q.title).trim()
    const artist = primaryArtist(q.artist).trim()
    if (!song || !artist) return { status: 'not-found' }

    const params = new URLSearchParams({ song, artist })
    if (q.album.trim()) params.set('album', q.album.trim())
    if (q.durationMs > 0) params.set('duration', String(Math.round(q.durationMs / 1000)))

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent
    }
    if (this.apiKey) headers['X-API-Key'] = this.apiKey

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${this.path}?${params}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      })

      if (res.status === 404) return { status: 'not-found' }
      if (res.status === 401) return { status: 'error', message: 'API key required (cache miss)' }
      if (res.status === 422) return { status: 'error', message: 'invalid query' }
      if (res.status === 429) return { status: 'error', message: 'rate limited' }
      if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` }

      let body: unknown
      try {
        body = await res.json()
      } catch {
        return { status: 'error', message: 'unreadable reply' }
      }
      if (!isRecord(body) || typeof body.ttml !== 'string' || !body.ttml.trim()) {
        return { status: 'error', message: 'unreadable reply' }
      }
      return {
        status: 'found',
        ttml: body.ttml,
        ...(typeof body.score === 'number' ? { score: body.score } : {})
      }
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
