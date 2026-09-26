// Tests the app's own files being sent compressed and only when changed (static-files.mjs).
//   node cctv/test/static-files.test.mjs
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { fileResponse } from '../static-files.mjs'

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

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
