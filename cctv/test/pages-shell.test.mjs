// cctv/test/pages-shell.test.mjs
// Every page in the navigation carries the shell, loads the new stylesheets before the old one,
// sets its theme before painting, and no longer carries its own copy of the tabs.
//   node cctv/test/pages-shell.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_GROUPS } from '../public/nav-model.js'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const pub = join(import.meta.dirname, '..', 'public')
for (const i of NAV_GROUPS.flatMap((g) => g.items)) {
  const file = i.href === '/' ? 'index.html' : i.href.slice(1)
  const html = readFileSync(join(pub, file), 'utf8')
  const pos = (s) => html.indexOf(s)
  check(`${file}: theme set before paint`, pos('src="theme-boot.js"') > 0 && pos('src="theme-boot.js"') < pos('</head>') && !/theme-boot\.js"[^>]*\b(defer|async|type="module")/.test(html))
  for (const css of ['css/tokens.css', 'css/base.css', 'css/components.css', 'css/shell.css']) check(`${file}: loads ${css}`, pos(`href="${css}"`) > 0)
  check(`${file}: new styles load before style.css`, pos('href="css/shell.css"') < pos('href="style.css"') || pos('href="style.css"') < 0)
  check(`${file}: runs the shell`, /<script type="module" src="shell\.js"><\/script>/.test(html))
  check(`${file}: no hand-copied tabs left`, !/<nav class="tabs"/.test(html))
  check(`${file}: admin-tabs.js is gone`, !html.includes('admin-tabs.js'))
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
