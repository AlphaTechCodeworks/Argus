// Auto adjust's measuring, off the page's thread: the page transfers decoded VideoFrames here
// (player.grabAfterKey), each is copied out of the decoder's memory at once and closed (a
// decoder has only a few output frames; holding them stalls the live view), then measured.
//
// Messages in:  { type: 'start', opts }               new Measurer(opts)
//               { type: 'frame', frame, meta }        meta: { set, sinceKey, ts, aligned,
//                                                      displayMatrix?, displayRange?, selfCheck? }
//               { type: 'result', id }
// Messages out: { type: 'added', ms, selfCheck? }     per frame
//               { type: 'result', id, result }        Measurer.result() plus selfCheck
//               { type: 'error', id?, message }
// Messages are handled strictly in order, so a result covers every frame sent before it.
import { Measurer, displaySelfCheck, matrixName, planesFromRGBA, selfCheckRegion } from './picture-check.js'

let measurer = null
let buf = null // copyTo target, reused (allocationSize of the frame)
let selfChecks = []
let chain = Promise.resolve()

const post = (msg) => self.postMessage(msg)

/** A frame drawn by the browser, as ImageData (what it would show), at w x h. */
function drawn(frame, w, h) {
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.drawImage(frame, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

/** A region of the frame (coded-plane pixels W x H) as the browser draws it, 1:1. */
function drawnRegion(frame, r, W, H) {
  const canvas = new OffscreenCanvas(r.sw, r.sh)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  // a VideoFrame is drawn at its display size; the same as the coded planes unless anamorphic
  const kx = (frame.displayWidth || W) / W
  const ky = (frame.displayHeight || H) / H
  g.drawImage(frame, r.sx * kx, r.sy * ky, r.sw * kx, r.sh * ky, 0, 0, r.sw, r.sh)
  return g.getImageData(0, 0, r.sw, r.sh)
}

/** The frame's planes: coded values for I420/NV12, else the browser's RGBA (format null). */
async function planesOf(frame) {
  const fmt = frame.format
  const W = frame.visibleRect?.width ?? frame.codedWidth
  const H = frame.visibleRect?.height ?? frame.codedHeight
  if (fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12') {
    const size = frame.allocationSize()
    if (!buf || buf.byteLength < size) buf = new Uint8Array(size)
    const layout = await frame.copyTo(buf)
    const at = (i) => buf.subarray(layout[i].offset)
    if (fmt === 'NV12') return { width: W, height: H, chroma: 'NV12', y: at(0), yStride: layout[0].stride, uv: at(1), uvStride: layout[1].stride, planes: 'coded' }
    return { width: W, height: H, chroma: 'I420', y: at(0), yStride: layout[0].stride, u: at(1), uStride: layout[1].stride, v: at(2), vStride: layout[2].stride, planes: 'coded' }
  }
  // an opaque (GPU) frame or an RGB one: measure what the browser draws of it
  return planesFromRGBA(drawn(frame, frame.displayWidth, frame.displayHeight))
}

/** How the browser shows this frame: its colour space as the decoder output it. */
function displayOf(frame, meta) {
  const cs = frame.colorSpace ?? {}
  return {
    displayMatrix: meta.displayMatrix ?? matrixName(cs.matrix ?? 'bt709'),
    displayRange: meta.displayRange ?? (cs.fullRange === true ? 'full' : 'limited')
  }
}

async function handle(msg) {
  if (msg.type === 'start') {
    measurer = new Measurer(msg.opts ?? {})
    selfChecks = []
    return
  }
  if (msg.type === 'frame') {
    const { frame, meta = {} } = msg
    let p
    let small = null
    let region = null
    try {
      p = await planesOf(frame)
      // coded planes are shown through the frame's colour space; drawn ones already were
      if (p.planes === 'coded') Object.assign(p, displayOf(frame, meta))
      // the display self-check: a region of the same frame as this browser draws it, 1:1,
      // compared with what each kind of display would show of that region's coded values
      if (meta.selfCheck && p.planes === 'coded') {
        region = selfCheckRegion(p, p.displayMatrix)
        if (region) small = drawnRegion(frame, region, p.width, p.height)
      }
    } finally {
      frame.close()
    }
    measurer ??= new Measurer({})
    const { ms } = measurer.add({ ...p, set: meta.set, sinceKey: meta.sinceKey, ts: meta.ts, aligned: meta.aligned })
    let check = null
    if (small) {
      check = { set: meta.set ?? 0, ...displaySelfCheck(small, region), region: [region.sx, region.sy, region.sw, region.sh] }
      selfChecks.push(check)
    }
    post({ type: 'added', ms, selfCheck: check })
    return
  }
  if (msg.type === 'result') {
    const result = measurer?.result() ?? null
    if (result) result.selfCheck = selfChecks.length ? { ...selfChecks[selfChecks.length - 1], all: selfChecks.map((c) => c.range) } : null
    post({ type: 'result', id: msg.id, result })
  }
}

self.onmessage = (e) => {
  const msg = e.data
  chain = chain
    .then(() => handle(msg))
    .catch((err) => {
      msg.frame?.close?.()
      post({ type: 'error', id: msg.id, message: err?.message ?? String(err) })
    })
}
