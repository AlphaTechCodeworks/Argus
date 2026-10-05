// Tests the app's own files being sent compressed and only when changed (static-files.mjs).
//   node cctv/test/static-files.test.mjs
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { fileResponse, setAssetStamp, stampAssets } from '../static-files.mjs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const dir = mkdtempSync(join(tmpdir(), 'cctv-static-'))
const css = join(dir, 'style.css')
const text = '.tile { background: #000; }\n'.repeat(400)
writeFileSync(css, text)

const br = fileResponse({ path: css, type: 'text/css', acceptEncoding: 'gzip, deflate, br' })
check('a browser that takes brotli gets it', br.status === 200 && br.headers['content-encoding'] === 'br')
check('and it unpacks to exactly the original', brotliDecompressSync(br.body).toString() === text)
check('much smaller than the file', br.body.length < text.length / 5, `${br.body.length} of ${text.length}`)
const gz = fileResponse({ path: css, type: 'text/css', acceptEncoding: 'gzip' })
check('gzip for a browser without brotli, also exact', gz.headers['content-encoding'] === 'gzip' && gunzipSync(gz.body).toString() === text)
const plain = fileResponse({ path: css, type: 'text/css', acceptEncoding: '' })
check('nothing asked for: the file as it is', !plain.headers['content-encoding'] && plain.body.toString() === text)

const again = fileResponse({ path: css, type: 'text/css', ifNoneMatch: br.headers.etag, acceptEncoding: 'br' })
check('unchanged since the browser\'s copy: 304 and no body', again.status === 304 && again.body === null)
check('always asked again (a deploy shows at once)', br.headers['cache-control'] === 'no-cache' && br.headers.vary === 'Accept-Encoding')

writeFileSync(css, `${text}/* changed */\n`)
utimesSync(css, new Date(), new Date(Date.now() + 5000))
const changed = fileResponse({ path: css, type: 'text/css', ifNoneMatch: br.headers.etag, acceptEncoding: 'br' })
check('changed: the new file, with a new ETag', changed.status === 200 && changed.headers.etag !== br.headers.etag && brotliDecompressSync(changed.body).toString().endsWith('/* changed */\n'))

const png = join(dir, 'icon.png')
writeFileSync(png, Buffer.alloc(4000, 7))
check('images are not compressed again', !fileResponse({ path: png, type: 'image/png', acceptEncoding: 'br' }).headers['content-encoding'])

// ---- every link carries the release (Cloudflare kept old scripts for 4 h after a deploy) ----
{
  const html = '<link rel="icon" href="/logo.svg"><script src="viewer.js"></script><link href="css/base.css" rel="stylesheet"><a href="/settings.html">S</a><script src="https://cdn.example/x.js"></script><img src="//cdn.example/y.png"><script src="a.js?x=1"></script>'
  const out = stampAssets(html, 'html', 'R7')
  check('page: local scripts, styles and icons get ?v=release', out.includes('href="/logo.svg?v=R7"') && out.includes('src="viewer.js?v=R7"') && out.includes('href="css/base.css?v=R7"'), out)
  check('page: links to pages, other hosts and addresses with a query are left alone', out.includes('href="/settings.html"') && out.includes('https://cdn.example/x.js"') && out.includes('src="//cdn.example/y.png"') && out.includes('src="a.js?x=1"'), out)
  const js = [
    "import { VideoPlayer } from './player.js'",
    "import './side.js'",
    "const lazy = await import('./lazy.js')",
    "const w = new Worker(new URL('./picture-worker.js', import.meta.url), { type: 'module' })",
    "const s = 'came from \"nothing happened\"'",
    "navigator.serviceWorker.register('/sw.js')"
  ].join('\n')
  const o = stampAssets(js, 'js', 'R7')
  check('script: static, bare and dynamic imports get ?v=release', o.includes("from './player.js?v=R7'") && o.includes("import './side.js?v=R7'") && o.includes("import('./lazy.js?v=R7')"), o)
  check('script: new URL(..., import.meta.url) too (the picture worker)', o.includes("new URL('./picture-worker.js?v=R7', import.meta.url)"), o)
  check('script: ordinary strings and the service worker address are left alone', o.includes("'came from \"nothing happened\"'") && o.includes("register('/sw.js')"), o)
  check('no release (development): nothing changes', stampAssets(js, 'js', null) === js)

  const page = join(dir, 'index.html')
  writeFileSync(page, '<script src="viewer.js"></script>')
  setAssetStamp('20260926-180000')
  const served = fileResponse({ path: page, type: 'text/html; charset=utf-8', acceptEncoding: '' })
  check('served page carries the release', served.body.toString().includes('viewer.js?v=20260926-180000'), served.body.toString())
  check('a page itself is never kept (no-cache)', served.headers['cache-control'] === 'no-cache')
  const kept = fileResponse({ path: css, type: 'text/css', acceptEncoding: '', versioned: true })
  check('a file asked for by its release name is kept for good', /immutable/.test(kept.headers['cache-control']) && /max-age=31536000/.test(kept.headers['cache-control']), kept.headers['cache-control'])
  check('the same file without a release: always asked about (no-cache)', fileResponse({ path: css, type: 'text/css', acceptEncoding: '' }).headers['cache-control'] === 'no-cache')
  const etagA = served.headers.etag
  setAssetStamp('20260926-190000')
  const next = fileResponse({ path: page, type: 'text/html; charset=utf-8', acceptEncoding: '' })
  check('a new release: new links and a new ETag (no 304 for the old page)', next.body.toString().includes('viewer.js?v=20260926-190000') && next.headers.etag !== etagA)
  setAssetStamp('dev')
  check('release "dev": nothing stamped, nothing kept for good', !fileResponse({ path: page, type: 'text/html', acceptEncoding: '' }).body.toString().includes('?v=') && fileResponse({ path: css, type: 'text/css', acceptEncoding: '', versioned: true }).headers['cache-control'] === 'no-cache')
  setAssetStamp(null)
}

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
