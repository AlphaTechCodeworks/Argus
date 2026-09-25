// Diagnostic: plays a few seconds of one recording and saves keyframes as JPEGs
// with their SDK timestamps, to compare with the time printed on the picture.
// One short playback on one extra login; read-only.
//   node cctv/test/osd-offset.mjs <ch 0-based> [minutesAgo]    (NVR from TVT_* env)
import koffi from 'koffi'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PB, fromDD, toDD } from '../playback.mjs'
import { CODEC_H265, NET_SDK, bind, codecOf, initSdk, playFrames, sdkCall } from '../sdk.mjs'

const { TVT_HOST, TVT_PORT = '6036', TVT_USER, TVT_PASS } = process.env
const ch = Number(process.argv[2] ?? 1)
const minutesAgo = Number(process.argv[3] ?? 10)
const main = process.argv[4] === "main" ? 1 : 0
const out = '/app/snapshots/osd'
mkdirSync(out, { recursive: true })
const GetDeviceTime = bind('bool NET_SDK_GetDeviceTime(long userId, _Out_ PB_DD_TIME *time)')
const iso = (ms) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ')

await initSdk()
const userId = await sdkCall(NET_SDK.Login, TVT_HOST, Number(TVT_PORT), TVT_USER, TVT_PASS, {})
if (userId < 0) throw new Error('login failed')
await sleep(1500)
const t = {}
await sdkCall(GetDeviceTime, userId, t)
const nvrNow = fromDD(t)
console.log(`NVR clock ${iso(nvrNow)} | container UTC ${new Date().toISOString()}`)

const start = nvrNow - minutesAgo * 60_000
const handle = await sdkCall(PB.PlayBackByTimeEx, userId, [ch], 1, toDD(start), toDD(start + 60_000), null, main)
console.log(`requested playback from ${iso(start)}, handle ${handle > 0 ? 'ok' : handle}`)
let codec = CODEC_H265
const frames = []
playFrames.claim(handle, (info, buf) => {
  if (info.frameType === 5) codec = codecOf(info, buf)
  if (info.frameType === 1 && info.keyFrame && frames.length < 3) {
    // buf is native memory, only valid during the callback: copy it
    const bytes = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(new Uint8Array(koffi.view(buf, info.length)))
    frames.push({ ts: Number(info.time) / 1000, rel: Number(info.relativeTime), bytes })
  }
})
await sdkCall(PB.SetPlayDataCallBack, handle, playFrames.callback, null)
for (let i = 0; i < 40 && frames.length < 3; i++) await sleep(250)
playFrames.release(handle)
await sdkCall(PB.StopPlayBack, handle)
await sdkCall(NET_SDK.Logout, userId)

for (const [i, f] of frames.entries()) {
  const ext = codec === CODEC_H265 ? 'hevc' : 'h264'
  const raw = `${out}/key${i}.${ext}`
  writeFileSync(raw, f.bytes)
  const jpg = `${out}/key${i}.jpg`
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', ext, '-i', raw, '-frames:v', '1', '-vf', 'scale=960:-2', jpg])
  console.log(`key${i}.jpg  SDK frame time ${iso(f.ts)}  (relativeTime ${f.rel})`)
}
process.exit(0)
