import type { FetchLike } from './lrclib'
import { MIN_SCORE, scoreMatch, type SongMeta, type TrackQuery } from './match'
import { cleanTitle, primaryArtist } from './normalize'

export interface MusixmatchTrack {
  id: number
  title: string
  artist: string
  album: string
  durationSec: number
}

export type MusixmatchResult =
  | { status: 'found'; richsyncBody: unknown; track: MusixmatchTrack }
  /** No key in secrets.ts: say so and vanish, no request, no log. */
  | { status: 'bypass' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }

export interface MusixmatchOptions {
  apiKey: string
  fetch?: FetchLike
  timeoutMs?: number
  baseUrl?: string
  maxCandidates?: number
  userAgent?: string
}

/** Word timings only fit the exact recording, so its length must agree closely. */
const MAX_GAP_S = 3
/** Developer-tier calls are rate limited hard, so only the two best candidates get asked. */
const MAX_CANDIDATES = 2
/** Per-call cap so a slow Musixmatch cannot stall the fallback chain. */
const DEFAULT_TIMEOUT_MS = 3000
/** After a refusal or an outage, skip the provider for a while instead of burning quota. */
const COOLDOWN_MS = 60_000

type Reply =
  | { kind: 'ok'; body: Record<string, unknown> }
  /** 404: the recording simply has no such data; a lookup retry would not help. */
  | { kind: 'missing' }
  /** The key or plan refused the request (401/402/403/429…); other lookups may still work. */
  | { kind: 'rejected'; message: string }
  | { kind: 'error'; message: string }

type RichsyncAttempt =
  | { kind: 'found'; body: unknown; track: MusixmatchTrack }
  /** The search reply had no usable candidates; the query might win with one less field. */
  | { kind: 'no-candidates' }
  /** Candidates were asked and none carries richsync data; searching again is pointless. */
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const bodyOf = (body: Record<string, unknown>): Record<string, unknown> | null =>
  isRecord(body.message) && isRecord(body.message.body) ? body.message.body : null

/** `message.body.richsync.richsync_body` — the timed lines themselves. */
function readRichsyncBody(envelope: Record<string, unknown>): unknown | null {
  const richsync = bodyOf(envelope)?.richsync
  if (!isRecord(richsync) || !Array.isArray(richsync.richsync_body)) return null
  return richsync.richsync_body
}

interface Candidate {
  id: number
  meta: SongMeta
}

function toCandidates(reply: Record<string, unknown>): Candidate[] {
  const list = bodyOf(reply)?.track_list
  if (!Array.isArray(list)) return []
  const candidates: Candidate[] = []
  for (const item of list) {
    if (!isRecord(item) || !isRecord(item.track)) continue
    const track = item.track
    if (typeof track.track_id !== 'number') continue
    if (track.has_richsync === 0 || track.instrumental === 1) continue
    const title = typeof track.track_name === 'string' ? track.track_name : ''
    if (!title) continue
    candidates.push({
      id: track.track_id,
      meta: {
        title: track.track_name_version ? `${title} (${track.track_name_version})` : title,
        artist: typeof track.artist_name === 'string' ? track.artist_name : '',
        album: typeof track.album_name === 'string' && track.album_name ? track.album_name : null,
        // track_length is seconds; an absurd value says the field changed, so drop that
        // detail rather than trusting a wrong unit against every query duration.
        durationSec:
          typeof track.track_length === 'number' && track.track_length > 0 && track.track_length < 36_000
            ? track.track_length
            : 0
      }
    })
  }
  return candidates
}

/**
 * Musixmatch Pro API: word-by-word richsync payloads. The key comes from `secrets.ts`; with
 * none the provider bypasses silently. Recordings are found with `track.search` (scored the
 * same way as the other providers) and `track.richsync.get` then serves the timed lines.
 * Every call is capped at `timeoutMs`, nothing is retried, and 401/403/429/404 pass control
 * down the fallback chain instantly.
 */
export class MusixmatchProvider {
  private readonly apiKey: string
  private readonly fetch: FetchLike
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly maxCandidates: number
  private readonly userAgent: string
  /** While in the past, lookups answer bypass without a single request. */
  private cooldownUntil = 0

  constructor(opts: MusixmatchOptions) {
    this.apiKey = opts.apiKey.trim()
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.baseUrl = (opts.baseUrl ?? 'https://api.musixmatch.com/ws/1.1').replace(/\/$/, '')
    this.maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES
    this.userAgent = opts.userAgent ?? 'theaestheticslyrics'
  }

  async find(q: TrackQuery): Promise<MusixmatchResult> {
    if (!this.apiKey) return { status: 'bypass' }
    if (Date.now() < this.cooldownUntil) return { status: 'bypass' }

    let failure: string | null = null
    let answered = false
    for (const params of this.searches(q)) {
      const search = await this.get('track.search', params)
      if (search.kind === 'rejected') return this.refused(search.message)
      if (search.kind === 'error') {
        failure = search.message
        continue
      }
      if (search.kind !== 'ok') continue
      answered = true

      const attempt = await this.askRichsync(q, search.body)
      if (attempt.kind === 'found') return { status: 'found', richsyncBody: attempt.body, track: attempt.track }
      if (attempt.kind === 'error') return this.refused(attempt.message)
      // No usable candidates: widen the query and search once more. Candidates that were asked
      // and carry no richsync will not change either, so stop there.
      if (attempt.kind === 'no-candidates') continue
      break
    }
    if (failure && !answered) return this.refused(failure)
    return { status: 'not-found' }
  }

  /** Rejections and outages cool the provider down; the fallback chain answers meanwhile. */
  private refused(message: string): MusixmatchResult {
    this.cooldownUntil = Date.now() + COOLDOWN_MS
    return { status: 'error', message }
  }

  /** Title first (plus artist, or album when the player publishes no artist), then title alone. */
  private searches(q: TrackQuery): URLSearchParams[] {
    const base: Record<string, string> = {
      qtrack: cleanTitle(q.title),
      page_size: '10',
      s_track_rating: 'desc',
      format: 'json'
    }
    const artist = q.artist.trim() ? primaryArtist(q.artist) : ''
    const album = q.album.trim()
    // With neither artist nor album there is nothing to widen away from: search once.
    if (!artist && !album) return [new URLSearchParams(base)]
    const primary = artist ? { ...base, qartist: artist } : { ...base, qalbum: album }
    return [new URLSearchParams(primary), new URLSearchParams(base)]
  }

  /** Best-scoring candidates, in order, until one yields a richsync payload. */
  private async askRichsync(q: TrackQuery, searchReply: Record<string, unknown>): Promise<RichsyncAttempt> {
    const candidates = toCandidates(searchReply)
      .map((candidate) => ({ ...candidate, score: scoreMatch(q, candidate.meta, MAX_GAP_S) }))
      .filter((candidate) => candidate.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxCandidates)

    let failure: string | null = null
    for (const candidate of candidates) {
      const reply = await this.get('track.richsync.get', new URLSearchParams({ track_id: String(candidate.id) }))
      if (reply.kind === 'missing') continue
      if (reply.kind === 'rejected') return { kind: 'error', message: reply.message }
      if (reply.kind === 'error') {
        failure ??= reply.message
        continue
      }
      const richsyncBody = readRichsyncBody(reply.body)
      if (Array.isArray(richsyncBody) && richsyncBody.length) {
        const { title, artist, album, durationSec } = candidate.meta
        return {
          kind: 'found',
          body: richsyncBody,
          track: { id: candidate.id, title, artist, album: album ?? '', durationSec }
        }
      }
      failure ??= 'richsync payload unusable'
    }
    if (failure) return { kind: 'error', message: failure }
    return candidates.length ? { kind: 'missing' } : { kind: 'no-candidates' }
  }

  private async get(path: string, params: URLSearchParams): Promise<Reply> {
    const query = new URLSearchParams({ apikey: this.apiKey })
    for (const [key, value] of params) query.append(key, value)
    try {
      const res = await this.fetch(`${this.baseUrl}/${path}?${query}`, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (res.status === 404) return { kind: 'missing' }
      if (!res.ok) {
        // The service itself is sick (5xx) is a plain error; anything else is a refusal.
        return { kind: res.status >= 500 ? 'error' : 'rejected', message: `HTTP ${res.status}` }
      }
      const reply = await res.json().catch(() => null)
      if (!isRecord(reply) || !isRecord(reply.message)) return { kind: 'error', message: 'unreadable reply' }
      const code = isRecord(reply.message.header) ? reply.message.header.status_code : undefined
      if (typeof code === 'number' && code !== 200) {
        if (code === 404) return { kind: 'missing' }
        return { kind: code >= 500 ? 'error' : 'rejected', message: `api code ${code}` }
      }
      return { kind: 'ok', body: reply }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
