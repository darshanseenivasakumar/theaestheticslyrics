#!/usr/bin/env node
/**
 * Minimal Better Lyrics proxy — zero dependencies, one file, Node 22+.
 *
 *   GET /api/lyrics?song=E85&artist=Don%20Toliver&album=OCTANE&duration=154
 *   GET /api/lyrics?title=E85&artist=Don%20Toliver           (aliases work)
 *   GET /health
 *
 * The key (if you ever get one) stays here, never in the browser bundle:
 *   BETTER_LYRICS_API_KEY=... npm run lyrics:server
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const UPSTREAM = (process.env.BETTER_LYRICS_API_URL ?? 'https://api.betterlyrics.org').replace(/\/$/, '')
const API_KEY = (process.env.BETTER_LYRICS_API_KEY ?? '').trim()
const TIMEOUT_MS = Number(process.env.BETTER_LYRICS_TIMEOUT_MS ?? 8000)
const CACHE_TTL_MS = Number(process.env.BETTER_LYRICS_CACHE_TTL_MS ?? 10 * 60 * 1000)
const NOT_FOUND_TTL_MS = 60 * 1000
const MAX_CACHE_ENTRIES = 200

/** Successful and known-missing replies only. Errors are never cached. */
const cache = new Map()

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400'
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(payload)
}

/** First non-empty value among the accepted parameter aliases. */
function param(params, ...names) {
  for (const name of names) {
    const value = params.get(name)?.trim()
    if (value) return value
  }
  return ''
}

function upstreamHeader(upstream, name, target) {
  const value = upstream.headers.get(name)
  return value ? { [target]: value } : {}
}

function remember(key, entry) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
  cache.set(key, entry)
}

function recall(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return null
  }
  return hit
}

async function askUpstream({ song, artist, album, duration }) {
  const query = new URLSearchParams({ s: song, a: artist })
  if (album) query.set('al', album)
  if (duration) query.set('d', duration)

  const headers = { Accept: 'application/json', 'User-Agent': 'theaestheticslyrics-proxy/1.0' }
  if (API_KEY) headers['X-API-Key'] = API_KEY

  const started = Date.now()
  const upstream = await fetch(`${UPSTREAM}/getLyrics?${query}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await upstream.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // A Cloudflare HTML error page is not JSON; handled by the caller.
  }
  return { upstream, data, elapsedMs: Date.now() - started }
}

async function handleLyrics(url, res) {
  const song = param(url.searchParams, 'song', 's', 'songName', 'title')
  const artist = param(url.searchParams, 'artist', 'a', 'artistName')
  const album = param(url.searchParams, 'album', 'al', 'albumName')
  const rawDuration = param(url.searchParams, 'duration', 'd')
  const seconds = Number(rawDuration)

  if (!song || !artist) {
    return send(res, 400, {
      error: 'missing_parameters',
      message: 'Send both "song" (or "s") and "artist" (or "a").'
    })
  }

  // An unusable duration must not break the lookup: it is only a matching hint.
  const duration = Number.isFinite(seconds) && seconds > 0 && seconds < 36_000 ? String(Math.round(seconds)) : ''
  const key = JSON.stringify([song, artist, album, duration])

  const hit = recall(key)
  if (hit) {
    return send(res, hit.status, hit.body, { 'X-Proxy-Cache': 'HIT' })
  }

  try {
    const { upstream, data } = await askUpstream({ song, artist, album, duration })
    const passThrough = {
      ...upstreamHeader(upstream, 'x-cache-status', 'X-Upstream-Cache-Status'),
      ...upstreamHeader(upstream, 'x-auth-mode', 'X-Upstream-Auth-Mode'),
      ...upstreamHeader(upstream, 'x-ratelimit-type', 'X-Upstream-RateLimit-Type')
    }

    if (upstream.status === 200) {
      if (!data || typeof data.ttml !== 'string' || !data.ttml.trim()) {
        return send(res, 502, {
          error: 'invalid_upstream_reply',
          message: 'The lyrics service returned an empty or malformed response.'
        })
      }
      const body = {
        ttml: data.ttml,
        ...(typeof data.score === 'number' ? { score: data.score } : {})
      }
      remember(key, { status: 200, body, expires: Date.now() + CACHE_TTL_MS })
      return send(res, 200, body, { 'X-Proxy-Cache': 'MISS', ...passThrough })
    }

    if (upstream.status === 404) {
      const body = {
        error: 'not_found',
        message: 'No lyrics were found for this track.'
      }
      remember(key, { status: 404, body, expires: Date.now() + NOT_FOUND_TTL_MS })
      return send(res, 404, body, passThrough)
    }

    if (upstream.status === 401) {
      return send(res, 502, {
        error: 'api_key_required',
        message:
          'The lyrics service requires an API key for songs it has not cached. Set BETTER_LYRICS_API_KEY or wait for the song to be cached upstream.'
      }, passThrough)
    }

    if (upstream.status === 422) {
      return send(res, 400, {
        error: 'invalid_query',
        message: 'The lyrics service rejected the search parameters.'
      }, passThrough)
    }

    if (upstream.status === 429) {
      const retryAfter = upstream.headers.get('retry-after')
      return send(res, 429, {
        error: 'rate_limited',
        message: 'The lyrics service is rate limiting requests. Try again shortly.'
      }, { ...passThrough, ...(retryAfter ? { 'Retry-After': retryAfter } : {}) })
    }

    return send(res, 502, {
      error: 'upstream_error',
      message: `The lyrics service failed with HTTP ${upstream.status}.`
    }, passThrough)
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return send(res, timedOut ? 504 : 502, {
      error: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
      message: timedOut
        ? `The lyrics service did not answer within ${TIMEOUT_MS} ms.`
        : 'The lyrics service could not be reached.'
    })
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now()

  // One line per request, on every path including OPTIONS and errors.
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`)
  })

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, upstream: UPSTREAM, apiKey: Boolean(API_KEY) })
    }

    if (url.pathname !== '/api/lyrics' && url.pathname !== '/getLyrics') {
      return send(res, 404, {
        error: 'not_found',
        message: 'Use GET /api/lyrics or GET /health.'
      })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, {
        error: 'method_not_allowed',
        message: 'Only GET is supported.'
      }, { Allow: 'GET, HEAD, OPTIONS' })
    }

    await handleLyrics(url, res)
  } catch (err) {
    if (!res.headersSent) {
      send(res, 500, {
        error: 'internal_error',
        message: 'The proxy hit an unexpected error.'
      })
    }
    console.error('proxy error:', err)
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with PORT=8788 npm run lyrics:server`)
  } else {
    console.error('server error:', err)
  }
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  console.log(`Better Lyrics proxy listening on http://${HOST}:${PORT}`)
  console.log(`  GET /api/lyrics?song=...&artist=...&album=...&duration=...`)
  console.log(`  upstream: ${UPSTREAM}${API_KEY ? ' (API key configured)' : ' (cache-only)'}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
