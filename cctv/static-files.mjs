// The app's own files (pages, styles, scripts), sent small and only when they changed.
//
// They used to go out whole and uncompressed on every page load: "no-cache" with nothing the
// browser could check its copy against, so each page switch fetched ~300 KB again -- over the
// public link the stylesheet alone took over a second. Now each file is:
//   - compressed once per version (brotli, or gzip for a browser without it) and kept in memory,
//     about a fifth of the size; the browser unpacks it to exactly the original bytes
//   - given an ETag from its size and modification time; the browser asks "still this one?" and a
//     file that has not changed is answered 304, a few bytes, instead of the file
//   - still "no-cache": the browser always asks, so a deploy is picked up on the very next load
// Nothing here touches video. Pure enough to test without a server: test/static-files.test.mjs.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** Types worth compressing (text); images like PNG are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/
const MIN_BYTES = 1024
const cache = new Map() // path -> { etag, raw, br, gz }

/** The file as it is now, compressed forms made on first use and kept until it changes. */
export function loadFile(path, type) {
  const st = statSync(path)
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  const hit = cache.get(path)
  if (hit && hit.etag === etag) return hit
  const raw = readFileSync(path)
  const entry = { etag, raw, br: null, gz: null }
  if (COMPRESSIBLE.test(type) && raw.length >= MIN_BYTES) {
    entry.br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    entry.gz = gzipSync(raw, { level: 9 })
  }
  cache.set(path, entry)
  return entry
}

/** Which encoding to send, from the browser's Accept-Encoding. */
export function pickEncoding(accept = '', entry) {
  const a = String(accept).toLowerCase()
  if (entry.br && /\bbr\b/.test(a)) return 'br'
  if (entry.gz && /\bgzip\b/.test(a)) return 'gzip'
  return null
}

/**
 * The response for one file request: { status, headers, body }.
 * @param {{ path: string, type: string, ifNoneMatch?: string, acceptEncoding?: string }} o
 */
export function fileResponse({ path, type, ifNoneMatch, acceptEncoding }) {
  const entry = loadFile(path, type)
  const headers = { 'content-type': type, 'cache-control': 'no-cache', etag: entry.etag, vary: 'Accept-Encoding' }
  if (ifNoneMatch && String(ifNoneMatch).split(',').map((s) => s.trim()).includes(entry.etag)) {
    return { status: 304, headers, body: null }
  }
  const enc = pickEncoding(acceptEncoding, entry)
  const body = enc === 'br' ? entry.br : enc === 'gzip' ? entry.gz : entry.raw
  if (enc) headers['content-encoding'] = enc
  headers['content-length'] = String(body.length)
  return { status: 200, headers, body }
}

/**
 * Compresses every app file now, in the background, a file at a time: the first visitor after a
 * deploy should not wait for a stylesheet to be compressed (it took 2.7 s over the public link).
 */
export function warmFiles(dir, mime, { pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  ;(async () => {
    for (const f of walk(dir)) {
      const type = mime[extname(f)]
      if (!type) continue
      try { loadFile(f, type) } catch {}
      await pause(20) // a little at a time: the server has live video to serve meanwhile
    }
  })().catch(() => {})
}
