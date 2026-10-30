import type { TimedLyrics, TimedWord } from '@shared/types'
import type { ParsedLine } from './lrc'
import { buildTimedLyrics } from './word-timing'

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

  // Publisher drift lets a line's words overlap the next line's start. The renderer indexes
  // the flattened words with a binary search, so walk the sorted lines and push any word
  // that would start before the last placed word forward — timings agree within a few
  // milliseconds when payloads overlap; nothing else about them changes.
  lines.sort((a, b) => a.start - b.start)
  let floor = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const start = Math.max(line.start, floor)
    if (line.words) {
      let last = start
      const words = line.words.map((w) => {
        const wordStart = Math.max(w.start, last)
        const wordEnd = Math.max(w.end, wordStart)
        last = wordStart
        return { text: w.text, start: wordStart, end: wordEnd }
      })
      lines[i] = { ...line, start, end: line.end !== undefined ? Math.max(line.end, start) : undefined, words }
      floor = words[words.length - 1]!.start
    } else {
      lines[i] = { ...line, start, end: line.end !== undefined ? Math.max(line.end, start) : undefined }
      floor = start
    }
  }
  return lines
}

/** Parsed richsync → the exact `TimedLyrics` the renderer styles expect (native word timing). */
export function richsyncToTimedLyrics(body: unknown, durationMs = 0): TimedLyrics | null {
  const lines = parseRichsyncBody(body, durationMs)
  return lines ? buildTimedLyrics(lines, durationMs > 0 ? durationMs : undefined) : null
}
