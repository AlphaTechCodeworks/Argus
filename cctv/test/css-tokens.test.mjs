// cctv/test/css-tokens.test.mjs
// The redesign's one hard rule: every colour comes from tokens.css. The old style.css reached 69
// distinct hard-coded colours, which is why no two pages looked alike. This fails the build the
// moment a new stylesheet under css/ writes a colour of its own.
//   node cctv/test/css-tokens.test.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const dir = join(import.meta.dirname, '..', 'public', 'css')
check('the css folder exists', existsSync(dir))
const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.css')) : []
check('tokens.css exists', files.includes('tokens.css'))

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g
for (const f of files) {
  if (f === 'tokens.css') continue
  const text = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const hits = text.match(COLOUR) ?? []
  check(`${f} takes every colour from the tokens`, hits.length === 0, hits.slice(0, 3).join(' '))
}

const tokens = existsSync(join(dir, 'tokens.css')) ? readFileSync(join(dir, 'tokens.css'), 'utf8') : ''
for (const t of ['--bg', '--surface-1', '--surface-2', '--surface-3', '--border', '--text', '--text-muted', '--text-faint', '--accent', '--ok', '--warn', '--bad', '--video-bg']) {
  check(`dark defines ${t}`, new RegExp(`:root\\s*{[^}]*${t}\\s*:`).test(tokens))
}
check('a light theme exists', /:root\[data-theme="light"\]\s*{/.test(tokens))
for (const t of ['--bg', '--surface-1', '--text', '--border', '--accent']) {
  check(`light overrides ${t}`, new RegExp(`\\[data-theme="light"\\]\\s*{[^}]*${t}\\s*:`).test(tokens))
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
