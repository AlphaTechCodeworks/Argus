// Tests picking the cameras to keep streaming ahead of Live (warm-streams.mjs).
//   node cctv/test/warm-streams.test.mjs
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'warm-')) // (the default warm-out.json lands here, never in data/)
const { FIRST_RUN_MS, OUT_FILE, OUT_SAVE_STEP_MS, RELEASE_PER_RUN, pickWarm, startWarmStreams } = await import('../warm-streams.mjs')

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const cams = Array.from({ length: 30 }, (_, i) => ({ nvr: i < 20 ? 'a' : 'b', ch: i % 20, online: i !== 3 }))
const def = pickWarm({ cameras: cams, orders: {} })
check('no saved order: the first screen of the default order', def.length === 9 && def[0] === 'a/0')
check('offline cameras are skipped', !def.includes('a/3') && def.includes('a/9'), def.join(' '))
const one = pickWarm({ cameras: cams, orders: { mike: ['b/5', 'b/6'] } })
check('a user\'s own order comes first', one[0] === 'b/5' && one[1] === 'b/6' && one.length === 9, one.join(' '))
const many = pickWarm({ cameras: cams, orders: { u1: ['a/10', 'a/11', 'a/12', 'a/13', 'a/14', 'a/15', 'a/16', 'a/17', 'a/18'], u2: ['b/0', 'b/1', 'b/2', 'b/4', 'b/5', 'b/6', 'b/7', 'b/8', 'b/9'] } })
check('several users with nothing in common: stopped at 16', many.length === 16, String(many.length))
check('and shared cameras counted once', new Set(many).size === many.length)
check('a camera no longer there is not kept', !pickWarm({ cameras: cams, orders: { u: ['z/1'] } }).includes('z/1'))

// running: adds a quiet viewer, and lets it go when the camera drops off the list
{
  const streams = new Map()
  const streamOf = (n, ch) => {
    const k = `${n}/${ch}`
    if (!streams.has(k)) streams.set(k, { viewers: new Set(), add(v) { this.viewers.add(v) }, remove(v) { this.viewers.delete(v) } })
    return streams.get(k)
  }
  let list = cams
  const w = startWarmStreams({ cameras: () => list, orders: () => ({}), streamOf, log: () => {}, everyMs: 1e9, firstRunMs: 0, outFile: null })
  w.run()
  check('the first screen has a viewer each', [...streams.values()].filter((s) => s.viewers.size === 1).length === 9)
  list = cams.map((c) => (c.nvr === 'a' && c.ch === 0 ? { ...c, online: false } : c))
  w.run()
  check('a camera that went offline is let go', streams.get('a/0').viewers.size === 0)
}

{
  // every online camera of an NVR that is not refusing streams, on top of the first screens
  const cams = [
    ...Array.from({ length: 20 }, (_, i) => ({ nvr: 'calm', ch: i, online: true })),
    ...Array.from({ length: 20 }, (_, i) => ({ nvr: 'busy', ch: i, online: true })),
    { nvr: 'calm', ch: 99, online: false }
  ]
  const got = pickWarm({ cameras: cams, orders: {}, roomy: (id) => id === 'calm' })
  check('a calm NVR: up to 16 of its online cameras are kept ready', got.filter((k) => k.startsWith('calm/')).length === 16)
  check('an offline camera is not', !got.includes('calm/99'))
  check('a refusing NVR: only what the first-screen rule picked', got.filter((k) => k.startsWith('busy/')).length === 0)
  check('without roomy: the old first-screen rule', pickWarm({ cameras: cams, orders: {} }).length === 9)
}
{
  // an NVR that refuses once stays out of the extra warm-up for 6 h, even after it goes quiet
  let t = 0
  let refusing = false
  const cams = Array.from({ length: 30 }, (_, i) => ({ nvr: 'v', ch: i, online: true }))
  const fake = () => ({ clients: new Set(), add(w) { this.clients.add(w) }, remove(w) { this.clients.delete(w) } })
  const w = startWarmStreams({ cameras: () => cams, orders: () => ({}), streamOf: fake, roomy: () => !refusing, log: () => {}, everyMs: 1e9, now: () => t, firstRunMs: 0, outFile: null })
  w.run()
  check('calm: 16 kept ready', w.held.size === 16, String(w.held.size))
  refusing = true
  w.run()
  check('refusing: the extra ones are let go, 2 per pass', w.held.size === 14, String(w.held.size))
  for (let i = 0; i < 3; i++) w.run()
  check('... back to the first screen (9) after 4 passes', w.held.size === 9, String(w.held.size))
  refusing = false
  t += 60 * 60_000
  w.run()
  check('quiet again an hour later: still only the first screen', w.held.size === 9, String(w.held.size))
  t += 6 * 60 * 60_000
  w.run()
  check('six hours on: warmed again', w.held.size === 16, String(w.held.size))
}
const fake = () => ({ clients: new Set(), add(v) { this.clients.add(v) }, remove(v) { this.clients.delete(v) } })
{
  // nothing is warmed in the first 5 minutes after a start (which NVRs refuse is not known yet)
  let t = 1_000_000
  const cams = Array.from({ length: 20 }, (_, i) => ({ nvr: 'v', ch: i, online: true }))
  const w = startWarmStreams({ cameras: () => cams, orders: () => ({}), streamOf: fake, roomy: () => true, log: () => {}, everyMs: 1e9, now: () => t, outFile: null })
  check('first run: 5 minutes after start by default', FIRST_RUN_MS === 5 * 60_000)
  w.run()
  t += FIRST_RUN_MS - 1000
  w.run()
  check('nothing is added before 5 min', w.held.size === 0, String(w.held.size))
  t += 1000
  w.run()
  check('... and the first screen plus the extra ones at 5 min', w.held.size === 16, String(w.held.size))
}
{
  // an NVR kept out is still kept out after a restart (warm-out.json)
  const file = join(mkdtempSync(join(tmpdir(), 'warm-out-')), 'warm-out.json')
  let t = 5_000_000
  const cams = Array.from({ length: 30 }, (_, i) => ({ nvr: i < 20 ? 'v' : 'calm', ch: i, online: true }))
  let refusing = true
  const opts = { cameras: () => cams, orders: () => ({}), streamOf: fake, roomy: (id) => !(refusing && id === 'v'), log: () => {}, everyMs: 1e9, now: () => t, firstRunMs: 0, outFile: file }
  const a = startWarmStreams(opts)
  a.run()
  let saved = null
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  check('an NVR put out is written to the file with its end', saved?.v === t + 6 * 60 * 60_000 && saved.calm === undefined, JSON.stringify(saved))
  refusing = false // quiet now: a new instance must still keep it out
  t += 30 * 60_000
  const b = startWarmStreams(opts)
  check('outUntil is read back by a new instance', b.outUntil.get('v') === saved?.v, JSON.stringify([...b.outUntil]))
  b.run()
  const vHeld = [...b.held.keys()].filter((k) => k.startsWith('v/')).length
  check('... and that NVR stays at the first-screen rule', vHeld === 9, String(vHeld))
  t += 6 * 60 * 60_000
  const c = startWarmStreams(opts)
  check('an entry that has run out is not read back', !c.outUntil.has('v'))
  check('the default file is warm-out.json in the data folder', OUT_FILE === join(process.env.DATA_DIR, 'warm-out.json'))
  check('(these tests wrote nothing into the default data folder)', !existsSync(OUT_FILE))
}
{
  // an NVR that goes on refusing: the saved end moves on with it, so a restart 7 h after the first
  // refusal (a deploy) still keeps it out
  const file = join(mkdtempSync(join(tmpdir(), 'warm-out-')), 'warm-out.json')
  let t = 9_000_000
  const cams = Array.from({ length: 30 }, (_, i) => ({ nvr: i < 20 ? 'v' : 'calm', ch: i, online: true }))
  let refusing = true
  const opts = { cameras: () => cams, orders: () => ({}), streamOf: fake, roomy: (id) => !(refusing && id === 'v'), log: () => {}, everyMs: 1e9, now: () => t, firstRunMs: 0, outFile: file }
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
  const a = startWarmStreams(opts)
  a.run()
  const first = read()?.v
  t += 60_000
  a.run() // one pass later: moved on 1 min in memory, not written yet
  check('refusing on: the file is not rewritten at every pass', read()?.v === first && a.outUntil.get('v') === t + 6 * 60 * 60_000, `${(a.outUntil.get('v') - read()?.v) / 1000} s behind`)
  for (let i = 0; i < 7 * 60; i++) { t += 60_000; a.run() } // 7 h of passes, refusing all along
  const lag = a.outUntil.get('v') - read()?.v
  check(`refusing on for 7 h: the saved end follows (at most ${OUT_SAVE_STEP_MS / 60_000} min behind)`, lag >= 0 && lag < OUT_SAVE_STEP_MS, `${lag / 1000} s behind`)
  refusing = false
  t += 5 * 60_000 // a restart
  const b = startWarmStreams(opts)
  check('... a restart then keeps it out', b.outUntil.get('v') > t, `${(b.outUntil.get('v') - t) / 60_000} min left`)
  b.run()
  const vHeld = [...b.held.keys()].filter((k) => k.startsWith('v/')).length
  check('... at the first-screen rule', vHeld === 9, String(vHeld))
}
{
  // many warm streams no longer wanted at once are let go 2 per NVR per pass, not together
  let t = 0
  let cams = Array.from({ length: 16 }, (_, i) => ({ nvr: 'n', ch: i, online: true }))
  const w = startWarmStreams({ cameras: () => cams, orders: () => ({}), streamOf: fake, roomy: () => true, log: () => {}, everyMs: 1e9, now: () => t, firstRunMs: 0, outFile: null })
  w.run()
  check('16 held', w.held.size === 16, String(w.held.size))
  cams = cams.map((c) => ({ ...c, online: false })) // all 16 drop off the list
  const sizes = []
  for (let i = 0; i < 9; i++) {
    w.run()
    sizes.push(w.held.size)
  }
  check(`dropping 16 keys releases ${RELEASE_PER_RUN} per run`, RELEASE_PER_RUN === 2 && sizes.join() === '14,12,10,8,6,4,2,0,0', sizes.join())
}
{
  // item 2: remote (P2P / serial) NVRs are never warmed -- their cameras are dropped from the picks
  const cams = [
    ...Array.from({ length: 12 }, (_, i) => ({ nvr: 'lan', ch: i, online: true })),
    ...Array.from({ length: 12 }, (_, i) => ({ nvr: 'p2p', ch: i, online: true }))
  ]
  check('without isRemote: remote cameras can be warmed', pickWarm({ cameras: cams, orders: {}, roomy: () => true }).some((k) => k.startsWith('p2p/')))
  const lanOnly = pickWarm({ cameras: cams, orders: {}, roomy: () => true, isRemote: (id) => id === 'p2p' })
  check('isRemote: only LAN cameras are warmed', lanOnly.every((k) => k.startsWith('lan/')) && lanOnly.length === 12, lanOnly.join(' '))
}
{
  // the box-wide cap: warm-ups stop at the warm budget, and a viewer preempts one (release)
  let box = 0
  const streams = new Map()
  const streamOf = (n, ch) => {
    const k = `${n}/${ch}`
    if (!streams.has(k)) streams.set(k, { clients: new Set(), add(v) { this.clients.add(v); box++ }, remove(v) { if (this.clients.delete(v)) box-- } })
    return streams.get(k)
  }
  const cams = Array.from({ length: 20 }, (_, i) => ({ nvr: 'a', ch: i, online: true }))
  const liveCap = { enabled: () => true, warmBudget: () => 5 }
  const w = startWarmStreams({ cameras: () => cams, orders: () => ({}), streamOf, roomy: () => true, liveCap, count: () => box, log: () => {}, everyMs: 1e9, firstRunMs: 0, outFile: null })
  w.run()
  check('warm-ups stop at the warm budget', w.held.size === 5 && box === 5, `${w.held.size}/${box}`)
  check('release drops background warm-ups and frees the slots at once', w.release(2) === 2 && w.held.size === 3 && box === 3, `${w.held.size} ${box}`)
  // a camera a real viewer has joined is never dropped
  const kept = [...w.held.values()][0].stream
  kept.clients.add({ real: true })
  check('a warm-up a viewer joined is never dropped', w.release(10) === 2 && w.held.size === 1 && [...w.held.values()][0].stream === kept, `${w.held.size}`)
}
{
  // cap OFF == today: with the cap off the budget and the remote-skip are inert (the caller gates
  // isRemote on enabled(), as server.mjs does), so run() warms exactly what it warms today
  let box = 0
  const streams = new Map()
  const streamOf = (n, ch) => {
    const k = `${n}/${ch}`
    if (!streams.has(k)) streams.set(k, { clients: new Set(), add(v) { this.clients.add(v); box++ }, remove(v) { if (this.clients.delete(v)) box-- } })
    return streams.get(k)
  }
  const cams = [
    ...Array.from({ length: 12 }, (_, i) => ({ nvr: 'lan', ch: i, online: true })),
    ...Array.from({ length: 12 }, (_, i) => ({ nvr: 'p2p', ch: i, online: true }))
  ]
  const off = { enabled: () => false, warmBudget: () => 5 }
  const w = startWarmStreams({ cameras: () => cams, orders: () => ({}), streamOf, roomy: () => true, liveCap: off, count: () => box, isRemote: (id) => off.enabled() && id === 'p2p', log: () => {}, everyMs: 1e9, firstRunMs: 0, outFile: null })
  w.run()
  const plain = pickWarm({ cameras: cams, orders: {}, roomy: () => true }) // what today warms, with no cap
  check('cap off: the budget does not limit warm-ups', w.held.size === plain.length && box === plain.length, `${w.held.size} vs ${plain.length}`)
  check('cap off: remote cameras are still warmed (no skip)', [...w.held.keys()].some((k) => k.startsWith('p2p/')))
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
