import { describe, expect, it } from 'vitest'
import { parseBridgeLine, rawKey, type RawSession } from '../src/main/media/protocol'

const session: RawSession = {
  app: 'Spotify.exe',
  status: 'Playing',
  title: 'Paper Lanterns',
  artist: 'Lantern Test Band',
  album: 'Fixtures',
  pos: 12.5,
  start: 0,
  end: 32,
  updated: 1_700_000_000_000,
  rate: 1
}

describe('parseBridgeLine', () => {
  it('accepts every message type', () => {
    expect(parseBridgeLine('{"type":"hello","ps":"5.1"}')).toEqual({ type: 'hello', ps: '5.1' })
    expect(parseBridgeLine(JSON.stringify({ type: 'sessions', t: 5, current: 'Spotify.exe', sessions: [session] }))).toEqual({
      type: 'sessions',
      t: 5,
      current: 'Spotify.exe',
      sessions: [session]
    })
    expect(parseBridgeLine('{"type":"art","key":"k","mime":"image/jpeg","data":"AAAA"}')).toMatchObject({ type: 'art', key: 'k' })
    expect(parseBridgeLine('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' })
  })

  it('rejects junk, unknown types and malformed sessions', () => {
    expect(parseBridgeLine('')).toBeNull()
    expect(parseBridgeLine('not json')).toBeNull()
    expect(parseBridgeLine('{"type":"nope"}')).toBeNull()
    expect(parseBridgeLine('{"type":"sessions","t":1,"current":null,"sessions":[{"app":1}]}')).toEqual({
      type: 'sessions',
      t: 1,
      current: null,
      sessions: []
    })
  })

  it('fills missing optional fields with safe defaults', () => {
    const msg = parseBridgeLine('{"type":"sessions","t":1,"current":null,"sessions":[{"app":"X","status":"Paused","title":null}]}')
    expect(msg?.type === 'sessions' && msg.sessions[0]).toMatchObject({ app: 'X', title: '', pos: 0, end: 0, rate: 1 })
  })

  it('tolerates a byte-order mark and surrounding whitespace', () => {
    expect(parseBridgeLine('﻿ {"type":"hello","ps":"5.1"} ')).toEqual({ type: 'hello', ps: '5.1' })
  })
})

describe('rawKey', () => {
  it('joins the identity fields exactly like the bridge script', () => {
    expect(rawKey(session)).toBe('Spotify.exe|Paper Lanterns|Lantern Test Band|Fixtures')
  })
})

describe('Kodama bridge fixtures', () => {
  // What the PowerShell bridge prints for a Kiyoshi-style Tauri publisher: the app
  // identifier is the executable path, playback states arrive as enum names, Unicode
  // titles travel as UTF-8, and the timeline's rate can be missing entirely.
  const line = JSON.stringify({
    type: 'sessions',
    t: 1_700_000_000_000,
    current: 'C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe',
    sessions: [
      {
        app: 'C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe',
        status: 'Playing',
        title: '紙めいる / Paper Lanterns',
        artist: 'One Artist, Another Artist'
        // pos, start, end, updated, rate all missing → defaults
      }
    ]
  })

  it('parses a Kodama session with missing fields and unknown rate', () => {
    const msg = parseBridgeLine(line)
    expect(msg?.type).toBe('sessions')
    if (msg?.type !== 'sessions') return
    expect(msg.current).toBe('C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe')
    expect(msg.sessions[0]).toEqual({
      app: 'C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe',
      status: 'Playing',
      title: '紙めいる / Paper Lanterns',
      artist: 'One Artist, Another Artist',
      album: '',
      pos: 0,
      start: 0,
      end: 0,
      updated: 0,
      rate: 1
    })
  })

  it('passes every playback state through, including Stopped', () => {
    const stopped = parseBridgeLine('{"type":"sessions","t":1,"current":null,"sessions":[{"app":"C:\\\\Kodama\\\\kodama.exe","status":"Stopped"}]}')
    expect(stopped?.type === 'sessions' && stopped.sessions[0]?.status).toBe('Stopped')
  })

  it('keeps the full app id in rawKey so path-identified publishers stay distinct', () => {
    const msg = parseBridgeLine(line)
    const s = msg?.type === 'sessions' ? msg.sessions[0] : null
    expect(s && rawKey(s)).toBe('C:\\Users\\demo\\AppData\\Local\\Kodama\\kodama.exe|紙めいる / Paper Lanterns|One Artist, Another Artist|')
  })
})
