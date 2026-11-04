import type { TimedLyrics } from '@shared/types'
import type { LyricsProvider } from '../settings'
import type { BetterLyricsClient, BetterLyricsResult } from './betterlyrics'
import { ttmlToTimedLyrics } from './betterlyrics'
import { LyricsCache, cacheKey, providerCacheKey, type CacheEntry } from './cache'
import {
  hasKaraLyrWordTiming,
  karalyrToTimedLyrics,
  karalyrTrackToRecord,
  parseKaraLyrPayload,
  type KaraLyrClient,
  type KaraLyrResult
} from './karalyr'
import type { LocalLyrics } from './local'
import { parseLrc } from './lrc'
import type { FindResult, LrclibClient } from './lrclib'
import { parseLyricsfile } from './lyricsfile'
import type { LrclibRecord, TrackQuery } from './match'
import type { MusixmatchProvider, MusixmatchResult } from './musixmatch'
import type { NeteaseClient, NeteaseResult } from './netease'
import { cleanTitle, primaryArtist } from './normalize'
import { richsyncToTimedLyrics } from './richsync'
import { buildTimedLyrics } from './word-timing'
import { parseYrc } from './yrc'

export interface LyricsResult {
  status: 'found' | 'not-found' | 'instrumental' | 'error'
  lyrics: TimedLyrics | null
  source?: 'local' | 'cache' | 'lrclib' | 'netease' | 'musixmatch' | 'karalyr' | 'betterlyrics'
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
  /** Optional Karalyr provider: free word-timed karaoke payloads, asked before LRCLIB. */
  karalyr?: { client: Pick<KaraLyrClient, 'find'> }
  /** Optional Better Lyrics provider: syllable-timed TTML, asked after Karalyr. */
  betterLyrics?: { client: Pick<BetterLyricsClient, 'find'> }
  /** Optional source of real per-word timing (NetEase), consulted alongside LRCLIB. */
  wordLevel?: { client: Pick<NeteaseClient, 'find'>; enabled: () => boolean }
  /** Which source may answer a lookup; absent keeps the automatic fallback chain. */
  provider?: () => LyricsProvider
}

type ParsedJson = { ok: true; value: unknown } | { ok: false }

function parseCachedJson(text: string | undefined): ParsedJson {
  if (!text) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/**
 * Local `.lrc` → Musixmatch richsync (when configured in secrets.ts) → disk cache →
 * Karalyr (word-timed karaoke payloads, keyless) → Better Lyrics (syllable TTML, keyless for
 * cached songs) → LRCLIB (line timing) + NetEase (word timing, when enabled) in parallel.
 * Real word timing wins; errors are never cached, so the next play retries.
 *
 * When a provider is selected explicitly, only that source is asked. It also gets its own
 * cache slot, so switching providers cannot serve another source's cached lyrics.
 */
export class LyricsService {
  private readonly now: () => number

  constructor(private readonly deps: LyricsServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async get(q: TrackQuery): Promise<LyricsResult> {
    const provider = this.deps.provider?.() ?? 'auto'
    return provider === 'auto' ? this.getAuto(q) : this.getSelected(q, provider)
  }

  private async getAuto(q: TrackQuery): Promise<LyricsResult> {
    const local = await this.fromLocal(q)
    if (local) return local

    // Data handoff from Kodama: app-controller.lookup() passes the raw SMTC payload here as a
    // TrackQuery (title/artist straight from the media session), and every external provider
    // below receives exactly what this report prints — cleanTitle/primaryArtist are the same
    // deterministic functions musixmatch.ts, lrclib.ts and netease.ts run on these fields when
    // building each request, so "Remastered"/"feat."/"Live" noise never reaches a lyrics API.
    const sanitizedTitle: string = cleanTitle(q.title)
    const sanitizedArtist: string = primaryArtist(q.artist)
    console.log(`lyrics: requesting title "${sanitizedTitle}" artist "${sanitizedArtist}"`)

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

    const karalyr = this.deps.karalyr ? await this.fromKaralyr(q, key) : null
    if (karalyr) return karalyr

    const better = this.deps.betterLyrics ? await this.fromBetterLyrics(q, key) : null
    if (better) return better

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

  private async getSelected(q: TrackQuery, provider: Exclude<LyricsProvider, 'auto'>): Promise<LyricsResult> {
    if (provider === 'local') {
      const local = await this.fromLocal(q)
      return local ?? { status: 'not-found', lyrics: null, source: 'local' }
    }

    const key = providerCacheKey(q, provider)
    const cached = await this.deps.cache.get(key)
    if (cached) {
      const hit = this.fromProviderEntry(cached, q, provider)
      if (hit) return hit
    }

    switch (provider) {
      case 'musixmatch':
        return this.selectedMusixmatch(q, key)
      case 'karalyr':
        return this.selectedKaralyr(q, key)
      case 'betterlyrics':
        return this.selectedBetterLyrics(q, key)
      case 'lrclib':
        return this.selectedLrclib(q, key)
      case 'netease':
        return this.selectedNetease(q, key)
    }
    return { status: 'not-found', lyrics: null }
  }

  /** Cache hits in an explicit mode keep that provider as their source, not "cache". */
  private fromProviderEntry(
    entry: CacheEntry,
    q: TrackQuery,
    provider: Exclude<LyricsProvider, 'auto' | 'local'>
  ): LyricsResult | null {
    const source = provider
    if (entry.status === 'instrumental') return { status: 'instrumental', lyrics: null, source }
    if (entry.status === 'not-found') return { status: 'not-found', lyrics: null, source }

    switch (provider) {
      case 'lrclib': {
        if (!entry.record) return null
        const lyrics = recordToTimedLyrics(entry.record, q.durationMs)
        return lyrics ? { status: 'found', lyrics, source } : null
      }
      case 'karalyr': {
        // A Karalyr cache slot may hold either the structured karaoke payload or its
        // LRC-compatible fallback, but never another provider's answer.
        const payload = parseKaraLyrPayload(entry.karalyr)
        const lyrics = payload
          ? karalyrToTimedLyrics(payload, q.durationMs)
          : entry.record
            ? recordToTimedLyrics(entry.record, q.durationMs)
            : null
        return lyrics ? { status: 'found', lyrics, source } : null
      }
      case 'betterlyrics': {
        const lyrics = entry.betterlyrics ? ttmlToTimedLyrics(entry.betterlyrics, q.durationMs) : null
        return lyrics ? { status: 'found', lyrics, source } : null
      }
      case 'netease': {
        const lyrics = entry.yrc ? yrcToTimedLyrics(entry.yrc, q.durationMs) : null
        return lyrics ? { status: 'found', lyrics, source } : null
      }
      case 'musixmatch': {
        const body = parseCachedJson(entry.musixmatch)
        const lyrics = body.ok ? richsyncToTimedLyrics(body.value, q.durationMs) : null
        return lyrics ? { status: 'found', lyrics, source } : null
      }
    }
  }

  private async selectedLrclib(q: TrackQuery, key: string): Promise<LyricsResult> {
    let found: FindResult
    try {
      found = await this.deps.client.find(q)
    } catch (err) {
      this.deps.log(`lyrics: lrclib failed (${String(err)})`)
      return { status: 'error', lyrics: null, source: 'lrclib' }
    }
    if (found.status === 'error') {
      this.deps.log(`lyrics: lrclib error (${found.message})`)
      return { status: 'error', lyrics: null, source: 'lrclib' }
    }
    if (found.status === 'not-found') {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'lrclib' }
    }

    const { record } = found
    if (record.instrumental) {
      await this.save(key, { status: 'instrumental', record, fetchedAt: this.now() })
      return { status: 'instrumental', lyrics: null, source: 'lrclib' }
    }
    const lyrics = recordToTimedLyrics(record, q.durationMs)
    if (!lyrics) {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'lrclib' }
    }
    await this.save(key, { status: 'found', record, fetchedAt: this.now() })
    return { status: 'found', lyrics, source: 'lrclib' }
  }

  /** NetEase-only mode ignores the word-level toggle; choosing NetEase is the opt-in. */
  private async selectedNetease(q: TrackQuery, key: string): Promise<LyricsResult> {
    if (!this.deps.wordLevel) return { status: 'not-found', lyrics: null, source: 'netease' }
    const word = await this.findWords(q)
    if (word.status === 'error') return { status: 'error', lyrics: null, source: 'netease' }
    if (word.status === 'not-found') {
      await this.save(key, { status: 'not-found', wordChecked: true, fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'netease' }
    }

    const lyrics = yrcToTimedLyrics(word.yrc, q.durationMs)
    if (!lyrics) {
      await this.save(key, { status: 'not-found', wordChecked: true, fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'netease' }
    }
    await this.save(key, { status: 'found', yrc: word.yrc, wordChecked: true, fetchedAt: this.now() })
    return { status: 'found', lyrics, source: 'netease' }
  }

  /**
   * Musixmatch richsync: the only source whose word timing covers the song exactly as the
   * publisher cut it, so it jumps the cache in automatic mode. Missing key, refusals,
   * empty payloads — any of it just hands the song to the fallback chain.
   */
  private async askMusixmatch(q: TrackQuery): Promise<MusixmatchResult> {
    if (!this.deps.primary) return { status: 'bypass' }
    try {
      return await this.deps.primary.client.find(q)
    } catch (err) {
      this.deps.log(`lyrics: musixmatch failed (${String(err)})`)
      return { status: 'error', message: String(err) }
    }
  }

  private async fromMusixmatch(q: TrackQuery): Promise<LyricsResult | null> {
    if (!this.deps.primary) return null
    const found = await this.askMusixmatch(q)
    if (found.status === 'error') {
      this.deps.log(`lyrics: musixmatch unavailable (${found.message})`)
      return null
    }
    if (found.status !== 'found') return null
    return this.useMusixmatch(found, q)
  }

  private useMusixmatch(found: Extract<MusixmatchResult, { status: 'found' }>, q: TrackQuery): LyricsResult | null {
    const lyrics = richsyncToTimedLyrics(found.richsyncBody, q.durationMs)
    if (!lyrics) {
      // A service "found" reply needs the payload to round-trip; otherwise nothing to show.
      this.deps.log('lyrics: musixmatch payload unusable')
      return null
    }
    return { status: 'found', lyrics, source: 'musixmatch' }
  }

  private async selectedMusixmatch(q: TrackQuery, key: string): Promise<LyricsResult> {
    if (!this.deps.primary) return { status: 'not-found', lyrics: null, source: 'musixmatch' }
    const found = await this.askMusixmatch(q)
    if (found.status === 'bypass') {
      this.deps.log('lyrics: musixmatch unavailable (bypassed)')
      return { status: 'not-found', lyrics: null, source: 'musixmatch' }
    }
    if (found.status === 'error') {
      this.deps.log(`lyrics: musixmatch unavailable (${found.message})`)
      return { status: 'error', lyrics: null, source: 'musixmatch' }
    }
    if (found.status === 'not-found') {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'musixmatch' }
    }

    const result = this.useMusixmatch(found, q)
    if (!result) {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'musixmatch' }
    }
    const body = JSON.stringify(found.richsyncBody)
    if (typeof body === 'string') {
      await this.save(key, { status: 'found', musixmatch: body, fetchedAt: this.now() })
    }
    return result
  }

  /**
   * Karalyr: word-timed karaoke payloads, free and keyless. Asked after the cache (a stored
   * answer must win on repeats) and before LRCLIB/NetEase. Any miss, refusal or unusable
   * payload hands the song to the rest of the chain; nothing here throws outward and
   * failures are never cached, so the next play retries.
   */
  private async askKaralyr(q: TrackQuery): Promise<KaraLyrResult> {
    try {
      return await this.deps.karalyr!.client.find(q)
    } catch (err) {
      this.deps.log(`lyrics: karalyr failed (${String(err)})`)
      return { status: 'error', message: String(err) }
    }
  }

  private async fromKaralyr(q: TrackQuery, key: string): Promise<LyricsResult | null> {
    if (!this.deps.karalyr) return null
    const found = await this.askKaralyr(q)
    if (found.status === 'error') {
      this.deps.log(`lyrics: karalyr unavailable (${found.message})`)
      return null
    }
    if (found.status !== 'found') return null
    return this.useKaralyr(found, q, key)
  }

  private async useKaralyr(
    found: Extract<KaraLyrResult, { status: 'found' }>,
    q: TrackQuery,
    key: string
  ): Promise<LyricsResult | null> {
    const record = karalyrTrackToRecord(found.track)
    if (found.payload) {
      const lyrics = karalyrToTimedLyrics(found.payload, q.durationMs)
      if (lyrics) {
        // `wordChecked` settles the later NetEase upgrade: native word timing needs none.
        await this.save(key, {
          status: 'found',
          record,
          karalyr: JSON.stringify(found.payload),
          wordChecked: hasKaraLyrWordTiming(found.payload),
          fetchedAt: this.now()
        })
        return { status: 'found', lyrics, source: 'karalyr' }
      }
    }

    // No usable payload (or only the LRC-compatible fields): serve `syncedLyrics` through
    // the same Enhanced-LRC path the LRCLIB records take.
    const lyrics = recordToTimedLyrics(record, q.durationMs)
    if (!lyrics) {
      this.deps.log('lyrics: karalyr payload unusable')
      return null
    }
    await this.save(key, { status: 'found', record, wordChecked: false, fetchedAt: this.now() })
    return { status: 'found', lyrics, source: 'karalyr' }
  }

  private async selectedKaralyr(q: TrackQuery, key: string): Promise<LyricsResult> {
    if (!this.deps.karalyr) return { status: 'not-found', lyrics: null, source: 'karalyr' }
    const found = await this.askKaralyr(q)
    if (found.status === 'error') {
      this.deps.log(`lyrics: karalyr unavailable (${found.message})`)
      return { status: 'error', lyrics: null, source: 'karalyr' }
    }
    if (found.status !== 'found') {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'karalyr' }
    }

    const result = await this.useKaralyr(found, q, key)
    if (!result) await this.save(key, { status: 'not-found', fetchedAt: this.now() })
    return result ?? { status: 'not-found', lyrics: null, source: 'karalyr' }
  }

  /**
   * Better Lyrics: syllable-level TTML. The API is cache-first, so a keyless request still
   * answers for songs it has seen before; a 401 means this song is not cached and simply
   * hands the song to LRCLIB/NetEase. Failures are never cached, so the next play retries.
   */
  private async askBetterLyrics(q: TrackQuery): Promise<BetterLyricsResult> {
    try {
      return await this.deps.betterLyrics!.client.find(q)
    } catch (err) {
      this.deps.log(`lyrics: betterlyrics failed (${String(err)})`)
      return { status: 'error', message: String(err) }
    }
  }

  private async fromBetterLyrics(q: TrackQuery, key: string): Promise<LyricsResult | null> {
    if (!this.deps.betterLyrics) return null
    const found = await this.askBetterLyrics(q)
    if (found.status === 'error') {
      this.deps.log(`lyrics: betterlyrics unavailable (${found.message})`)
      return null
    }
    if (found.status !== 'found') return null
    return this.useBetterLyrics(found, q, key)
  }

  private async useBetterLyrics(
    found: Extract<BetterLyricsResult, { status: 'found' }>,
    q: TrackQuery,
    key: string
  ): Promise<LyricsResult | null> {
    const lyrics = ttmlToTimedLyrics(found.ttml, q.durationMs)
    if (!lyrics) {
      this.deps.log('lyrics: betterlyrics payload unusable')
      return null
    }
    // Native syllable timing needs no NetEase upgrade.
    await this.save(key, { status: 'found', betterlyrics: found.ttml, wordChecked: true, fetchedAt: this.now() })
    return { status: 'found', lyrics, source: 'betterlyrics' }
  }

  private async selectedBetterLyrics(q: TrackQuery, key: string): Promise<LyricsResult> {
    if (!this.deps.betterLyrics) return { status: 'not-found', lyrics: null, source: 'betterlyrics' }
    const found = await this.askBetterLyrics(q)
    if (found.status === 'error') {
      this.deps.log(`lyrics: betterlyrics unavailable (${found.message})`)
      return { status: 'error', lyrics: null, source: 'betterlyrics' }
    }
    if (found.status !== 'found') {
      await this.save(key, { status: 'not-found', fetchedAt: this.now() })
      return { status: 'not-found', lyrics: null, source: 'betterlyrics' }
    }

    const result = await this.useBetterLyrics(found, q, key)
    if (!result) await this.save(key, { status: 'not-found', fetchedAt: this.now() })
    return result ?? { status: 'not-found', lyrics: null, source: 'betterlyrics' }
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
    // Karalyr payloads carry the publisher's own word timing, so the word-level toggle (a
    // NetEase switch) does not gate them; they beat the line-level LRCLIB record below.
    const karalyr = parseKaraLyrPayload(entry.karalyr)
    if (karalyr) {
      const lyrics = karalyrToTimedLyrics(karalyr, q.durationMs)
      if (lyrics) return { status: 'found', lyrics, source }
    }
    if (entry.betterlyrics) {
      const lyrics = ttmlToTimedLyrics(entry.betterlyrics, q.durationMs)
      if (lyrics) return { status: 'found', lyrics, source }
    }
    if (entry.status === 'instrumental') return { status: 'instrumental', lyrics: null, source }
    const lyrics = entry.status === 'found' && entry.record ? recordToTimedLyrics(entry.record, q.durationMs) : null
    return lyrics ? { status: 'found', lyrics, source } : { status: 'not-found', lyrics: null, source }
  }
}
