// No script that another script imports may wait at its top level, and shell.js stays the first module
// script of every page that has it.   node --test cctv/test/no-shared-await.test.mjs
//
// Safari before 27 (and every browser on an iPhone: the same engine; WebKit bug 242740) lets a
// second script that imports a module run while that module is still stopped at a top-level await,
// its exports not yet set. public/user-settings.js once waited there for the account's preferences,
// shell.js and viewer.js both imported it, and the Live page stopped on "Loading your cameras…" on
// iPhones (2026-10-08). A page's own script, which nothing imports, may wait; a shared one may not.
//
// PUBLIC_DIR may name another build's public folder to check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = resolve(process.env.PUBLIC_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public'))
const scripts = readdirSync(PUBLIC).filter((f) => f.endsWith('.js'))
const source = (f) => readFileSync(join(PUBLIC, f), 'utf8')
const IMPORT = /(?:\bimport\b|\bexport\b)\s*(?:[\w$*{},\s]+?\bfrom\s*)?['"]\.\/([\w.-]+\.js)['"]|\bimport\(\s*['"]\.\/([\w.-]+\.js)['"]/g

/**
 * Whether a module waits at its top level. Its imports and exports are taken off and the rest is
 * compiled as the body of an ordinary function: there an await outside any async function is a
 * syntax error, and one inside is not. Anything else that fails to compile fails the test.
 */
function awaitsAtTop(f) {
  const body = source(f)
    .replace(/\bimport\s*(?:[\w$*{},\s]+?\bfrom\s*)?['"][^'"\n]+['"]\s*;?/g, '')
    .replace(/\bexport\s*\{[^}]*\}\s*(?:from\s*['"][^'"\n]+['"])?\s*;?/g, '')
    .replace(/\bexport\s*\*\s*from\s*['"][^'"\n]+['"]\s*;?/g, '')
    .replace(/\bexport\s+default\s+/g, 'void ')
    .replace(/\bexport\s+/g, '')
    .replace(/\bimport\.meta\b/g, '({})')
  try {
    new Function(body)
    return false
  } catch (e) {
    if (/await/.test(e.message)) return true
    throw new Error(`${f} could not be checked: ${e.message}`)
  }
}

const importers = new Map() // file -> the files that import it
for (const f of scripts) {
  for (const m of source(f).matchAll(IMPORT)) {
    const dep = m[1] ?? m[2]
    if (!importers.has(dep)) importers.set(dep, new Set())
    importers.get(dep).add(f)
  }
}

test('the check itself tells a top-level await from one inside a function', () => {
  assert.ok(importers.get('user-settings.js')?.has('shell.js'), 'imports are being read')
  assert.equal(awaitsAtTop('viewer.js'), true, 'viewer.js, a page\'s own script, does wait')
  assert.equal(awaitsAtTop('qoe.js'), false)
})

test('no script that another imports waits at its top level', () => {
  const bad = scripts.filter((f) => importers.has(f) && awaitsAtTop(f)).map((f) => `${f} (imported by ${[...importers.get(f)].join(', ')})`)
  assert.deepEqual(bad, [])
})

test('shell.js is the first module script of every page that loads it', () => {
  // (it asks for the preferences first, so the shell is drawn before a page script that waits for them goes on)
  for (const page of readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const modules = [...source(page).matchAll(/<script[^>]*type="module"[^>]*src="([^"?]+)/g)].map((m) => m[1])
    if (modules.includes('shell.js')) assert.equal(modules[0], 'shell.js', page)
  }
})
