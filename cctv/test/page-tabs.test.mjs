// The shared page tabs (public/page-tabs.js): the sections of the tabs not showing must be hidden on
// every page that uses it, whatever class its sections have (2026-09-26: a change hid only
// Settings-style sections, and the Alarms page showed all three tabs at once).
//   node cctv/test/page-tabs.test.mjs
import { readFileSync, readdirSync } from 'node:fs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const pub = new URL('../public/', import.meta.url)
const js = readFileSync(new URL('page-tabs.js', pub), 'utf8')
const css = readFileSync(new URL('style.css', pub), 'utf8')
const cls = /classList\.toggle\('([\w-]+)', s\.dataset\.tab !== t\.id\)/.exec(js)?.[1]
check('page-tabs toggles one class on the sections of other tabs', Boolean(cls), cls)
const rule = new RegExp(String.raw`main > section\[data-tab\]\.` + cls + String.raw`\s*\{[^}]*display:\s*none`)
check('style.css hides that class for any tabbed section (not only one page\'s section style)', rule.test(css))
check('page-tabs never sets the hidden attribute itself (a section a script keeps hidden stays so)', !/\.hidden\s*=/.test(js))
for (const page of readdirSync(pub).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(new URL(page, pub), 'utf8')
  if (!html.includes('page-tabs.js')) continue
  const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''
  const tabs = [...main.matchAll(/<section\b[^>]*\bdata-tab="([\w-]+)"/g)].map((m) => m[1])
  check(`${page}: its tabbed sections are direct children of <main> (what page-tabs looks for)`, tabs.length >= 2, tabs.join(','))
  check(`${page}: every tab has a label`, [...new Set(tabs)].every((t) => new RegExp(`data-tab="${t}"[^>]*data-tab-label=|data-tab-label="[^"]*"[^>]*data-tab="${t}"`).test(main)))
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
