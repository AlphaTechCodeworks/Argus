// Hikvision support, the pure part: error texts, reading the login's device information and the
// channel list out of their structures, and turning one elementary-stream packet of the SDK into the
// frame Argus sends to browsers (sdk.mjs encodeFrame's 16-byte header + Annex B). Nothing here loads
// koffi or the SDK, so all of it is tested on any machine (test/hik-core.test.mjs).
import { LAYOUT, MAX_IP_CHANNELS, PACKET, readField } from './hik-structs.mjs'

/** What a Hikvision device shows when the SDK is not on this server (no other change anywhere). */
export const NOT_INSTALLED = 'Hikvision support is not installed on this server'
/** Hik-Connect / P2P, until the developer access is set up. */
export const P2P_NOT_SET_UP = 'Hikvision P2P needs Hik-Connect developer access (AppID) — not set up yet'

// ---- error codes (HCNetSDK.h 541-731, 837) ----------------------------------------------------------

const ERRORS = {
  0: 'no error',
  1: 'wrong user name or password',
  2: 'this user is not allowed to do that',
  3: 'the Hikvision SDK was not initialised',
  4: 'no such channel',
  5: 'the recorder has too many connections',
  6: 'the SDK and the recorder are not compatible',
  7: 'cannot connect (address, port or network)',
  8: 'sending to the recorder failed',
  9: 'receiving from the recorder failed',
  10: 'the recorder did not answer in time',
  11: 'the recorder sent bad data',
  12: 'calls made in the wrong order',
  13: 'not permitted',
  14: 'the command timed out',
  17: 'bad parameter',
  18: 'the recorder channel is in an error state',
  23: 'the recorder does not support this',
  24: 'the recorder is busy',
  28: 'the recorder has no resources left',
  41: 'the SDK could not get resources',
  43: 'buffer too small',
  44: 'could not create a socket',
  46: 'reached the maximum number',
  47: 'that user does not exist',
  52: 'the recorder has too many users connected',
  54: 'no video is being encoded on this channel',
  64: 'the SDK could not load its player library',
  72: 'could not bind a socket',
  73: 'the connection was closed (network down or address unreachable)',
  83: 'that IP channel is offline',
  84: 'the SDK could not load its IPC library',
  91: 'the channel does not support this',
  102: 'not logged in',
  107: 'the SDK could not load its live-view component (HCNetSDKCom/libHCPreview.so)',
  113: 'the SDK could not load its configuration component (HCNetSDKCom/libHCGeneralCfgMgr.so)',
  114: 'the SDK could not load its device-configuration component (HCNetSDKCom/libHCCoreDevCfg.so)',
  121: 'the SDK components do not match the core library version',
  122: 'the live-view component does not match the core library version',
  136: 'the live-view component does not match the HCNetSDK version',
  147: 'certificate error',
  148: 'the SDK could not load OpenSSL (libcrypto/libssl)',
  149: 'the OpenSSL version does not match',
  151: 'invalid communication',
  152: 'that user name does not exist on the recorder',
  153: 'the user is locked after too many wrong passwords',
  154: 'invalid login session',
  155: 'the recorder needs a newer login version',
  159: 'the TLS connection failed',
  164: 'cannot find the server',
  193: 'the user is locked, wait for it to unlock',
  401: 'not authorised (RTSP 401)'
}

/** An SDK error code as plain text. */
export const errorText = (code) => (Object.hasOwn(ERRORS, code) ? ERRORS[code] : `Hikvision SDK error ${code}`)

/**
 * The reason a login failed, from NET_DVR_GetLastError and the NET_DVR_DEVICEINFO_V40 the SDK filled
 * in: when the device supports locking (bySupportLock 1) the header says byRetryLoginTime and
 * dwSurplusLockTime are valid (HCNetSDK.h 13831), so the message says how many tries are left or how
 * long the lock lasts.
 * @param {number} code @param {{ supportLock?: number, retryLoginTime?: number, surplusLockTime?: number }} [lock]
 */
export function loginErrorText(code, lock = {}) {
  const text = errorText(code)
  if (lock.supportLock !== 1) return text
  if (code === 1 && lock.retryLoginTime > 0) return `${text} (${lock.retryLoginTime} ${lock.retryLoginTime === 1 ? 'try' : 'tries'} left before the user is locked)`
  if ((code === 153 || code === 193) && lock.surplusLockTime > 0) return `${text} (locked for another ${lock.surplusLockTime} s)`
  return text
}

/** NET_DVR_GetSDKBuildVersion's number as text, the way the SDK's own demo prints it (GetStream.cpp Demo_SDK_Version). */
export const sdkVersionText = (v) => `V${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`

// ---- device information ------------------------------------------------------------------------------

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim()

/** The NET_DVR_DEVICEINFO_V40 a successful (or failed) Login_V40 filled in, as plain fields. */
export function parseDeviceInfoV40(buf) {
  const v = (f) => readField(buf, 'NET_DVR_DEVICEINFO_V30', f) // struDeviceV30 is at offset 0
  const d = (f) => readField(buf, 'NET_DVR_DEVICEINFO_V40', f)
  return {
    serial: clean(v('sSerialNumber')),
    analogChannels: v('byChanNum'),
    startChannel: v('byStartChan'),
    ipChannels: v('byIPChanNum') + 256 * v('byHighDChanNum'),
    startDChannel: v('byStartDChan'),
    devType: v('wDevType'),
    supportLock: d('bySupportLock'),
    retryLoginTime: d('byRetryLoginTime'),
    surplusLockTime: d('dwSurplusLockTime'),
    passwordLevel: d('byPasswordLevel')
  }
}

/** The NET_DVR_DEVICECFG_V40 of NET_DVR_GET_DEVICECFG_V40: the device's own name and model name. */
export function parseDeviceCfgV40(buf) {
  const f = (k) => readField(buf, 'NET_DVR_DEVICECFG_V40', k)
  return { name: clean(f('sDVRName')), model: clean(f('byDevTypeName')), serial: clean(f('sSerialNumber')) }
}

/**
 * Argus's camera list from the login's device information and (for an NVR/hybrid DVR) the
 * NET_DVR_IPPARACFG_V40 of group 0. Each camera has a stable `ch` (0-based: analog inputs first, then
 * the IP channels in the device's order) and the SDK channel number `sdkChannel` that RealPlay_V40
 * wants (analog: byStartChan + i; IP: dwStartDChan + i, the developer guide's A.200 lChannel).
 * An IP slot with no device behind it is `configured: false`; online is the NVR's own word
 * (NET_DVR_IPCHANINFO.byEnable: "1-connected, the channel is online", guide A.124).
 * @param {object} info parseDeviceInfoV40's result
 * @param {Buffer|null} ipcfg the NET_DVR_IPPARACFG_V40 Buffer, or null (no IP channels / not read)
 */
export function channelsFrom(info, ipcfg) {
  const out = []
  const analogEnabled = (i) => (ipcfg ? ipcfg[LAYOUT.NET_DVR_IPPARACFG_V40.fields.byAnalogChanEnable[0] + i] === 1 : true)
  const analog = Math.min(info.analogChannels, MAX_IP_CHANNELS)
  for (let i = 0; i < analog; i++) {
    out.push({ ch: out.length, sdkChannel: info.startChannel + i, name: `Camera ${out.length + 1}`, online: analogEnabled(i), configured: analogEnabled(i), ip: '', model: '', maker: '', httpPort: null, kind: 'analog' })
  }
  if (!ipcfg) return out
  const cfgF = (k) => readField(ipcfg, 'NET_DVR_IPPARACFG_V40', k)
  const dCount = Math.min(cfgF('dwDChanNum') || info.ipChannels, MAX_IP_CHANNELS)
  const start = cfgF('dwStartDChan') || info.startDChannel
  const devBase = LAYOUT.NET_DVR_IPPARACFG_V40.fields.struIPDevInfo[0]
  const modeBase = LAYOUT.NET_DVR_IPPARACFG_V40.fields.struStreamMode[0]
  const unionAt = LAYOUT.NET_DVR_STREAM_MODE.fields.uGetStream[0]
  for (let i = 0; i < dCount; i++) {
    const m = modeBase + i * LAYOUT.NET_DVR_STREAM_MODE.size
    const type = readField(ipcfg, 'NET_DVR_STREAM_MODE', 'byGetStreamType', m)
    let id = 0
    let online = false
    if (type === 0) {
      // NET_DVR_IPCHANINFO: device id = byIPIDHigh * 256 + byIPID (guide A.124 remarks)
      id = readField(ipcfg, 'NET_DVR_IPCHANINFO', 'byIPIDHigh', m + unionAt) * 256 + readField(ipcfg, 'NET_DVR_IPCHANINFO', 'byIPID', m + unionAt)
      online = readField(ipcfg, 'NET_DVR_IPCHANINFO', 'byEnable', m + unionAt) === 1
    } else if (type === 6) {
      id = readField(ipcfg, 'NET_DVR_IPCHANINFO_V40', 'wIPID', m + unionAt)
      online = readField(ipcfg, 'NET_DVR_IPCHANINFO_V40', 'byEnable', m + unionAt) === 1
    }
    // iDevID == iDevInfoIndex + iGroupNO * 64 + 1 (guide A.124): group 0, so index = id - 1
    const idx = id - 1
    let ip = ''
    let port = null
    let configured = false
    if (idx >= 0 && idx < 64) {
      const d = devBase + idx * LAYOUT.NET_DVR_IPDEVINFO_V31.size
      ip = clean(readField(ipcfg, 'NET_DVR_IPADDR', 'sIpV4', d + LAYOUT.NET_DVR_IPDEVINFO_V31.fields.struIP[0])) || clean(readField(ipcfg, 'NET_DVR_IPDEVINFO_V31', 'byDomain', d))
      port = readField(ipcfg, 'NET_DVR_IPDEVINFO_V31', 'wDVRPort', d) || null
      configured = Boolean(ip) || readField(ipcfg, 'NET_DVR_IPDEVINFO_V31', 'byEnable', d) === 1
    }
    out.push({ ch: out.length, sdkChannel: start + i, name: `Camera ${out.length + 1}`, online: configured && online, configured, ip, model: '', maker: '', httpPort: null, devicePort: port, kind: 'ip' })
  }
  return out
}

// ---- frames ------------------------------------------------------------------------------------------

export const CODEC_H264 = 0
export const CODEC_H265 = 1
export const HEADER_SIZE = 16

/**
 * The codec of an Annex B access unit from its own NAL units, or null if it can't tell. The same rule as
 * sdk.mjs sniffCodec (repeated here because sdk.mjs loads the TVT library on import).
 */
export function sniffCodec(b) {
  const n = Math.min(b.length, 512)
  for (let i = 0; i + 4 < n; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0) continue
    const j = b[i + 2] === 1 ? i + 3 : b[i + 2] === 0 && b[i + 3] === 1 ? i + 4 : -1
    if (j < 0 || j + 1 >= n) continue
    const h = b[j]
    if ((h & 0x81) === 0 && b[j + 1] === 1 && [32, 33, 34, 19, 20, 21].includes((h >> 1) & 0x3f)) return CODEC_H265
    if ((h & 0x80) === 0 && [7, 8, 5].includes(h & 0x1f)) return CODEC_H264
    i = j
  }
  return null
}

const startsAnnexB = (b) => b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1))

/**
 * The packet's bytes as Annex B, or null when they are neither Annex B nor a clean run of 4-byte
 * length-prefixed NAL units. The SDK's elementary-stream callback is expected to give Annex B (start
 * codes), as Hikvision's PS stream carries; that is NOT confirmed on a device (none was available), so
 * a length-prefixed packet is converted rather than dropped, and anything else is dropped (counted).
 */
export function toAnnexB(b) {
  if (startsAnnexB(b)) return b
  const parts = []
  let i = 0
  while (i + 4 <= b.length) {
    const n = b.readUInt32BE(i)
    if (n === 0 || i + 4 + n > b.length) return null
    parts.push(Buffer.from([0, 0, 0, 1]), b.subarray(i + 4, i + 4 + n))
    i += 4 + n
  }
  return i === b.length && parts.length ? Buffer.concat(parts) : null
}

/** Packs one frame in the wire format of sdk.mjs encodeFrame (server.mjs): key, codec, w, h, 0, time in µs, bytes. */
export function packFrame({ key, codec, width, height, timeUs }, bytes) {
  const msg = Buffer.allocUnsafe(HEADER_SIZE + bytes.length)
  msg.writeUInt8(key ? 1 : 0, 0)
  msg.writeUInt8(codec, 1)
  msg.writeUInt16LE(width & 0xffff, 2)
  msg.writeUInt16LE(height & 0xffff, 4)
  msg.writeUInt16LE(0, 6)
  msg.writeBigInt64LE(BigInt(Math.round(timeUs)), 8)
  bytes.copy(msg, HEADER_SIZE)
  return msg
}

/**
 * Frame times for one stream, in µs on this server's clock. The packet's 64-bit time stamp
 * (dwTimeStampHigh:dwTimeStamp) is taken to count milliseconds -- the header does not say, and no
 * device was available to measure it -- and is anchored to the wall clock at the first frame; a step
 * backwards or of more than maxStepMs (a camera reset, or the unit is not ms after all) re-anchors it,
 * so the worst case is the arrival time. Times never go backwards.
 */
export function makeFrameClock({ now = Date.now, maxStepMs = 5000 } = {}) {
  let base = null
  let lastDev = null
  let lastOut = 0
  return (devMs) => {
    const t = now()
    if (base === null || lastDev === null || devMs < lastDev || devMs - lastDev > maxStepMs) base = t - devMs
    lastDev = devMs
    lastOut = Math.max(lastOut, (base + devMs) * 1000)
    return lastOut
  }
}

/**
 * One stream's packet-to-frame step. Returns { frame, key, codec, width, height } for a video packet
 * that can go out, or { drop: why } (audio, the file head, private data, P-frames before the first
 * I-frame, an unrecognised payload). Packet: { type, width, height, tsMs, bytes } (hik-sdk.mjs).
 */
export function makeFrameShaper({ now = Date.now } = {}) {
  const clock = makeFrameClock({ now })
  let codec = null
  let width = 0
  let height = 0
  let haveKey = false
  return (p) => {
    if (p.type !== PACKET.I && p.type !== PACKET.P && p.type !== PACKET.B) return { drop: p.type === PACKET.AUDIO ? 'audio' : 'not video' }
    const bytes = toAnnexB(p.bytes)
    if (!bytes) return { drop: 'not Annex B' }
    const key = p.type === PACKET.I
    if (key) {
      const c = sniffCodec(bytes)
      if (c !== null) codec = c
      haveKey = codec !== null
    }
    if (!haveKey) return { drop: 'waiting for a keyframe' }
    if (p.width) width = p.width
    if (p.height) height = p.height
    const timeUs = clock(p.tsMs)
    return { frame: packFrame({ key, codec, width, height, timeUs }, bytes), key, codec, width, height }
  }
}
