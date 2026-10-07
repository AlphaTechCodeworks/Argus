// The motion tuning panel (public/motion-tune.js): choosing another camera while the first one's
// NVR is still being asked. Stand-ins for the page, the live tile's socket, fetch and the timers; no
// server, no NVR.
// Run:  node cctv/test/motion-tune-ui.test.mjs
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

// ---- stand-ins
globalThis.window = { devicePixelRatio: 1 }
globalThis.requestAnimationFrame = () => 1
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.location = { protocol: 'http:', host: 'x' }
globalThis.WebSocket = class {
  close() {}
}
WebSocket.OPEN = 1
const ctx2d = { clearRect() {}, fillRect() {}, strokeRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8Array(0) }) }
const el = () => ({
  textContent: '', innerHTML: '', hidden: false, className: '', title: '', width: 0, height: 0,
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  elements: { threshold: { value: '' } },
  append() {}, replaceChildren() {}, addEventListener() {},
  getContext: () => ctx2d,
  getBoundingClientRect: () => ({ width: 320, height: 180 }),
  querySelector() { return el() }
})
globalThis.document = { createElement: () => el() }

// every sampling interval (twice a second) started and not yet cleared: a leaked one is the bug.
// The live tile keeps timers of its own, at other periods, which are not this panel's to count.
const running = new Set()
let nextTimer = 1
globalThis.setInterval = (_fn, ms) => { const id = nextTimer++; if (ms === 500) running.add(id); return id }
globalThis.clearInterval = (id) => { running.delete(id) }

// each read of an NVR's motion settings waits here until the test lets it answer
const asked = []
globalThis.fetch = (url) => new Promise((resolve) => asked.push({ url, answer: (body) => resolve({ json: async () => body }) }))
const settle = () => new Promise((r) => setImmediate(r))

const { MotionTuner } = await import('../public/motion-tune.js')
const els = { tile: el(), overlay: el(), meter: el(), note: el(), form: el(), error: el(), result: el() }
const A = { nvr: 'nvr1', ch: 0, name: 'Gate' }
const B = { nvr: 'nvr1', ch: 1, name: 'Yard' }
const answerA = { available: true, sensitivity: 80, area: null }
const answerB = { available: true, sensitivity: 20, area: null }

// ---- camera A is chosen, then camera B before A's NVR has answered; A's answer comes last
{
  const tuner = new MotionTuner(els)
  const a = tuner.show(A)
  const b = tuner.show(B)
  check('each camera is asked about by its own channel', asked.length === 2 && /channels\/0\/motion-tune$/.test(asked[0].url) && /channels\/1\/motion-tune$/.test(asked[1].url), asked.map((x) => x.url).join())
  check('no write control while the camera on show has no answer of its own', els.form.hidden === true && tuner.motion === null)
  asked[1].answer(answerB)
  await b
  check('camera B shows its own sensitivity', tuner.motion?.sensitivity === 20 && els.form.elements.threshold.value === 20 && els.form.hidden === false, JSON.stringify(tuner.motion))
  asked[0].answer(answerA)
  await a
  await settle()
  check('camera A’s late answer does not replace it', tuner.camera === B && tuner.motion?.sensitivity === 20 && els.form.elements.threshold.value === 20, JSON.stringify(tuner.motion))
  check('one sampling timer is running, not two', running.size === 1, String(running.size))
  tuner.stop()
  check('and stopping the panel stops it', running.size === 0, String(running.size))
}

// ---- the same, with the answers in the order they were asked for
{
  asked.length = 0
  const tuner = new MotionTuner(els)
  const a = tuner.show(A)
  const b = tuner.show(B)
  asked[0].answer(answerA)
  await a
  check('camera A’s answer, arriving after B was chosen, is not shown on B', tuner.motion === null && els.form.hidden === true && running.size === 0, JSON.stringify(tuner.motion))
  asked[1].answer(answerB)
  await b
  check('camera B’s own answer is', tuner.motion?.sensitivity === 20 && running.size === 1)
  tuner.stop()
}

// ---- the panel is closed while the NVR is still being asked
{
  asked.length = 0
  const tuner = new MotionTuner(els)
  const a = tuner.show(A)
  tuner.stop()
  asked[0].answer(answerA)
  await a
  check('an answer that arrives after the panel closed starts no timer', running.size === 0, String(running.size))
  const none = tuner.show(null)
  await none
  check('choosing no camera asks nothing and starts nothing', asked.length === 1 && running.size === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
