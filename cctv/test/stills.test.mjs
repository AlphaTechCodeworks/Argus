// Tests for the kept still pictures (public/stills.js): a grid's tiles save their stills one at a time,
// at least 2 s apart, instead of all in the same second. Each save is a canvas draw and a JPEG encode on
// the page's main thread; grid tiles start 15 ms apart and every one of them was due each minute at the
// same moment, and on the owner's PC one such round took 156-559 ms of the main thread (stutter report
// 2.10, 29 Sep). A fake canvas and Cache Storage, a virtual clock: no browser.
// Run:  node cctv/test/stills.test.mjs
let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }

const T0 = Date.UTC(2026, 8, 29, 4, 0, 0)
let cases = 0

/**
 * A page of tiles calling maybeKeepStill on every frame, as live-tile.js does, on a virtual clock in
 * 5 ms steps. tiles: [{ ch, startMs, everyMs, untilMs? }]; encodeMs: how long a save's JPEG takes to
 * come back (toBlob's callback), or null for one that never does.
 * @returns the saves as { ch, at } (when drawn), when each finished, and the most under way at once
 */
async function run({ tiles, durMs, encodeMs = () => 40 }) {
  const { maybeKeepStill } = await import(`../public/stills.js?case=${++cases}`)
  let now = T0
  const saves = [] // { ch, at } in the order drawn
  const finished = [] // { ch, at } when its put resolved
  const pending = [] // { at, run } toBlob callbacks to call at `at`
  let underWay = 0
  let most = 0
  let drawing = null // the tile whose canvas is being copied (set around the call)
  globalThis.caches = { open: async () => ({ put: async (key) => { finished.push({ key, at: now }); underWay-- } }) }
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => { saves.push({ ch: drawing, at: now }); underWay++; most = Math.max(most, underWay) } }),
      toBlob(cb) {
        const ms = encodeMs(saves.length)
        if (ms !== null) pending.push({ at: now + ms, run: () => cb(new Blob([new Uint8Array(100)])) })
      }
    })
  }
  const canvases = new Map(tiles.map((t) => [t.ch, { width: 704, height: 480 }]))
  for (let t = 0; t <= durMs; t += 5) {
    now = T0 + t
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at > now) continue
      pending.splice(i, 1)[0].run()
    }
    // (the put's promise and the callback's finally: a few turns of the microtask queue)
    for (let k = 0; k < 4; k++) await null
    for (const tile of tiles) {
      if (t < tile.startMs || (tile.untilMs != null && t >= tile.untilMs) || (t - tile.startMs) % tile.everyMs !== 0) continue
      drawing = tile.ch
      maybeKeepStill(canvases.get(tile.ch), 'nvr-2', tile.ch, now)
      drawing = null
    }
  }
  delete globalThis.caches
  delete globalThis.document
  return { saves, finished, most }
}

const gaps = (saves) => saves.slice(1).map((s, i) => s.at - saves[i].at)
const grid = (n, everyMs = 50) => Array.from({ length: n }, (_, i) => ({ ch: i, startMs: i * 15, everyMs }))

// ---- 27 tiles of a 5x5 grid and two neighbours, 20 fps, started 15 ms apart
{
  // (115 s: the second round is over by about 112 s, and the third would start at 120 s)
  const { saves, most } = await run({ tiles: grid(27), durMs: 115_000 })
  const first = saves.slice(0, 27)
  check('27 tiles: every camera kept a still in the first round', new Set(first.map((s) => s.ch)).size === 27, `${new Set(first.map((s) => s.ch)).size} cameras in the first 27 saves`)
  check('... one at a time: never two saves under way at once', most === 1, `${most} at once`)
  check('... at least 2 s apart, every one', gaps(saves).every((g) => g >= 2000), `smallest gap ${Math.min(...gaps(saves))} ms`)
  check('... and not much more: the round takes about 27 x 2 s', first.at(-1).at - first[0].at <= 27 * 2000 + 500, `${first.at(-1).at - first[0].at} ms`)
  check('... in the order the cameras became due', first.map((s) => s.ch).join() === first.map((_, i) => i).join(), first.map((s) => s.ch).join())
  const byCam = new Map()
  for (const s of saves) (byCam.get(s.ch) ?? byCam.set(s.ch, []).get(s.ch)).push(s.at)
  const minEvery = Math.min(...[...byCam.values()].flatMap((a) => gaps(a.map((at) => ({ at })))))
  check('... each camera still at most once a minute', minEvery >= 60_000, `${minEvery} ms`)
  check('... and again a minute later (the second round)', [...byCam.values()].every((a) => a.length === 2), [...byCam.values()].map((a) => a.length).join())
}

// ---- a trickling camera (a frame every 2.5 s) among 20 fps ones is not passed over at every turn
{
  const tiles = grid(12)
  tiles[3] = { ch: 3, startMs: 45, everyMs: 2500 }
  const { saves } = await run({ tiles, durMs: 40_000 })
  const order = saves.map((s) => s.ch)
  check('a camera sending a frame every 2.5 s keeps its turn in the queue', order.slice(0, 12).join() === '0,1,2,3,4,5,6,7,8,9,10,11', order.join())
  check('... and every save stays 2 s apart', gaps(saves).every((g) => g >= 2000), gaps(saves).join())
}

// ---- 64 tiles (8x8): more than a minute of turns; still one at a time, every camera in turn
{
  const { saves, most } = await run({ tiles: grid(64), durMs: 140_000 })
  check('64 tiles: one at a time, 2 s apart', most === 1 && gaps(saves).every((g) => g >= 2000), `${most} at once, smallest gap ${Math.min(...gaps(saves))} ms`)
  check('... every camera had its turn before any had a second', new Set(saves.slice(0, 64).map((s) => s.ch)).size === 64, `${new Set(saves.slice(0, 64).map((s) => s.ch)).size} of 64`)
}

// ---- a tile that closed while waiting its turn does not hold up the rest for more than 5 s
{
  const tiles = grid(4)
  tiles[1] = { ch: 1, startMs: 15, everyMs: 50, untilMs: 1000 } // gone after 1 s, before its turn at 2 s
  const { saves } = await run({ tiles, durMs: 12_000 })
  const order = saves.map((s) => s.ch)
  check('a tile gone before its turn: the next camera goes within 5 s of the turn it missed', order.join() === '0,2,3' && saves[1].at - T0 <= 2000 + 5000 + 50, `${order.join()} at ${saves.map((s) => s.at - T0).join()}`)
}

// ---- a save whose JPEG never comes back holds the next no longer than 10 s
{
  const { saves } = await run({ tiles: grid(3), durMs: 20_000, encodeMs: (n) => (n === 1 ? null : 40) })
  check('a save that never finished: the next one goes 10 s after it started', saves.length === 3 && saves[1].at - saves[0].at >= 10_000 && saves[1].at - saves[0].at <= 10_100, saves.map((s) => s.at - T0).join())
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
