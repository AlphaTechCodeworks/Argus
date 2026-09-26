// Recorder: only online channels are recorded (empty and offline slots are skipped, a camera that
// comes online is picked up, one that goes offline leaves a 'camera offline' gap), and a stream
// the NVR refuses (fast refusal or no video within 8 s: LiveStream.lastFailure) is left alone for
// 5-10 minutes instead of being retried every minute. Fake streams and a fake clock: no SDK, no NVR.
// Run:  node cctv/test/recorder-online.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (n, ok, e = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}
const print = console.log.bind(console)
const logs = []
const { Recorder } = await import('../recorder.mjs')
console.log = (...a) => logs.push(a.join(' '))
console.warn = (...a) => logs.push(a.join(' '))
const say = (n, ok, e) => {
  if (!ok) failures++
  print(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`)
}

const DEFAULTS = { mode: 'continuous', fullDays: 30, after: 'timelapse', timelapseS: 10, retentionDays: 183, preS: 10, postS: 20 }
const loc = mkdtempSync(join(tmpdir(), 'rec-online-'))
writeFileSync(join(loc, '.cctv-recordings'), '{}')
const L = { id: 'L1', path: loc, role: 'main' }
const fakeStream = () => ({ clients: new Set(), lastFailure: null, add(ws) { this.clients.add(ws) }, remove(ws) { this.clients.delete(ws) } })
const wire = (isKey, ts) => {
  const b = Buffer.alloc(16 + 32)
  b[0] = isKey ? 1 : 0
  b.writeBigInt64LE(BigInt(ts * 1000), 8)
  return b
}

const streams = new Map()
const sent = []
let now = Date.UTC(2026, 8, 25, 10, 0, 10)
const chans = [
  { ch: 0, online: true },
  { ch: 1, online: false }, // offline / empty slot
  { ch: 2, online: true }
]
const rec = new Recorder({
  nvrId: 'n1',
  getStream: (ch) => streams.get(ch) ?? streams.set(ch, fakeStream()).get(ch),
  online: () => true,
  channels: () => chans.map((c) => ({ ...c })),
  send: (m) => sent.push(m),
  now: () => now
})
rec.apply({ recording: { defaults: DEFAULTS, cameras: {} }, locations: [L] })
say('offline slot: no stream taken, no camera', !streams.has(1) && !rec.cams.has(1))
say('online channels are tapped', streams.get(0)?.clients.size === 1 && streams.get(2)?.clients.size === 1)
say('no "recording on" line for the offline slot', !logs.some((l) => l.includes('n1/2]') && l.includes('recording on')))

// a camera that comes online is picked up at the next sync (the worker syncs every 250 ms)
chans[1].online = true
rec.sync()
say('camera comes online: tapped at the next sync', streams.get(1)?.clients.size === 1)

// ch0 records, then goes offline: tap removed, a 'camera offline' gap from the last frame
const tap0 = [...streams.get(0).clients][0]
tap0.send(wire(true, now))
now += 40
tap0.send(wire(false, now))
const lastTs = now
now += 1000
chans[0].online = false
rec.sync()
say('camera goes offline: its tap is removed (the stream may stop)', streams.get(0).clients.size === 0)
say('camera offline: kept in the recorder', rec.cams.has(0))
now += 60_000
chans[0].online = true
rec.sync()
say('back online: tapped again', streams.get(0).clients.size === 1)
const tap0b = [...streams.get(0).clients][0]
tap0b.send(wire(true, now))
await rec.idle()
const gap = sent.find((m) => m.t === 'recgap' && m.ch === 0)
say("a 'camera offline' gap row covers the time", gap?.reason === 'camera offline' && gap.fromMs === lastTs && gap.toMs === now, JSON.stringify(gap))

// fast refusal: the recorder leaves the camera alone for 5-10 min
const s2 = streams.get(2)
s2.lastFailure = { at: now, fast: true, reason: 'refused by the NVR in 30 ms (error 31)' }
now += 250
rec.sync()
const cam2 = rec.cams.get(2)
say('refused start: tap removed', s2.clients.size === 0)
const wait = cam2?.refusedUntil - now
say('refused start: backs off 5-10 minutes', wait >= 5 * 60_000 - 250 && wait <= 10 * 60_000, `${wait} ms`)
say('refusal logged once with the NVR error', logs.filter((l) => l.includes('n1/3') && l.includes('error 31')).length === 1, logs.filter((l) => l.includes('n1/3')).join(' | '))
now += 60_000
rec.sync()
rec.sync()
say('within the back-off: not tapped again, not logged again', s2.clients.size === 0 && logs.filter((l) => l.includes('n1/3') && l.includes('error 31')).length === 1)
say('status shows the refusal', rec.status()[2]?.refusedUntil === cam2.refusedUntil && /refused/.test(rec.status()[2]?.lastError?.reason ?? ''), JSON.stringify(rec.status()[2]))
now = cam2.refusedUntil + 1
rec.sync()
say('after the back-off: tapped again', s2.clients.size === 1)
// silent refusal (valid handle, no frame in 8 s) counts the same
s2.lastFailure = { at: now + 1, fast: true, silent: true, reason: 'no video within 8 s of starting' }
now += 10
rec.sync()
// Counted like any refusal: either it backs off, or -- since the sub-stream fallback
// (stream-choice.mjs, 2026-09-25) -- a camera refused again moves at once to its sub-stream,
// rather than recording nothing for the length of the back-off.
{
  const c2 = rec.cams.get(2)
  const backedOff = s2.clients.size === 0 && c2.refusedUntil > now + 4 * 60_000
  // (onSub is only set once the sub-stream is attached, on the next pass; refusedUntil 0 after a
  // refusal is the recorder choosing it: the only branch that clears the back-off)
  const movedToSub = c2.refusedUntil === 0 && c2.pick?.refusals >= 2
  say('silent refusal: counted like a refusal (backs off, or moves to the sub-stream)', backedOff || movedToSub, JSON.stringify({ refusedUntil: c2.refusedUntil - now, pick: c2.pick }))
}
// a slow failure (e.g. timeout) does not trigger the long back-off
now = rec.cams.get(2).refusedUntil + 1
rec.sync()
s2.lastFailure = { at: now + 1, fast: false, reason: 'timed out' }
now += 10
rec.sync()
say('slow failure: stays tapped (LiveStream retries on its own back-off)', s2.clients.size === 1)
now += 5000
s2.clients.values().next().value.send(wire(true, now))
await rec.idle()
const g2 = sent.filter((m) => m.t === 'recgap' && m.ch === 2)
say('refusal gap written with the reason', g2.some((g) => /refused/.test(g.reason)), JSON.stringify(g2))
// plain channel numbers (older callers) still count as online
{
  const st = new Map()
  const r2 = new Recorder({ nvrId: 'n2', getStream: (ch) => st.get(ch) ?? st.set(ch, fakeStream()).get(ch), online: () => true, channels: () => [0, 1], send: () => {}, now: () => now })
  r2.apply({ recording: { defaults: DEFAULTS, cameras: {} }, locations: [L] })
  say('plain channel numbers: all tapped', st.get(0)?.clients.size === 1 && st.get(1)?.clients.size === 1)
  await r2.stop()
}
{
  // worker wiring passes the online flag
  const { readFileSync } = await import('node:fs')
  const w = readFileSync(new URL('../nvr-worker.mjs', import.meta.url), 'utf8')
  say('nvr-worker passes each channel with its online flag', /channels: \(\) => nvr\.channels\.map\(\(c\) => \(\{ ch: c\.ch, online: c\.online/.test(w))
}
await rec.stop()
print(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
