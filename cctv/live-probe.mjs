// Prototype: opens a live stream via NET_SDK_LivePlay and reports frame info + codec.
import koffi from 'koffi'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { Device } from '../build/device.js'

const { TVT_HOST, TVT_PORT = '6036', TVT_USER, TVT_PASS, CH = '1', STREAM = '1' } = process.env
const lib = koffi.load('/app/bin/linux/libdvrnetsdk.so')

const FRAME_INFO = koffi.struct('NET_SDK_FRAME_INFO_P', {
  deviceID: 'uint32', channel: 'uint32', frameType: 'uint32', length: 'uint32', keyFrame: 'uint32',
  width: 'uint32', height: 'uint32', frameIndex: 'uint32', frameAttrib: 'uint32', streamID: 'uint32',
  time: 'int64', relativeTime: 'int64'
})
const CLIENTINFO = koffi.struct('NET_SDK_CLIENTINFO_P', { lChannel: 'long', streamType: 'long', hPlayWnd: 'void *', bNoDecode: 'int' })
const LiveCb = koffi.proto('void LiveCbP(int64 handle, NET_SDK_FRAME_INFO_P info, uint8 *buf, void *user)')
const LivePlay = lib.func('int64 NET_SDK_LivePlay(long userId, NET_SDK_CLIENTINFO_P *ci, LiveCbP *cb, void *user)')
const StopLivePlay = lib.func('bool NET_SDK_StopLivePlay(int64 handle)')

const device = await Device.create(TVT_HOST, Number(TVT_PORT))
await device.login(TVT_USER, TVT_PASS)
await sleep(2000)

const chunks = []
const types = {}
let shown = 0
const cb = koffi.register((h, info, buf, user) => {
  types[info.frameType] = (types[info.frameType] ?? 0) + 1
  const data = Buffer.from(koffi.decode(buf, 'uint8', info.length))
  if (info.frameType === 1) chunks.push(data)
  if (shown < 6 || info.frameType !== 1) {
    shown++
    console.log(`type=${info.frameType} key=${info.keyFrame} ${info.width}x${info.height} len=${info.length} attrib=0x${info.frameAttrib.toString(16)} head=${data.subarray(0, 24).toString('hex')}`)
  }
}, koffi.pointer(LiveCb))

// streamType: 0 = main stream, 1 = sub stream (NET_SDK_STREAM_TYPE)
const handle = LivePlay(device.userId, { lChannel: Number(CH), streamType: Number(STREAM), hPlayWnd: null, bNoDecode: 1 }, cb, null)
console.log('LivePlay handle:', handle, handle <= 0 ? await device.getLastError() : '')
await sleep(6000)
StopLivePlay(handle)
koffi.unregister(cb)
console.log('frame type counts:', types)
writeFileSync('/app/snapshots/probe.bin', Buffer.concat(chunks))
await device.logout()
await device.dispose()
