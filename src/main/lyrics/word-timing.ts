import type { TimedLine, TimedLyrics, TimedWord } from '@shared/types'
import type { ParsedLine } from './lrc'
import { countSyllables, tokenizeLine, type Token } from './tokenize'

/** Ends within this distance of the next start are just "next line starts here", not a real end. */
const SAME_TIME_MS = 60
/** Fallback singing pace when a song gives nothing to measure. */
const DEFAULT_MS_PER_SYLLABLE = 420
const MIN_MS_PER_SYLLABLE = 220
const MAX_MS_PER_SYLLABLE = 1000
/** Lines may run this much slower than the song's median pace before they are capped. */
const PACE_TOLERANCE = 1.5
const CAP_PADDING_MS = 600
/** How long a native-timed line lingers after its last word. */
const NATIVE_TAIL_MS = 1500

const SHORT_PAUSE = /[,;:—–]["'”’)\]]*$/u
const LONG_PAUSE = /[.!?…]["'”’)\]]*$/u

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Relative share of a line's time a word gets: syllables, plus holds for punctuation and line ends. */
export function wordWeight(token: Token, isLast: boolean): number {
  let weight = countSyllables(token.text) + 0.35
  if (LONG_PAUSE.test(token.raw)) weight += 0.6
  else if (SHORT_PAUSE.test(token.raw)) weight += 0.4
  if (isLast) weight *= 1.25
  return weight
}

const syllablesOf = (tokens: Token[]): number => tokens.reduce((n, t) => n + countSyllables(t.text), 0)

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Distributes [start, end] over tokens by weight; consecutive words share exact boundaries. */
function spread(tokens: Token[], start: number, end: number): TimedWord[] {
  const weights = tokens.map((t, i) => wordWeight(t, i === tokens.length - 1))
  const total = weights.reduce((a, b) => a + b, 0)
  const span = Math.max(0, end - start)
  let acc = 0
  return tokens.map((token, i) => {
    const wordStart = start + Math.round((span * acc) / total)
    acc += weights[i]!
    const wordEnd = i === tokens.length - 1 ? end : start + Math.round((span * acc) / total)
    return { text: token.text, start: wordStart, end: wordEnd }
  })
}

/** Cleans source word timing: fills open ends, keeps order, splits multi-word chunks. */
function expandNative(native: TimedWord[], lineEnd: number): TimedWord[] {
  const out: TimedWord[] = []
  native.forEach((word, i) => {
    const start = Math.max(Math.round(word.start), out.at(-1)?.start ?? Number.NEGATIVE_INFINITY)
    const fallbackEnd = native[i + 1]?.start ?? lineEnd
    const end = Math.max(start, Math.round(Number.isFinite(word.end) ? word.end : fallbackEnd))
    const tokens = tokenizeLine(word.text)
    if (tokens.length === 1) out.push({ text: tokens[0]!.text, start, end })
    else if (tokens.length > 1) out.push(...spread(tokens, start, end))
  })
  return out
}

interface Draft {
  line: ParsedLine
  tokens: Token[]
  end: number
  /** True when `end` is only "where the next line starts" (it may include an instrumental gap). */
  inferred: boolean
}

const isBreak = (line: ParsedLine | undefined): boolean => !!line && !line.text.trim() && !line.words?.length

/**
 * Publisher drift lets a line's words overlap the next line's start. The renderer indexes
 * the flattened words with a binary search, so walk the sorted lines and push any word
 * that would start before the last placed word forward — timings agree within a few
 * milliseconds when payloads overlap; nothing else about them changes. Mutates `lines`.
 */
export function flattenOverlaps(lines: ParsedLine[]): ParsedLine[] {
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

/**
 * Turns parsed lines into per-word timing. Words keep the source's timing when it has
 * any; otherwise each line's time is shared by syllable weight. Lines whose end is only
 * inferred are capped at the song's own pace so a long instrumental never stretches a word.
 */
export function buildTimedLyrics(lines: ParsedLine[], durationMs?: number): TimedLyrics | null {
  const sorted = [...lines].sort((a, b) => a.start - b.start)
  const drafts: Draft[] = []

  sorted.forEach((line, i) => {
    const tokens = tokenizeLine(line.text)
    if (!tokens.length && !line.words?.length) return
    const next = sorted[i + 1]
    const limit = next
      ? next.start
      : durationMs !== undefined && durationMs > line.start
        ? durationMs
        : line.start + 10_000

    const hasRealEnd = line.end !== undefined && line.end > line.start && (!next || line.end < next.start - SAME_TIME_MS)
    const end = hasRealEnd ? Math.min(line.end!, limit) : limit
    drafts.push({ line, tokens, end: Math.max(end, line.start + 1), inferred: !hasRealEnd && !isBreak(next) })
  })
  if (!drafts.length) return null

  const paces = drafts
    .filter((d) => d.inferred && !d.line.words?.length)
    .map((d) => ({ syllables: syllablesOf(d.tokens), span: d.end - d.line.start }))
    .filter((p) => p.syllables >= 2)
    .map((p) => p.span / p.syllables)
  const msPerSyllable = clamp(
    (median(paces) ?? DEFAULT_MS_PER_SYLLABLE) * PACE_TOLERANCE,
    MIN_MS_PER_SYLLABLE,
    MAX_MS_PER_SYLLABLE
  )

  let allNative = true
  const result: TimedLine[] = []
  for (const draft of drafts) {
    let words: TimedWord[]
    let end = draft.end
    if (draft.line.words?.length) {
      words = expandNative(draft.line.words, end)
      const last = words.at(-1)
      if (last) end = Math.max(last.end, Math.min(end, last.end + NATIVE_TAIL_MS))
    } else {
      allNative = false
      if (draft.inferred) {
        const cap = draft.line.start + Math.round(syllablesOf(draft.tokens) * msPerSyllable + CAP_PADDING_MS)
        end = Math.min(end, cap)
      }
      words = spread(draft.tokens, draft.line.start, end)
    }
    if (!words.length) continue
    result.push({
      text: draft.line.text.trim() || words.map((w) => w.text).join(' '),
      start: words[0]!.start,
      end: Math.max(end, words.at(-1)!.end),
      words
    })
  }

  return result.length ? { lines: result, wordTiming: allNative ? 'native' : 'estimated' } : null
}
