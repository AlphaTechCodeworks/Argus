// Tests picking the cameras to keep streaming ahead of Live (warm-streams.mjs).
//   node cctv/test/warm-streams.test.mjs
import { pickWarm, startWarmStreams } from '../warm-streams.mjs'

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
  const w = startWarmStreams({ cameras: () => list, orders: () => ({}), streamOf, log: () => {}, everyMs: 1e9 })
  w.run()
  check('the first screen has a viewer each', [...streams.values()].filter((s) => s.viewers.size === 1).length === 9)
  list = cams.map((c) => (c.nvr === 'a' && c.ch === 0 ? { ...c, online: false } : c))
  w.run()
  check('a camera that went offline is let go', streams.get('a/0').viewers.size === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
