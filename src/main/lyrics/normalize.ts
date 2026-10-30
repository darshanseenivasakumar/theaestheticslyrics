/** Case/accent/punctuation-insensitive form used for comparing titles and artists. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const FEATURING = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi
const NOISE_BRACKET = /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|visualizer|explicit|clean|remaster(?:ed)?|live)\b[^)\]]*[)\]]/gi
const NOISE_SUFFIX =
  /\s+[-–—]\s+[^-–—]*\b(?:remaster(?:ed)?|edit|version|mix|mono|stereo|live|acoustic|demo|single|radio|bonus|deluxe|anniversary|explicit|clean|from)\b.*$/i
const TRAILING_FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i

/** Strips credits and release noise that players add but lyric databases rarely carry. */
export function cleanTitle(title: string): string {
  const cleaned = title
    .replace(FEATURING, '')
    .replace(NOISE_BRACKET, '')
    .replace(NOISE_SUFFIX, '')
    .replace(TRAILING_FEAT, '')
    .trim()
  return cleaned || title.trim()
}

const ARTIST_SPLIT = /\s*(?:,|;|\/|\s&\s|\s\+\s|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+with\s+)\s*/i

/** The first credited artist ("A feat. B", "A, B", "A & B" → "A"). */
export function primaryArtist(artist: string): string {
  const first = artist.split(ARTIST_SPLIT)[0]?.trim()
  return first || artist.trim()
}

/** Apple Music for Windows reports "Artist — Album" in the artist field and leaves the album empty. */
export function splitAppleMusicArtist(artist: string, album: string): { artist: string; album: string } {
  const sep = ' — '
  const at = artist.indexOf(sep)
  if (album.trim() || at <= 0) return { artist, album }
  return { artist: artist.slice(0, at).trim(), album: artist.slice(at + sep.length).trim() }
}
