import type { TimedLyrics, TimedWord } from '@shared/types'
import type { ParsedLine } from './lrc'
import { buildTimedLyrics, flattenOverlaps } from './word-timing'

/**
 * Musixmatch richsync (`/track.richsync.get`). All timestamps are Unix-style seconds kept in
 * two decimals (`6.37`); lines come as `{ ts, te, l, w: [{ w, ts, te }] }` in song order.
 * Developer keys truncate `richsync_body` mid-song, so parsing only maps what the payload
 * carries and lets the renderer idle once the words run out.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const toMs = (sec: unknown): number =>
  typeof sec === 'number' && Number.isFinite(sec) ? Math.max(0, Math.round(sec * 1000)) : NaN

/** Lines that would start this far past the player's own end are dead weight (metadata drift). */
const START_CAP_GRACE_MS = 1000

function toWords(raw: unknown): TimedWord[] {
  if (!Array.isArray(raw)) return []
  const words: TimedWord[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const start = toMs(item.ts)
    const end = toMs(item.te)
    const text = typeof item.w === 'string' ? item.w.trim() : ''
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue
    words.push({ text, start, end: Math.max(end, start) })
  }
  return words
}

/**
 * Maps a `message.body.richsync.richsync_body` array into the timeline's parsed-line form.
 * Returns null for anything unusable (wrong shape, no timed lines). `durationMs`, when the
 * player reports it, caps the array: lines starting past the song's end are dropped, and
 * every kept line keeps only the timings the payload itself carried — nothing is invented
 * to cover time the truncated payload does not mention.
 */
export function parseRichsyncBody(body: unknown, durationMs = 0): ParsedLine[] | null {
  if (!Array.isArray(body)) return null
  const capMs = durationMs > 0 ? durationMs + START_CAP_GRACE_MS : Number.POSITIVE_INFINITY
  const lines: ParsedLine[] = []

  for (const item of body) {
    if (!isRecord(item)) continue
    const rawStart = toMs(item.ts)
    if (!Number.isFinite(rawStart) || rawStart >= capMs) continue
    const timed = toWords(item.w)
    const text = typeof item.l === 'string' ? item.l.replace(/\s+/g, ' ').trim() : ''
    if (!text && !timed.length) continue
    const rawEnd = toMs(item.te)
    const realEnd = Number.isFinite(rawEnd) && rawEnd > rawStart ? rawEnd : undefined
    lines.push({
      start: rawStart,
      ...(realEnd !== undefined ? { end: realEnd } : {}),
      text: text || timed.map((w) => w.text).join(' '),
      ...(timed.length ? { words: timed } : {})
    })
  }
  if (!lines.length) return null

  // Overlapping word starts would break the renderer's binary search over the flattened
  // words; the shared pass floors each word at the last placed word's start.
  return flattenOverlaps(lines)
}

/** Parsed richsync → the exact `TimedLyrics` the renderer styles expect (native word timing). */
export function richsyncToTimedLyrics(body: unknown, durationMs = 0): TimedLyrics | null {
  const lines = parseRichsyncBody(body, durationMs)
  return lines ? buildTimedLyrics(lines, durationMs > 0 ? durationMs : undefined) : null
}
