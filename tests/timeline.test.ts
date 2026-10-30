import { describe, expect, it } from 'vitest'
import type { RawSession } from '../src/main/media/protocol'
import { AnchorTracker, positionAt } from '../src/main/media/timeline'

const base: RawSession = {
  app: 'Spotify.exe',
  status: 'Playing',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  pos: 12.5,
  start: 0,
  end: 200,
  updated: 1000,
  rate: 1
}

describe('AnchorTracker', () => {
  it('anchors a playing session at its reported update time', () => {
    const anchor = new AnchorTracker().update(base, 1500)
    expect(anchor).toEqual({
      trackKey: 'Spotify.exe|Song|Artist|Album',
      positionMs: 12_500,
      atEpochMs: 1000,
      playing: true,
      rate: 1
    })
  })

  it('uses the time it first saw a position when the update time is invalid', () => {
    const tracker = new AnchorTracker()
    const bad = { ...base, updated: -62_135_596_800_000 }
    expect(tracker.update(bad, 5000).atEpochMs).toBe(5000)
    expect(tracker.update(bad, 5250).atEpochMs).toBe(5000)
    expect(tracker.update({ ...bad, pos: 13.5 }, 6000).atEpochMs).toBe(6000)
  })

  it('treats an update time in the future as invalid', () => {
    expect(new AnchorTracker().update({ ...base, updated: 99_000 }, 5000).atEpochMs).toBe(5000)
  })

  it('reports paused sessions as not playing', () => {
    expect(new AnchorTracker().update({ ...base, status: 'Paused' }, 1500).playing).toBe(false)
  })

  it('falls back to the observation time when extrapolation would pass the end', () => {
    const anchor = new AnchorTracker().update({ ...base, pos: 10 }, 1000 + 400_000)
    expect(anchor.atEpochMs).toBe(401_000)
  })

  it('never reports a negative position and defaults a bad rate to 1', () => {
    const anchor = new AnchorTracker().update({ ...base, pos: -3, rate: 0 }, 1500)
    expect(anchor.positionMs).toBe(0)
    expect(anchor.rate).toBe(1)
  })
})

describe('positionAt', () => {
  it('extrapolates while playing and holds while paused', () => {
    const anchor = { trackKey: 'k', positionMs: 10_000, atEpochMs: 1000, playing: true, rate: 1 }
    expect(positionAt(anchor, 3000)).toBe(12_000)
    expect(positionAt({ ...anchor, playing: false }, 3000)).toBe(10_000)
    expect(positionAt({ ...anchor, rate: 2 }, 2000)).toBe(12_000)
  })
})

describe('Kodama timeline fixtures', () => {
  // Kodama is a Tauri/souvlaki publisher: its SMTC session refreshes PlaybackStatus and the
  // timeline Position only when its frontend pushes state — immediately on a track change,
  // 800 ms after play/pause, when the duration becomes known, and on a ~15 s cadence. Between
  // pushes the session repeats the same position with a refreshed LastUpdatedTime.
  const T0 = 1_700_000_000_000
  const APP = 'C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe'
  const RAW_T0: RawSession = {
    app: APP,
    status: 'Playing',
    title: 'Paper Lanterns',
    artist: 'One Artist, Another Artist',
    album: '',
    pos: 0,
    start: 0,
    end: 214,
    updated: T0,
    rate: 1
  }

  it('anchors the track-change push at its update time and extrapolates until the next push', () => {
    const tracker = new AnchorTracker()
    const first = tracker.update(RAW_T0, T0 + 200)
    expect(first.trackKey).toBe(`${APP}|Paper Lanterns|One Artist, Another Artist|`)
    expect(first.atEpochMs).toBe(T0)

    // Bridge samples between pushes repeat the last pushed position: the anchor must hold.
    const repeat = tracker.update(RAW_T0, T0 + 12_000)
    expect(repeat.atEpochMs).toBe(T0)
    expect(repeat.positionMs).toBe(0)

    // The 15 s push: position advanced ~15 s, update time refreshed.
    const pushed = tracker.update({ ...RAW_T0, pos: 15, updated: T0 + 15_000 }, T0 + 15_200)
    expect(pushed.atEpochMs).toBe(T0 + 15_000)
    // Mid-cadence, extrapolation continues from the latest push without a jump.
    expect(positionAt(pushed, T0 + 15_100)).toBeCloseTo(15_100, 0)
  })

  it('keeps extrapolating while the duration is still unknown (end 0)', () => {
    const tracker = new AnchorTracker()
    const before = tracker.update({ ...RAW_T0, end: 0 }, T0 + 200)
    expect(before.positionMs).toBe(0)
    expect(before.atEpochMs).toBe(T0)

    // loadedmetadata push: duration becomes known, position keeps its continuity.
    const known = tracker.update({ ...RAW_T0, pos: 3.5, updated: T0 + 3_500 }, T0 + 3_500 + 100)
    expect(known.atEpochMs).toBe(T0 + 3_500)
    expect(positionAt(known, T0 + 5_000)).toBeCloseTo(5_000, 0)
  })

  it('corrects to the new position after a seek at the next cadence push', () => {
    const tracker = new AnchorTracker()
    tracker.update({ ...RAW_T0, pos: 100, updated: T0 }, T0 + 100)
    // The user seeks inside Kodama; SMTC still shows the old value until the next push.
    const stale = tracker.update({ ...RAW_T0, pos: 100, updated: T0 }, T0 + 10_000)
    expect(Math.round(positionAt(stale, T0 + 10_000))).toBe(110_000)

    // The push after the seek reports the new spot; the anchor jumps onto it.
    const afterSeek = tracker.update({ ...RAW_T0, pos: 40, updated: T0 + 15_000 }, T0 + 15_100)
    expect(afterSeek.positionMs).toBe(40_000)
    expect(afterSeek.atEpochMs).toBe(T0 + 15_000)
  })

  it('freezes the position while paused and resumes from the resumed spot', () => {
    const tracker = new AnchorTracker()
    const paused = tracker.update({ ...RAW_T0, status: 'Paused', pos: 42.5, updated: T0 }, T0 + 100)
    expect(paused.playing).toBe(false)
    expect(positionAt(paused, T0 + 120_000)).toBe(42_500)

    // Push ticks while paused keep repeating the same position (whatever the update time).
    tracker.update({ ...RAW_T0, status: 'Paused', pos: 42.5, updated: T0 + 15_000 }, T0 + 15_100)
    tracker.update({ ...RAW_T0, status: 'Paused', pos: 42.5, updated: T0 + 30_000 }, T0 + 30_100)

    const resumed = tracker.update({ ...RAW_T0, pos: 42.5, updated: T0 + 40_000 }, T0 + 40_100)
    expect(resumed.playing).toBe(true)
    expect(resumed.positionMs).toBe(42_500)
    expect(positionAt(resumed, T0 + 41_000)).toBe(43_500)
  })

  it('re-anchors on every advanced position when the update time is untrustworthy', () => {
    // Some WinRT projections of LastUpdatedTime are useless (this mirror-invalid value
    // covers the "garbage projection" case and a frozen system time alike).
    const bad = { ...RAW_T0, updated: -62_135_596_800_000 }
    const tracker = new AnchorTracker()
    expect(tracker.update(bad, T0).atEpochMs).toBe(T0)
    expect(tracker.update(bad, T0 + 300).atEpochMs).toBe(T0)
    const next = tracker.update({ ...bad, pos: 15, updated: -62_135_596_800_000 }, T0 + 15_000)
    expect(next.atEpochMs).toBe(T0 + 15_000)
    expect(positionAt(next, T0 + 15_300)).toBeCloseTo(15_300, 0)
  })

  it('re-anchors at the observation time once the song runs past its end', () => {
    const tracker = new AnchorTracker()
    // duration 100 s; a stale push 3 min old would extrapolate to ~5 min, so the
    // anchor falls back to the moment the sample was first observed and ticks on from there.
    const overshot = tracker.update({ ...RAW_T0, pos: 95, updated: T0 }, T0 + 195_000)
    expect(overshot.atEpochMs).toBe(T0 + 195_000)
    expect(positionAt(overshot, T0 + 195_500)).toBeCloseTo(95_500, 0)
  })

  it('treats an unset or zero playback rate as 1×', () => {
    expect(new AnchorTracker().update({ ...RAW_T0, rate: 0 }, T0 + 100).rate).toBe(1)
    expect(new AnchorTracker().update({ ...RAW_T0, rate: -1 }, T0 + 100).rate).toBe(1)
  })
})
