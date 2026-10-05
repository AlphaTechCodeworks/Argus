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
//   - stamped with the release (setAssetStamp): pages and scripts are sent with every link to
//     another app file ending in ?v=<release>, and such a request may be kept for good
//     (immutable): Cloudflare rewrites "no-cache" on scripts and styles to "keep 4 hours"
//     (max-age=14400), so after a deploy remote browsers ran the old code for hours, even a mix of
//     old and new files (2026-09-26). A new release is a new name for every file: nothing can be
//     stale, and one page's files always come from one release.
// Nothing here touches video. Pure enough to test without a server: test/static-files.test.mjs.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** Types worth compressing (text); images like PNG are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/
const MIN_BYTES = 1024
const cache = new Map() // path -> { etag, raw, br, gz }

let stamp = null // the release, or null (development: nothing stamped, nothing kept for good)
/** Stamp app links with this release from now on (server start). */
export function setAssetStamp(s) {
  const clean = s == null ? '' : String(s).replace(/[^\w.-]/g, '')
  stamp = clean && clean !== 'dev' ? clean : null
  cache.clear()
}

// a local app file: no scheme, no query, one of these types
const ASSET = /[^'"?#\s:]+\.(?:js|mjs|css|svg|png|webmanifest)/.source
// in a page: src="x.js", href="/css/a.css" (not "//host/..." and not "https://...")
const HTML_REF = new RegExp(`(\\s(?:src|href)=)(["'])(\\/?(?!\\/)${ASSET})\\2`, 'g')
// in a script: from './x.js', import './x.js', import('./x.js')
const JS_IMPORT = new RegExp(`((?:\\bfrom|\\bimport)\\s*\\(?\\s*)(["'])(\\.{1,2}\\/${ASSET})\\2`, 'g')
// in a script: new URL('./x.js', import.meta.url)
const JS_URL = new RegExp(`(new URL\\(\\s*)(["'])(\\.{1,2}\\/${ASSET})\\2(\\s*,\\s*import\\.meta\\.url)`, 'g')

/**
 * Adds ?v=<s> to every link to another app file: in a page, src= and href= to a local script,
 * style, icon or manifest; in a script, its relative imports and new URL('./x', import.meta.url).
 * Addresses with a scheme, protocol-relative ones and ones that already carry a query are left alone.
 */
export function stampAssets(text, kind, s) {
  if (!s) return text
  const v = `?v=${s}`
  if (kind === 'html') return text.replace(HTML_REF, (_, a, q, p) => `${a}${q}${p}${v}${q}`)
  if (kind === 'js') return text.replace(JS_IMPORT, (_, a, q, p) => `${a}${q}${p}${v}${q}`).replace(JS_URL, (_, a, q, p, b) => `${a}${q}${p}${v}${q}${b}`)
  return text
}
const kindOf = (type) => (/^text\/html/.test(type) ? 'html' : /javascript/.test(type) ? 'js' : null)

/** Already served once (so it exists and is a file): serveFile skips its own checks. */
export const isCached = (path) => cache.has(path)

/** The file as it is now, compressed forms made on first use and kept until it changes. */
export function loadFile(path, type) {
  const st = statSync(path)
  const kind = kindOf(type)
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${kind && stamp ? `-${stamp}` : ''}"`
  const hit = cache.get(path)
  if (hit && hit.etag === etag) return hit
  let raw = readFileSync(path)
  if (kind && stamp) raw = Buffer.from(stampAssets(raw.toString('utf8'), kind, stamp))
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
export function fileResponse({ path, type, ifNoneMatch, acceptEncoding, versioned = false }) {
  const entry = loadFile(path, type)
  // a request for this release's own name for the file (?v=): it never changes, keep it for good
  const cacheControl = versioned && stamp ? 'public, max-age=31536000, immutable' : 'no-cache'
  const headers = { 'content-type': type, 'cache-control': cacheControl, etag: entry.etag, vary: 'Accept-Encoding' }
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
