/**
 * Template for the real `secrets.ts` (which is git-ignored). To enable Musixmatch:
 *   1. copy this file to `src/main/secrets.ts`
 *   2. paste a key from https://developer.musixmatch.com over the empty string
 * With no key the app simply never asks Musixmatch and falls back to LRCLIB/NetEase.
 *
 * Secrets for outside services, pasted straight into this private build — no settings UI,
 * no env pipeline. Keep the real file out of any commit once a real key is pasted in.
 */
export const MUSIXMATCH_API_KEY = ''
