import type { TimedLyrics } from '@shared/types'
import { LyricsCache, cacheKey, type CacheEntry } from './cache'
import type { LocalLyrics } from './local'
import { parseLrc } from './lrc'
import type { LrclibClient } from './lrclib'
import { parseLyricsfile } from './lyricsfile'
import type { LrclibRecord, TrackQuery } from './match'
import type { MusixmatchProvider, MusixmatchResult } from './musixmatch'
import type { NeteaseClient, NeteaseResult } from './netease'
import { richsyncToTimedLyrics } from './richsync'
import { buildTimedLyrics } from './word-timing'
import { parseYrc } from './yrc'

export interface LyricsResult {
  status: 'found' | 'not-found' | 'instrumental' | 'error'
  lyrics: TimedLyrics | null
  source?: 'local' | 'cache' | 'lrclib' | 'netease' | 'musixmatch'
}

const durationOrUndefined = (ms: number): number | undefined => (ms > 0 ? ms : undefined)

/** Prefers the `lyricsfile` (it may carry real line ends or word timing), then LRC. */
export function recordToTimedLyrics(r: LrclibRecord, durationMs: number): TimedLyrics | null {
  const duration = durationMs > 0 ? durationMs : r.duration > 0 ? Math.round(r.duration * 1000) : undefined
  if (r.lyricsfile) {
    const lines = parseLyricsfile(r.lyricsfile)
    const timed = lines && buildTimedLyrics(lines, duration)
    if (timed) return timed
  }
  return r.syncedLyrics ? buildTimedLyrics(parseLrc(r.syncedLyrics), duration) : null
}

export function yrcToTimedLyrics(yrc: string, durationMs: number): TimedLyrics | null {
  const lines = parseYrc(yrc)
  return lines ? buildTimedLyrics(lines, durationOrUndefined(durationMs)) : null
}

export interface LyricsServiceDeps {
  local: LocalLyrics
  cache: LyricsCache
  client: LrclibClient
  log: (message: string) => void
  now?: () => number
  /** Optional Musixmatch richsync provider, the first source asked outside local files. */
  primary?: { client: Pick<MusixmatchProvider, 'find'> }
  /** Optional source of real per-word timing (NetEase), consulted alongside LRCLIB. */
  wordLevel?: { client: Pick<NeteaseClient, 'find'>; enabled: () => boolean }
}

/**
 * Local `.lrc` → Musixmatch richsync (when configured in secrets.ts) → disk cache → network.
 * On the network, LRCLIB (line timing) and NetEase (word timing, when enabled) are asked in
 * parallel and real word timing wins. Errors are never cached, so the next play retries.
 */
export class LyricsService {
  private readonly now: () => number

  constructor(private readonly deps: LyricsServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async get(q: TrackQuery): Promise<LyricsResult> {
    const local = await this.fromLocal(q)
    if (local) return local

    // The has-key / has-Payload checks live inside the provider; missing or rejected is never
    // an error to surface — the song simply continues on the usual local/cache/network chain.
    const musixmatch = this.deps.primary ? await this.fromMusixmatch(q) : null
    if (musixmatch) return musixmatch

    const useWords = this.deps.wordLevel?.enabled() ?? false
    const key = cacheKey(q)
    const cached = await this.deps.cache.get(key)
    if (cached) {
      if (useWords && !cached.yrc && !cached.wordChecked) {
        // Cached before word timing was available (or NetEase failed last time): ask once.
        const upgraded = await this.askWordLevel(q, key, cached)
        if (upgraded) return upgraded
      }
      return this.fromEntry(cached, q, 'cache', useWords)
    }

    const [line, word] = await Promise.all([
      this.deps.client.find(q),
      useWords ? this.findWords(q) : Promise.resolve<NeteaseResult | null>(null)
    ])

    const wordLyrics = word?.status === 'found' ? yrcToTimedLyrics(word.yrc, q.durationMs) : null
    const wordChecked = word !== null && word.status !== 'error'

    if (wordLyrics && word?.status === 'found') {
      const entry: CacheEntry = {
        status: 'found',
        ...(line.status === 'found' ? { record: line.record } : {}),
        yrc: word.yrc,
        wordChecked: true,
        fetchedAt: this.now()
      }
      await this.save(key, entry)
      return { status: 'found', lyrics: wordLyrics, source: 'netease' }
    }

    if (line.status === 'error') {
      this.deps.log(`lyrics: lrclib error (${line.message})`)
      return { status: 'error', lyrics: null }
    }

    let entry: CacheEntry
    if (line.status === 'not-found') entry = { status: 'not-found', wordChecked, fetchedAt: this.now() }
    else if (line.record.instrumental) entry = { status: 'instrumental', record: line.record, wordChecked, fetchedAt: this.now() }
    else if (!recordToTimedLyrics(line.record, q.durationMs)) entry = { status: 'not-found', wordChecked, fetchedAt: this.now() }
    else entry = { status: 'found', record: line.record, wordChecked, fetchedAt: this.now() }

    await this.save(key, entry)
    return this.fromEntry(entry, q, 'lrclib', useWords)
  }

  /**
   * Musixmatch richsync: the only source whose word timing covers the song exactly as the
   * publisher cut it, so it jumps the cache. Missing key, refusals, empty payloads — any of
   * it just hands the song to the fallback chain; nothing here throws outward.
   */
  private async fromMusixmatch(q: TrackQuery): Promise<LyricsResult | null> {
    let found: MusixmatchResult
    try {
      found = await this.deps.primary!.client.find(q)
    } catch (err) {
      this.deps.log(`lyrics: musixmatch failed (${String(err)})`)
      return null
    }
    if (found.status === 'error') this.deps.log(`lyrics: musixmatch unavailable (${found.message})`)
    if (found.status !== 'found') return null
    const lyrics = richsyncToTimedLyrics(found.richsyncBody, q.durationMs)
    if (!lyrics) {
      // A service "found" reply needs the payload to round-trip; otherwise just fall through.
      this.deps.log('lyrics: musixmatch payload unusable')
      return null
    }
    return { status: 'found', lyrics, source: 'musixmatch' }
  }

  private async findWords(q: TrackQuery): Promise<NeteaseResult> {
    try {
      const result = await this.deps.wordLevel!.client.find(q)
      if (result.status === 'error') this.deps.log(`lyrics: netease unavailable (${result.message})`)
      return result
    } catch (err) {
      this.deps.log(`lyrics: netease failed (${String(err)})`)
      return { status: 'error', message: String(err) }
    }
  }

  private async askWordLevel(q: TrackQuery, key: string, cached: CacheEntry): Promise<LyricsResult | null> {
    const word = await this.findWords(q)
    if (word.status === 'error') return null
    if (word.status === 'found') {
      const lyrics = yrcToTimedLyrics(word.yrc, q.durationMs)
      if (lyrics) {
        await this.save(key, { ...cached, status: 'found', yrc: word.yrc, wordChecked: true })
        return { status: 'found', lyrics, source: 'netease' }
      }
    }
    await this.save(key, { ...cached, wordChecked: true })
    return null
  }

  private async save(key: string, entry: CacheEntry): Promise<void> {
    await this.deps.cache.set(key, entry).catch((err: unknown) => this.deps.log(`lyrics: cache write failed (${String(err)})`))
  }

  private async fromLocal(q: TrackQuery): Promise<LyricsResult | null> {
    try {
      const text = await this.deps.local.find(q)
      if (!text) return null
      const lyrics = buildTimedLyrics(parseLrc(text), durationOrUndefined(q.durationMs))
      if (lyrics) return { status: 'found', lyrics, source: 'local' }
      this.deps.log('lyrics: local file had no timed lines, ignoring it')
    } catch (err) {
      this.deps.log(`lyrics: local lookup failed (${String(err)})`)
    }
    return null
  }

  private fromEntry(entry: CacheEntry, q: TrackQuery, source: 'cache' | 'lrclib', useWords: boolean): LyricsResult {
    if (useWords && entry.yrc) {
      const lyrics = yrcToTimedLyrics(entry.yrc, q.durationMs)
      if (lyrics) return { status: 'found', lyrics, source }
    }
    if (entry.status === 'instrumental') return { status: 'instrumental', lyrics: null, source }
    const lyrics = entry.status === 'found' && entry.record ? recordToTimedLyrics(entry.record, q.durationMs) : null
    return lyrics ? { status: 'found', lyrics, source } : { status: 'not-found', lyrics: null, source }
  }
}
