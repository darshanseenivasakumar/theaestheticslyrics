import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MediaWatcher, type ArtworkEvent } from '../src/main/media/watcher'

/** Drives the private line handler directly; no powershell.exe is spawned. */
type WithLines = { handleLine(line: string): void }
const asLines = (w: MediaWatcher): WithLines => w as unknown as WithLines

const SESSIONS_LINE = JSON.stringify({
  type: 'sessions',
  t: 1_700_000_000_000,
  current: 'dev.kodama.music',
  sessions: [{ app: 'dev.kodama.music', status: 'Playing', title: 'Harvey', artist: "Her's", album: 'Diskopunk*' }]
})

describe('MediaWatcher album art', () => {
  it('caches art, re-emits it for the followed key, and serves artworkFor', () => {
    const log = vi.fn()
    const emitted: ArtworkEvent[] = []
    const watcher = new MediaWatcher({ scriptPath: 'bridge.ps1', log, source: () => 'all' })
    ;(watcher as unknown as EventEmitter).on('artwork', (art: ArtworkEvent) => emitted.push(art))

    asLines(watcher).handleLine(SESSIONS_LINE)
    // Art arrives after the session snapshot: stored, log line written, but the
    // followed key already matches so it is forwarded immediately.
    asLines(watcher).handleLine(
      JSON.stringify({ type: 'art', key: "dev.kodama.music|Harvey|Her's|Diskopunk*", mime: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') })
    )

    const key = "dev.kodama.music|Harvey|Her's|Diskopunk*"
    expect(watcher.artworkFor(key)?.data.toString('utf8')).toBe('jpeg-bytes')
    expect(emitted.map((e) => e.mime)).toContain('image/jpeg')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('album art'))
  })

  it('stores art for a track that is not (yet) followed without emitting', () => {
    const log = vi.fn()
    const emitted: ArtworkEvent[] = []
    const watcher = new MediaWatcher({ scriptPath: 'bridge.ps1', log, source: () => 'kodama' })
    ;(watcher as unknown as EventEmitter).on('artwork', (art: ArtworkEvent) => emitted.push(art))

    asLines(watcher).handleLine(
      JSON.stringify({ type: 'art', key: 'Spotify.exe|Song|Artist|Album', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') })
    )
    asLines(watcher).handleLine(SESSIONS_LINE)

    // nothing followed matches; the stored art is only reachable via artworkFor, and
    // art for a different key must not be forwarded to the Kodama session
    expect(watcher.artworkFor('Spotify.exe|Song|Artist|Album')?.mime).toBe('image/png')
    expect(emitted.filter((e) => e.key.startsWith('Spotify'))).toHaveLength(0)
    expect(watcher.artworkFor("dev.kodama.music|Harvey|Her's|Diskopunk*")).toBeNull()

    // art that arrives late for the followed key is forwarded right away
    const kodamaKey = "dev.kodama.music|Harvey|Her's|Diskopunk*"
    asLines(watcher).handleLine(
      JSON.stringify({ type: 'art', key: kodamaKey, mime: 'image/jpeg', data: Buffer.from('late-art').toString('base64') })
    )
    expect(emitted.map((e) => e.key)).toContain(kodamaKey)
  })

  it('keeps the newest art payload per key inside the bounded cache', () => {
    const watcher = new MediaWatcher({ scriptPath: 'bridge.ps1', log: vi.fn(), source: () => 'all' })
    asLines(watcher).handleLine(SESSIONS_LINE)
    const key = "dev.kodama.music|Harvey|Her's|Diskopunk*"
    asLines(watcher).handleLine(JSON.stringify({ type: 'art', key, mime: 'image/jpeg', data: Buffer.from('first').toString('base64') }))
    asLines(watcher).handleLine(JSON.stringify({ type: 'art', key, mime: 'image/png', data: Buffer.from('second').toString('base64') }))
    expect(watcher.artworkFor(key)?.data.toString('utf8')).toBe('second')

    // malformed lines are dropped silently
    expect(() => asLines(watcher).handleLine('{"type":"art","key":"k"}')).not.toThrow()
    expect(watcher.artworkFor(key)?.mime).toBe('image/png')
  })
})
