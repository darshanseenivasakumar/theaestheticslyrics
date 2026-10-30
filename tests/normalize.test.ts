import { describe, expect, it } from 'vitest'
import { cleanTitle, normalizeForMatch, primaryArtist, splitAppleMusicArtist } from '../src/main/lyrics/normalize'

describe('normalizeForMatch', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeForMatch('Beyoncé & Co.')).toBe('beyonce and co')
    expect(normalizeForMatch("  Don't   Stop!! ")).toBe('dont stop')
  })

  it('keeps non-Latin letters', () => {
    expect(normalizeForMatch('夜に駆ける')).toBe('夜に駆ける')
    expect(normalizeForMatch('Kannukkul Pothi Vaippen')).toBe('kannukkul pothi vaippen')
  })
})

describe('cleanTitle', () => {
  it('drops featuring credits, remaster and version noise', () => {
    expect(cleanTitle('Song (feat. X) - Remastered 2011')).toBe('Song')
    expect(cleanTitle('Song [feat. Someone Else]')).toBe('Song')
    expect(cleanTitle('Song - 2009 Remaster')).toBe('Song')
    expect(cleanTitle('Song (Official Music Video)')).toBe('Song')
    expect(cleanTitle('Song (with Friend)')).toBe('Song')
    expect(cleanTitle('Song - Radio Edit')).toBe('Song')
    expect(cleanTitle('Song (Live)')).toBe('Song')
    expect(cleanTitle('Song [Live Version]')).toBe('Song')
    expect(cleanTitle('Song (Live from Paris)')).toBe('Song')
  })

  it('leaves meaningful titles alone', () => {
    expect(cleanTitle('Night (Part 2)')).toBe('Night (Part 2)')
    expect(cleanTitle('Hold On')).toBe('Hold On')
    expect(cleanTitle('Stay Live')).toBe('Stay Live')
  })
})

describe('primaryArtist', () => {
  it('takes the first credited artist', () => {
    expect(primaryArtist('A, B')).toBe('A')
    expect(primaryArtist('A & B')).toBe('A')
    expect(primaryArtist('A feat. B')).toBe('A')
    expect(primaryArtist('A x B')).toBe('A')
    expect(primaryArtist('Simon & Garfunkel')).toBe('Simon')
  })
})

describe('splitAppleMusicArtist', () => {
  it('splits "Artist — Album" when the album is empty', () => {
    expect(splitAppleMusicArtist('Some Artist — Some Album', '')).toEqual({ artist: 'Some Artist', album: 'Some Album' })
  })

  it('keeps fields as they are when the album is present or no separator exists', () => {
    expect(splitAppleMusicArtist('Some Artist — Some Album', 'Real Album')).toEqual({
      artist: 'Some Artist — Some Album',
      album: 'Real Album'
    })
    expect(splitAppleMusicArtist('Plain Artist', '')).toEqual({ artist: 'Plain Artist', album: '' })
  })
})
