// hik-core.mjs: error texts, the login's device information, the camera list from the IP channel
// configuration, and one SDK packet -> the browser's frame. No SDK, no device.
//   node cctv/test/hik-core.test.mjs
import { CODEC_H264, CODEC_H265, HEADER_SIZE, NOT_INSTALLED, P2P_NOT_SET_UP, channelsFrom, errorText, loginErrorText, makeFrameClock, makeFrameShaper, packFrame, parseDeviceCfgV40, parseDeviceInfoV40, sdkVersionText, sniffCodec, toAnnexB } from '../hik-core.mjs'
import { LAYOUT, alloc, writeField } from '../hik-structs.mjs'
import { H264_I, H264_P, fakeInfo, fakeIpConfig } from './fake-hik-sdk.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const J = (v) => JSON.stringify(v)

// ---- messages ----
check('not installed: the exact words', NOT_INSTALLED === 'Hikvision support is not installed on this server')
check('P2P: the exact words', P2P_NOT_SET_UP === 'Hikvision P2P needs Hik-Connect developer access (AppID) — not set up yet')
check('1: wrong user name or password', errorText(1) === 'wrong user name or password')
check('7: cannot connect', /cannot connect/.test(errorText(7)))
check('10: did not answer in time', /did not answer in time/.test(errorText(10)))
check('153: user locked', /locked/.test(errorText(153)))
check('52: too many users', /too many users/.test(errorText(52)))
check('an unknown code says its number', errorText(99999) === 'Hikvision SDK error 99999')
check('wrong password with tries left (device supports locking)', loginErrorText(1, { supportLock: 1, retryLoginTime: 3 }) === 'wrong user name or password (3 tries left before the user is locked)')
check('one try left: singular', /1 try left/.test(loginErrorText(1, { supportLock: 1, retryLoginTime: 1 })))
check('locked, with the time left', loginErrorText(153, { supportLock: 1, surplusLockTime: 1500 }) === 'the user is locked after too many wrong passwords (locked for another 1500 s)')
check('a device without locking: no count (the header says the fields are not valid then)', loginErrorText(1, { supportLock: 0, retryLoginTime: 3 }) === 'wrong user name or password')
check('SDK version as the demo prints it', sdkVersionText(0x06010b28) === 'V6.1.11.40')

// ---- device information ----
const di = alloc('NET_DVR_DEVICEINFO_V40')
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'sSerialNumber', 'DS-7608NI-K20820201234CCRR')
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'byChanNum', 0)
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'byStartChan', 1)
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'byIPChanNum', 8)
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'byHighDChanNum', 1)
writeField(di, 'NET_DVR_DEVICEINFO_V30', 'byStartDChan', 33)
writeField(di, 'NET_DVR_DEVICEINFO_V40', 'bySupportLock', 1)
writeField(di, 'NET_DVR_DEVICEINFO_V40', 'byRetryLoginTime', 4)
writeField(di, 'NET_DVR_DEVICEINFO_V40', 'dwSurplusLockTime', 0)
const info = parseDeviceInfoV40(di)
check('device info: serial', info.serial === 'DS-7608NI-K20820201234CCRR', info.serial)
check('device info: IP channels = low byte + 256 x high byte', info.ipChannels === 8 + 256, String(info.ipChannels))
check('device info: start of digital channels and the lock fields', info.startDChannel === 33 && info.supportLock === 1 && info.retryLoginTime === 4)

const dc = alloc('NET_DVR_DEVICECFG_V40')
writeField(dc, 'NET_DVR_DEVICECFG_V40', 'sDVRName', 'Yard NVR')
writeField(dc, 'NET_DVR_DEVICECFG_V40', 'byDevTypeName', 'DS-7608NI-K2')
check('device config: name and model name', J(parseDeviceCfgV40(dc)) === J({ name: 'Yard NVR', model: 'DS-7608NI-K2', serial: '' }))

// ---- channels ----
const ip = channelsFrom(fakeInfo({ ipChannels: 4 }), fakeIpConfig({ n: 4, offline: [2], empty: [3] }))
check('NVR: one camera per IP channel, ch 0..3', J(ip.map((c) => c.ch)) === '[0,1,2,3]')
check('NVR: SDK channel numbers from dwStartDChan (33..36)', J(ip.map((c) => c.sdkChannel)) === '[33,34,35,36]')
check('NVR: online from the NVR\'s own byEnable; an offline camera stays configured', ip[0].online && ip[1].online && !ip[2].online && ip[2].configured)
check('NVR: a slot with no device is not configured (and not online)', !ip[3].configured && !ip[3].online)
check('NVR: each camera\'s address from its IP device', ip[0].ip === '192.168.254.2' && ip[2].ip === '192.168.254.4', ip[0].ip)
const cam = channelsFrom(fakeInfo({ analogChannels: 1, startChannel: 1, ipChannels: 0 }), null)
check('IP camera (one analog channel, no IP channels): one camera, SDK channel 1, online', cam.length === 1 && cam[0].sdkChannel === 1 && cam[0].online && cam[0].configured)
const hybrid = channelsFrom(fakeInfo({ analogChannels: 2, startChannel: 1, ipChannels: 2 }), (() => {
  const b = fakeIpConfig({ n: 2, start: 33 })
  b[LAYOUT.NET_DVR_IPPARACFG_V40.fields.byAnalogChanEnable[0]] = 1 // analog 1 on, analog 2 off
  return b
})())
check('hybrid DVR: analog first (1, 2), then IP (33, 34); a disabled analog input is not a camera', J(hybrid.map((c) => [c.ch, c.sdkChannel, c.configured])) === J([[0, 1, true], [1, 2, false], [2, 33, true], [3, 34, true]]))
check('no more than 64 cameras from one group', channelsFrom(fakeInfo({ ipChannels: 300 }), fakeIpConfig({ n: 4 })).length <= 64)

// ---- frames ----
check('sniff: H.264 SPS', sniffCodec(H264_I) === CODEC_H264)
const H265_I = Buffer.from([0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01, 0, 0, 0, 1, 0x26, 0x01, 0xaf])
check('sniff: H.265 VPS', sniffCodec(H265_I) === CODEC_H265)
check('Annex B is passed as it is', toAnnexB(H264_I) === H264_I)
const avcc = Buffer.concat([Buffer.from([0, 0, 0, 4]), H264_I.subarray(4, 8), Buffer.from([0, 0, 0, 2]), Buffer.from([0x68, 0xce])])
const conv = toAnnexB(avcc)
check('4-byte length-prefixed NAL units are converted to Annex B', conv && conv.equals(Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0xce])))
check('anything else is refused (null)', toAnnexB(Buffer.from([1, 2, 3, 4, 5, 6])) === null)
const f = packFrame({ key: true, codec: CODEC_H265, width: 1920, height: 1080, timeUs: 1_700_000_000_000_123 }, Buffer.from([9, 9]))
check('frame header: sdk.mjs encodeFrame layout (key, codec, w, h, 0, µs)', f[0] === 1 && f[1] === 1 && f.readUInt16LE(2) === 1920 && f.readUInt16LE(4) === 1080 && f.readUInt16LE(6) === 0 && f.readBigInt64LE(8) === 1_700_000_000_000_123n && f.length === HEADER_SIZE + 2)

let t = 1_000_000
const clock = makeFrameClock({ now: () => t })
const a = clock(5000)
t += 40
const b2 = clock(5040)
check('clock: device ms anchored to the wall clock, in µs', a === 1_000_000 * 1000 && b2 === 1_000_040 * 1000)
t += 40
const c = clock(1000) // the camera's stamp went back: re-anchored, never backwards
check('clock: a step back re-anchors and never goes backwards', c >= b2)
t += 40
const d = clock(1000 + 90_000_000) // a jump of a day: re-anchored at arrival
check('clock: a big jump re-anchors at the arrival time', d === t * 1000)

t = 2_000_000
const shape = makeFrameShaper({ now: () => t })
check('shaper: audio is dropped', shape({ type: 10, bytes: Buffer.from([1]) }).drop === 'audio')
check('shaper: a P-frame before the first I-frame is dropped', shape({ type: 3, width: 640, height: 360, tsMs: 0, bytes: H264_P }).drop === 'waiting for a keyframe')
const k = shape({ type: 1, width: 640, height: 360, tsMs: 0, bytes: H264_I })
check('shaper: an I-frame goes out as a keyframe, codec sniffed', k.frame && k.key && k.codec === CODEC_H264 && k.frame[0] === 1 && k.frame.readUInt16LE(2) === 640)
t += 40
const p = shape({ type: 3, width: 0, height: 0, tsMs: 40, bytes: H264_P })
check('shaper: a P-frame after it goes out, not key, keeping the size', p.frame && !p.key && p.frame[0] === 0 && p.frame.readUInt16LE(2) === 640 && p.frame.readBigInt64LE(8) > k.frame.readBigInt64LE(8))
check('shaper: a payload that is not Annex B is dropped', shape({ type: 3, tsMs: 80, bytes: Buffer.from([7, 7, 7, 7, 7]) }).drop === 'not Annex B')

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
