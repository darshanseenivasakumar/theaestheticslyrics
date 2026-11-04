import type { TimedLyrics, TimedWord } from '@shared/types'
import type { FetchLike } from './lrclib'
import type { ParsedLine } from './lrc'
import type { LrclibRecord, TrackQuery } from './match'
import { cleanTitle, normalizeForMatch, primaryArtist } from './normalize'
import { buildTimedLyrics, flattenOverlaps } from './word-timing'

/**
 * Karalyr (karalyr.com) is the open karaoke lyrics database. Its public API is
 * LRCLIB-compatible — the same `/api/get` fields, swap the base URL — and carries the
 * karaoke detail in an extra `karalyr` object: a structured payload whose lines and words
 * are timed in integer milliseconds. Publishing rejects line-level lyrics, so a served
 * revision is effectively always word-timed; `syncedLyrics` (Enhanced LRC) rides along for
 * clients that cannot read the payload.
 *
 * A miss is a 404 and stays a miss ("a track we do not have will not appear by asking
 * again"), so requests are never retried after a refusal: any miss, refusal or timeout hands
 * the song to LRCLIB, exactly as the service's fallback chain expects. The read routes allow
 * 600 requests per 5 minutes per IP and a 429 arrives with `Retry-After`; one song asks at
 * most three times (strict title, widened, then the untouched title), so the budget is never
 * near.
 */

/** Sub-word timing, present only when a word actually splits (UltraStar imports, the aligner). */
export interface KaraLyrSyllable {
  text: string
  /** Integer milliseconds of song time. */
  start_ms: number
  end_ms: number
}

export interface KaraLyrWord {
  text: string
  /** Integer milliseconds of song time. */
  start_ms: number
  end_ms: number
  /** Syllable texts concatenate to the word's text. */
  syllables?: KaraLyrSyllable[]
}

export interface KaraLyrLine {
  start_ms: number
  end_ms: number
  /** Duet singers; the overlay renders one vocal layer, so this is carried but not styled. */
  singer: 'P1' | 'P2' | 'BOTH' | null
  text: string
  words?: KaraLyrWord[]
}

export interface KaraLyrPayload {
  format_version: 1
  lines: KaraLyrLine[]
  meta: {
    language: string | null
    has_word_timing: boolean
    /** Indices into `lines` that mark the pre-song countdown. */
    countdown_lines: number[]
  }
}

/** `auto_aligned < community < verified`; the API serves the best active revision. */
export type KaraLyrTier = 'auto_aligned' | 'community' | 'verified'

/** The `LrclibRecord`-shaped half of the reply; a plain LRCLIB client reads only this. */
export interface KaraLyrTrack {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  /** Seconds. */
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export interface KaraLyrResponse extends KaraLyrTrack {
  karalyr?: {
    payload: KaraLyrPayload
    tier: KaraLyrTier
    source: string
    revision_id: number
    has_word_timing: boolean
    has_chords: boolean
  }
}

export type KaraLyrResult =
  | { status: 'found'; track: KaraLyrTrack; payload: KaraLyrPayload | null }
  | { status: 'not-found' }
  | { status: 'error'; message: string }

export interface KaraLyrOptions {
  fetch?: FetchLike
  /** Per-call cap so a slow Karalyr can never stall the fallback chain. */
  timeoutMs?: number
  /** Overridable with `KARALYR_API_URL` (self-hosting the open API is the use case). */
  baseUrl?: string
  /** Optional; the public API needs none. Overridden by `KARALYR_API_KEY`. */
  apiKey?: string
  /** Sent as `User-Agent` and as the `X-Karalyr-Client` traffic tag the docs ask for. */
  userAgent?: string
}

const DEFAULT_BASE_URL = 'https://karalyr.com'
const DEFAULT_TIMEOUT_MS = 4500
/** Word timings only fit the exact recording, so its length must agree closely. */
const DURATION_GAP_S = 3
/** Media sessions use these when the player did not publish a real artist. */
const PLACEHOLDER_ARTIST = /^(?:unknown(?: artist)?|no artist|various artists)$/i
/** Lines that would start this far past the player's own end are dead weight (metadata drift). */
const START_CAP_GRACE_MS = 1000

type Reply = { kind: 'ok'; body: unknown } | { kind: 'missing' } | { kind: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Milliseconds, floored at zero; NaN when the field is absent or not a number. */
const msOrNaN = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : Number.NaN

const envOrUndefined = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function readSinger(v: unknown): KaraLyrLine['singer'] {
  return v === 'P1' || v === 'P2' || v === 'BOTH' ? v : null
}

function readSyllables(raw: unknown): KaraLyrSyllable[] | null {
  if (!Array.isArray(raw)) return null
  const syllables: KaraLyrSyllable[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== 'string') continue
    const start = msOrNaN(item.start_ms)
    const end = msOrNaN(item.end_ms)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    syllables.push({ text: item.text, start_ms: start, end_ms: end })
  }
  return syllables.length ? syllables : null
}

function readWords(raw: unknown): KaraLyrWord[] | null {
  if (!Array.isArray(raw)) return null
  const words: KaraLyrWord[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== 'string') continue
    const start = msOrNaN(item.start_ms)
    const end = msOrNaN(item.end_ms)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const syllables = readSyllables(item.syllables)
    words.push({ text: item.text, start_ms: start, end_ms: end, ...(syllables ? { syllables } : {}) })
  }
  return words.length ? words : null
}

/**
 * Validates `karalyr.payload` from an untrusted reply. `format_version` is part of the
 * published contract, so a different number means the shape below is no longer trustworthy
 * and the caller should fall back to `syncedLyrics`/LRCLIB instead of guessing.
 */
function readPayload(v: unknown): KaraLyrPayload | null {
  if (!isRecord(v) || v.format_version !== 1 || !Array.isArray(v.lines)) return null
  const lines: KaraLyrLine[] = []
  for (const item of v.lines) {
    if (!isRecord(item)) continue
    const start = msOrNaN(item.start_ms)
    const end = msOrNaN(item.end_ms)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const words = readWords(item.words)
    lines.push({
      start_ms: start,
      end_ms: end,
      singer: readSinger(item.singer),
      text: typeof item.text === 'string' ? item.text : '',
      ...(words ? { words } : {})
    })
  }
  if (!lines.length) return null
  const meta = isRecord(v.meta) ? v.meta : {}
  return {
    format_version: 1,
    lines,
    meta: {
      language: typeof meta.language === 'string' ? meta.language : null,
      has_word_timing: meta.has_word_timing === true,
      countdown_lines: Array.isArray(meta.countdown_lines)
        ? meta.countdown_lines.filter((n): n is number => typeof n === 'number')
        : []
    }
  }
}

/** Parses a payload previously cached as JSON; null for anything no longer valid. */
export function parseKaraLyrPayload(text: string | undefined): KaraLyrPayload | null {
  if (!text) return null
  try {
    return readPayload(JSON.parse(text))
  } catch {
    return null
  }
}

/** What the reply can deliver: sub-word timing → `syllable`, timed lines → `line`, else `plain`. */
export function karalyrSyncType(payload: KaraLyrPayload | null): 'syllable' | 'line' | 'plain' {
  if (!payload || !payload.lines.length) return 'plain'
  for (const line of payload.lines) {
    for (const word of line.words ?? []) {
      if (word.syllables?.length) return 'syllable'
    }
  }
  return 'line'
}

/**
 * Whether every line carries per-word timing — the same bar `buildTimedLyrics` uses for
 * `wordTiming: 'native'`, so a partial payload is still eligible for a NetEase upgrade.
 */
export function hasKaraLyrWordTiming(payload: KaraLyrPayload | null): boolean {
  return !!payload && payload.lines.length > 0 && payload.lines.every((line) => (line.words?.length ?? 0) > 0)
}

/** The payload word's own span, refined by its syllables when it splits. */
function wordSpan(word: KaraLyrWord): { start: number; end: number } {
  const syllables = word.syllables
  const first = syllables?.[0]
  const last = syllables?.[syllables.length - 1]
  if (first && last && syllables!.length > 1) {
    const start = Math.min(first.start_ms, word.start_ms)
    const end = Math.max(last.end_ms, word.end_ms)
    if (end >= start) return { start, end }
  }
  return { start: word.start_ms, end: word.end_ms }
}

/**
 * Maps a `karalyr.payload` into the timeline's parsed-line form. `durationMs`, when the
 * player reports it, caps the array: lines starting past the song's end are dropped, and
 * every kept line keeps only the timings the payload itself carried. Words that overlap
 * the next line are floored like every other karaoke source so the renderer's binary
 * search over the flattened words stays correct.
 */
export function payloadToParsedLines(payload: KaraLyrPayload, durationMs = 0): ParsedLine[] | null {
  const capMs = durationMs > 0 ? durationMs + START_CAP_GRACE_MS : Number.POSITIVE_INFINITY
  const lines: ParsedLine[] = []
  for (const line of payload.lines) {
    if (line.start_ms >= capMs) continue
    const text = line.text.replace(/\s+/g, ' ').trim()
    const words: TimedWord[] = []
    for (const word of line.words ?? []) {
      const wordText = word.text.trim()
      if (!wordText) continue
      const span = wordSpan(word)
      words.push({ text: wordText, start: span.start, end: Math.max(span.end, span.start) })
    }
    if (!text && !words.length) continue
    lines.push({
      start: line.start_ms,
      ...(line.end_ms > line.start_ms ? { end: line.end_ms } : {}),
      text: text || words.map((w) => w.text).join(' '),
      ...(words.length ? { words } : {})
    })
  }
  return lines.length ? flattenOverlaps(lines) : null
}

/** Payload → the exact `TimedLyrics` the renderer styles expect (native word timing). */
export function karalyrToTimedLyrics(payload: KaraLyrPayload, durationMs = 0): TimedLyrics | null {
  const lines = payloadToParsedLines(payload, durationMs)
  return lines ? buildTimedLyrics(lines, durationMs > 0 ? durationMs : undefined) : null
}

/** The reply's LRCLIB-shaped fields, in the record form the cache and LRCLIB path share. */
export function karalyrTrackToRecord(track: KaraLyrTrack): LrclibRecord {
  return {
    id: track.id,
    trackName: track.trackName,
    artistName: track.artistName,
    albumName: track.albumName,
    duration: track.duration,
    instrumental: track.instrumental,
    plainLyrics: track.plainLyrics,
    syncedLyrics: track.syncedLyrics,
    lyricsfile: null
  }
}

/**
 * Reads the LRCLIB-compatible envelope. Anything without the three identifying fields is
 * unusable; the karaoke object is optional so a plain LRCLIB-shaped reply still serves
 * via `syncedLyrics`.
 */
function readResponse(v: unknown): { track: KaraLyrTrack; payload: KaraLyrPayload | null } | null {
  if (!isRecord(v)) return null
  if (typeof v.id !== 'number' || typeof v.trackName !== 'string' || typeof v.artistName !== 'string') return null
  const duration = typeof v.duration === 'number' && v.duration >= 0 ? v.duration : 0
  const track: KaraLyrTrack = {
    id: v.id,
    trackName: v.trackName,
    artistName: v.artistName,
    albumName: strOrNull(v.albumName),
    duration,
    instrumental: v.instrumental === true,
    plainLyrics: strOrNull(v.plainLyrics),
    syncedLyrics: strOrNull(v.syncedLyrics)
  }
  const karalyr = isRecord(v.karalyr) ? v.karalyr : null
  const payload = karalyr ? readPayload(karalyr.payload) : null
  return { track, payload }
}

/**
 * Karalyr titles are catalogued without uploader noise. Strip the release noise the shared
 * normalizer already knows, then every remaining bracketed aside ("(Official Video)",
 * "[2011 Remaster]", "(From the Film)") so the exact-match GET is built from the bare title.
 * Returns '' when nothing but noise is left, which callers treat as "no query".
 */
export function sanitizeKaralyrTitle(title: string): string {
  return cleanTitle(title)
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const normalizedTokens = (text: string): string[] => {
  const tokens = normalizeForMatch(text).split(' ').filter(Boolean)
  // A leading article is noise for matching ("The Paper Lanterns" ≡ "Paper Lanterns").
  return tokens.length > 1 && (tokens[0] === 'the' || tokens[0] === 'a' || tokens[0] === 'an')
    ? tokens.slice(1)
    : tokens
}

/** Case/accent/punctuation/article-insensitive equality; no fuzzy-matching dependency. */
const sameText = (requested: string, returned: string): boolean => {
  const a = normalizedTokens(requested)
  const b = normalizedTokens(returned)
  return a.length > 0 && a.join(' ') === b.join(' ')
}

/**
 * The reply must be the recorded song, not merely a plausible search hit. The title is
 * compared after release-noise stripping (so "Paper Lanterns (Remastered)" matches "Paper
 * Lanterns") but meaningful asides are kept: "Time (Clock of the Heart)" does not match a
 * different track called "Time", and "(Remix)" does not match the base title.
 * Artists are compared on their primary credit. Unknown lengths never disqualify a match;
 * known ones must agree within three seconds.
 */
export function isSameRecording(
  q: TrackQuery,
  track: Pick<KaraLyrTrack, 'trackName' | 'artistName' | 'duration'>
): boolean {
  if (!sameText(cleanTitle(q.title), cleanTitle(track.trackName))) return false
  if (!sameText(primaryArtist(q.artist), primaryArtist(track.artistName))) return false
  if (q.durationMs <= 0 || track.duration <= 0) return true
  return Math.abs(q.durationMs / 1000 - track.duration) <= DURATION_GAP_S
}

interface SanitizedQuery {
  title: string
  artist: string
}

/** Both fields are mandatory for `/api/get`; placeholder metadata means "do not ask". */
function sanitizeQuery(q: TrackQuery): SanitizedQuery | null {
  const title = sanitizeKaralyrTitle(q.title)
  const artist = primaryArtist(q.artist).trim()
  if (!title || !artist || PLACEHOLDER_ARTIST.test(artist)) return null
  return { title, artist }
}

/**
 * Karalyr: free, keyless, word-timed karaoke payloads. `/api/get` is exact-match keyed, so
 * the query requires both a sanitized title and artist (placeholder credits never ask),
 * narrows by album/duration when known, and retries with the untouched title when brackets
 * may be part of the song name. Every reply is verified against the requested title, artist
 * and length before it can be served: a different song is treated as a miss, so the service
 * cascades to LRCLIB instead of showing the wrong words. 429/5xx/timeouts return `error`
 * without caching, so the next play retries.
 */
export class KaraLyrClient {
  private readonly fetch: FetchLike
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly userAgent: string

  constructor(opts: KaraLyrOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = (opts.baseUrl ?? envOrUndefined('KARALYR_API_URL') ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = (opts.apiKey ?? envOrUndefined('KARALYR_API_KEY') ?? '').trim()
    this.userAgent = opts.userAgent ?? 'theaestheticslyrics'
  }

  async find(q: TrackQuery): Promise<KaraLyrResult> {
    // `/api/get` requires both fields; this provider never guesses from one of them. A
    // player with no real artist leaves the song to LRCLIB's title/album lookup.
    const requested = sanitizeQuery(q)
    if (!requested) return { status: 'not-found' }

    let failure: string | null = null
    for (const params of this.searches(q, requested)) {
      const reply = await this.get(params)
      if (reply.kind === 'missing') continue
      if (reply.kind === 'error') return { status: 'error', message: reply.message }
      const found = readResponse(reply.body)
      if (!found) {
        failure = 'unreadable reply'
        continue
      }
      const { track, payload } = found
      // A reply that is not this recording is treated exactly like a 404: fall through
      // (and eventually cascade) instead of showing another song's words.
      if (!isSameRecording(q, track)) continue
      if (!payload && !track.syncedLyrics?.trim()) continue
      return { status: 'found', track, payload }
    }
    return failure ? { status: 'error', message: failure } : { status: 'not-found' }
  }

  /**
   * Strict title first (narrowed by album and duration); then the same title without those
   * filters, since catalogue metadata often differs; then the untouched title, for songs
   * whose parentheses are part of the name. Duplicate steps are skipped.
   */
  private searches(q: TrackQuery, requested: SanitizedQuery): URLSearchParams[] {
    const make = (title: string): URLSearchParams =>
      new URLSearchParams({ artist_name: requested.artist, track_name: title })
    const exact = make(requested.title)
    if (q.album.trim()) exact.set('album_name', q.album.trim())
    if (q.durationMs > 0) exact.set('duration', String(Math.round(q.durationMs / 1000)))

    const attempts = [exact]
    const widened = make(requested.title)
    if (widened.toString() !== exact.toString()) attempts.push(widened)
    const untouched = cleanTitle(q.title)
    if (untouched && untouched !== requested.title) attempts.push(make(untouched))
    return attempts
  }

  private async get(params: URLSearchParams): Promise<Reply> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'X-Karalyr-Client': this.userAgent,
      Accept: 'application/json'
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    try {
      const res = await this.fetch(`${this.baseUrl}/api/get?${params}`, {
        headers,
        // 429 and 5xx land together here: the chain gets the song now, and the next play retries.
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (res.status === 404) return { kind: 'missing' }
      if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` }
      return { kind: 'ok', body: await res.json().catch(() => null) }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
