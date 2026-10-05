// Practice page for the colour check (colour-check-demo.html): a simulated camera picture
// (colour-chart-sim.js, the same pictures the offline tests use) with a chosen fault, and the
// real ColourCheck on it. Static: it calls no /api route and talks to no camera or NVR; "Use
// these" only lists what the Picture panel would be given.
//
// The pictures reach the check the way the app's will: a stand-in player hands decoded frames
// (VideoFrames) to playerFrames(), as the real player's grabAfterKey does. For testing the other
// routes: ?source=screen reads the picture as a browser shows it without the display range fix
// (player.grab() and limited range), ?source=planes hands the planes over directly (getFrame).
import { squareToQuad } from './colour-check.js'
import { ColourCheck, playerFrames } from './colour-check-ui.js'
import { drawCard, drawChart, frameToRGBA } from './colour-chart-sim.js'

const W = 1920
const H = 1080
// the chart's patch area as the tests hold it: about 700 x 470 px, turned, in slight perspective
const CHART = [[600, 300], [1330, 340], [1300, 820], [620, 790]]
const CARD = [[800, 400], [1100, 420], [1090, 640], [805, 625]]
const TINY = [[900, 500], [940, 502], [939, 528], [901, 526]]
const BORDER = 0.4 // a real chart's black surround, in squares
const turned = (c, turn) => [0, 1, 2, 3].map((i) => c[(i + turn) % 4])
const mirrored = (c) => [c[1], c[0], c[3], c[2]] // square 1 at the top right: the camera's Mirror
/** The outer corners of the chart's black surround: where the corners must NOT go. */
function edgeOf(c, b) {
  const q = squareToQuad(c)
  const at = (u, v) => {
    const w = q.g * u + q.h * v + 1
    return [Math.round((q.a * u + q.b * v + q.c) / w), Math.round((q.d * u + q.e * v + q.f) / w)]
  }
  return [at(-b / 6, -b / 4), at(1 + b / 6, -b / 4), at(1 + b / 6, 1 + b / 4), at(-b / 6, 1 + b / 4)]
}
const SOURCE = new URLSearchParams(location.search).get('source') // null (VideoFrames), 'screen', 'planes'
const SHOWN = SOURCE === 'screen' ? { range: 'limited', matrix: 'bt709' } : { range: 'full', matrix: 'bt709' }

/** Behind the chart: sky, a brick wall and grass, plain enough never to look like a chart. */
function yard(x, y) {
  const t = y / H
  if (t < 0.3) return [182 - 50 * t, 140, 121]
  if (t < 0.68) {
    const row = Math.floor(y / 36)
    const mortar = y % 36 < 3 || (x + (row % 2) * 45) % 90 < 3
    return mortar ? [150, 126, 130] : [108 + 6 * Math.sin(x / 53 + row), 118, 142]
  }
  return [84 - 30 * (t - 0.68), 112, 118]
}

const chart = (opts = {}) => () => drawChart({ corners: CHART, border: BORDER, background: yard, W, H, ...opts })
const card = (rgb) => () => drawCard({ corners: CARD, rgb, background: yard, W, H })
const SCENES = {
  perfect: { label: 'Perfect camera', mode: 'chart', corners: CHART, draw: chart() },
  upside: { label: 'Chart held upside down', mode: 'chart', corners: CHART, draw: () => drawChart({ corners: turned(CHART, 2), border: BORDER, background: yard, W, H }) },
  dark: { label: 'Darker exposure', mode: 'chart', corners: CHART, draw: chart({ look: (rgb) => rgb.map((c) => c * 0.7) }) },
  warm: { label: 'Warm (orange) cast', mode: 'chart', corners: CHART, draw: chart({ look: ([r, g, b]) => [r * 1.18, g, b * 0.9] }) },
  washed: {
    label: 'Washed-out colours',
    mode: 'chart',
    corners: CHART,
    draw: chart({ look: (rgb) => {
      const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
      return rgb.map((c) => Y + (c - Y) * 0.65)
    } })
  },
  glare: { label: 'Glare on a square', mode: 'chart', corners: CHART, draw: chart({ glare: 6 }) },
  edge: { label: 'Corners on the black edge (a mistake)', mode: 'chart', corners: edgeOf(CHART, BORDER), draw: chart() },
  mirror: { label: 'Camera’s Mirror setting on', mode: 'chart', corners: CHART, mirror: true, draw: () => drawChart({ corners: mirrored(CHART), border: BORDER, background: yard, W, H }) },
  small: { label: 'Chart too small (too far away)', mode: 'chart', corners: TINY, draw: () => drawChart({ corners: TINY, border: BORDER, background: yard, W, H }) },
  mono: { label: 'Black and white (night mode)', mode: 'chart', corners: CHART, draw: chart({ mono: true }) },
  card: { label: 'White card, neutral camera', mode: 'card', corners: CARD, draw: card([0.9, 0.9, 0.9]) },
  warmcard: { label: 'White card, warm camera', mode: 'card', corners: CARD, draw: card([0.92, 0.85, 0.72]) },
  blowncard: { label: 'White card, over-exposed', mode: 'card', corners: CARD, draw: card([1, 1, 1]) },
  nopicture: { label: 'Camera sends no picture', mode: 'chart', corners: CHART, draw: chart(), fails: true }
}

const $ = (s) => document.querySelector(s)
const tile = $('#tile')
const video = $('#video')
const sceneSel = $('#scene')
const wbSel = $('#wb')
const hints = $('#hints')
const log = $('#log')
const source = document.createElement('canvas') // the picture at its own size (the "decoded frame")
source.width = W
source.height = H
let scene = SCENES.perfect
let frame = null

for (const [key, s] of Object.entries(SCENES)) sceneSel.append(new Option(s.label, key))

function render() {
  frame = scene.draw()
  source.getContext('2d').putImageData(new ImageData(frameToRGBA(frame, SHOWN), W, H), 0, 0)
  show()
}

/** As the player does: the canvas's backing store is the on-screen size, capped at the video's. */
function show() {
  const box = video.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const scale = Math.min(1, (box.width * dpr) / W, (box.height * dpr) / H)
  const w = Math.max(2, Math.round(W * scale))
  const h = Math.max(2, Math.round(H * scale))
  if (video.width !== w || video.height !== h) {
    video.width = w
    video.height = h
  }
  const g = video.getContext('2d')
  g.drawImage(source, 0, 0, w, h)
  if (!hints.checked) return
  g.strokeStyle = '#ffcf87'
  g.lineWidth = 2
  for (const [x, y] of scene.corners) {
    g.beginPath()
    g.arc(((x + 0.5) / W) * w, ((y + 0.5) / H) * h, 7, 0, 2 * Math.PI)
    g.stroke()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The picture now, as coded planes (a live picture is never quite still: a little noise). */
function noisy() {
  const y = frame.y.slice()
  for (let i = 0; i < y.length; i += 7) y[i] = Math.max(0, Math.min(255, y[i] + ((Math.random() * 3) | 0) - 1))
  return { ...frame, y }
}

async function getFrame() {
  await sleep(40)
  if (scene.fails) throw new Error('the camera sent no picture')
  return noisy()
}

/**
 * A stand-in for the app's VideoPlayer, with the parts playerFrames() uses: grabAfterKey hands
 * clones of decoded frames (here VideoFrames made from the simulated planes) to a sink, one
 * wait for a keyframe first; grab() gives the picture as shown, and displayColour() says how.
 */
const player = {
  stats: { fps: 20 },
  closed: false,
  gop: null,
  displayColour: () => ({ ...SHOWN, rangeFixed: SHOWN.range === 'full' }),
  async grab() {
    await sleep(60)
    if (scene.fails) throw new Error('no picture')
    return new ImageData(frameToRGBA(noisy(), SHOWN), W, H)
  },
  grabAfterKey({ offsets, sink, signal }) {
    if (this.gop) return Promise.reject(new Error('a measurement is already running'))
    const gop = (this.gop = {})
    return new Promise((resolve, reject) => {
      const end = (fn, v) => {
        if (this.gop !== gop) return
        this.gop = null
        fn(v)
      }
      signal?.addEventListener('abort', () => end(reject, Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
      ;(async () => {
        await sleep(250) // the next keyframe
        if (scene.fails) return end(reject, new Error('no picture'))
        for (let i = 0; i < offsets.length; i++) {
          if (i) await sleep((offsets[i] - offsets[i - 1]) * 50)
          if (this.gop !== gop) return
          const f = noisy()
          const buf = new Uint8Array(W * H * 1.5)
          buf.set(f.y, 0)
          buf.set(f.u, W * H)
          buf.set(f.v, W * H * 1.25)
          sink(new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: i * 50_000 }), { set: 0, sinceKey: offsets[i], displayRange: SHOWN.range, displayMatrix: SHOWN.matrix })
        }
        end(resolve, { frames: offsets.length, complete: true, reason: 'complete' })
      })()
    })
  }
}
if (SOURCE === 'screen' || typeof VideoFrame !== 'function') delete player.grabAfterKey

/** The camera's picture settings, as the Picture panel lists them (for the suggestions). */
function fields() {
  const range = (path, label) => ({ path, label, kind: 'range', min: 0, max: 100, value: 50, default: 50 })
  return [
    { path: 'whiteBalance.mode', label: 'White balance', kind: 'select', options: ['auto', 'indoor', 'outdoor', 'manual'], value: wbSel.value, default: 'auto' },
    range('whiteBalance.red', 'Red gain'),
    range('whiteBalance.blue', 'Blue gain'),
    range('saturation', 'Saturation'),
    range('hue', 'Hue'),
    range('contrast', 'Contrast'),
    { path: 'mirrorSwitch', label: 'Mirror', kind: 'switch', value: Boolean(scene.mirror), default: false },
    { path: 'flipSwitch', label: 'Flip', kind: 'switch', value: false, default: false }
  ]
}

const check = new ColourCheck({
  host: () => tile,
  video: () => video,
  ...(SOURCE === 'planes' ? { getFrame } : { getFrames: playerFrames(() => player) }),
  decode: { range: 'full', matrix: 'bt709' },
  fields,
  camera: 'Practice camera',
  onSuggest: (list) => {
    log.replaceChildren('The Picture panel would get these unsent changes (nothing is sent anywhere):')
    const ul = document.createElement('ul')
    for (const x of list) ul.append(Object.assign(document.createElement('li'), { textContent: `${x.label}: ${x.from} → ${x.to} (${x.why})` }))
    log.append(ul)
  },
  onClose: () => {}
})

// the real full-size view closes on a click: show if one ever gets through the colour check
tile.addEventListener('click', () => {
  if (!check.isOpen) return
  log.textContent = 'A click reached the tile: in the app this would have closed the full-size view.'
})

sceneSel.addEventListener('change', () => {
  scene = SCENES[sceneSel.value]
  render()
})
hints.addEventListener('change', show)
$('#start').addEventListener('click', () => check.open({ mode: scene.mode }))
new ResizeObserver(show).observe(video)

// for checking the page by script: where the scene's true corners are on screen now
window.ccDemo = {
  check,
  player,
  source: SOURCE ?? 'videoframe',
  corners() {
    const r = video.getBoundingClientRect()
    const s = Math.min(r.width / video.width, r.height / video.height)
    const w = video.width * s
    const h = video.height * s
    const left = r.left + (r.width - w) / 2
    const top = r.top + (r.height - h) / 2
    return scene.corners.map(([x, y]) => [left + ((x + 0.5) / W) * w, top + ((y + 0.5) / H) * h])
  },
  frameSize: [W, H]
}

render()
