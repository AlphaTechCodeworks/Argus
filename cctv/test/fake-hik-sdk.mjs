// A stand-in for hik-sdk.mjs's sdk object, for the Hikvision tests (no SDK, no koffi, no device):
// makeFakeHikSdk(opts) for in-process tests; the default export (configured by FAKE_HIK_* environment
// variables) for the child processes started with CCTV_HIK_FAKE_SDK=<this file>.
//   FAKE_HIK_LOGIN = ok | password | timeout     what Login_V40 does
//   FAKE_HIK_FPS   = frames a second each stream sends (default 25)
import { LAYOUT, alloc, writeField } from '../hik-structs.mjs'

/** A NET_DVR_DEVICEINFO_V40-like parse result (what hik-sdk.mjs login returns as `info`). */
export const fakeInfo = (o = {}) => ({ serial: 'DS-7608NI-K20123456789AAWR', analogChannels: 0, startChannel: 1, ipChannels: 4, startDChannel: 33, devType: 0, supportLock: 1, retryLoginTime: 4, surplusLockTime: 0, passwordLevel: 2, ...o })

/** A NET_DVR_IPPARACFG_V40 Buffer with `n` IP channels: channel i on IP device i+1 at 192.168.254.(i+2), online unless listed in `offline`. */
export function fakeIpConfig({ n = 4, start = 33, offline = [], empty = [] } = {}) {
  const buf = alloc('NET_DVR_IPPARACFG_V40')
  const F = LAYOUT.NET_DVR_IPPARACFG_V40.fields
  writeField(buf, 'NET_DVR_IPPARACFG_V40', 'dwSize', LAYOUT.NET_DVR_IPPARACFG_V40.size)
  writeField(buf, 'NET_DVR_IPPARACFG_V40', 'dwDChanNum', n)
  writeField(buf, 'NET_DVR_IPPARACFG_V40', 'dwStartDChan', start)
  for (let i = 0; i < n; i++) {
    const m = F.struStreamMode[0] + i * LAYOUT.NET_DVR_STREAM_MODE.size
    const u = m + LAYOUT.NET_DVR_STREAM_MODE.fields.uGetStream[0]
    buf.writeUInt8(0, m) // byGetStreamType 0: NET_DVR_IPCHANINFO
    if (empty.includes(i)) continue
    buf.writeUInt8(offline.includes(i) ? 0 : 1, u + LAYOUT.NET_DVR_IPCHANINFO.fields.byEnable[0])
    buf.writeUInt8(i + 1, u + LAYOUT.NET_DVR_IPCHANINFO.fields.byIPID[0])
    buf.writeUInt8(1, u + LAYOUT.NET_DVR_IPCHANINFO.fields.byChannel[0])
    const d = F.struIPDevInfo[0] + i * LAYOUT.NET_DVR_IPDEVINFO_V31.size
    buf.writeUInt8(1, d) // byEnable
    writeField(buf, 'NET_DVR_IPADDR', 'sIpV4', `192.168.254.${i + 2}`, d + LAYOUT.NET_DVR_IPDEVINFO_V31.fields.struIP[0])
    writeField(buf, 'NET_DVR_IPDEVINFO_V31', 'wDVRPort', 8000, d)
  }
  return buf
}

// H.264 access units in Annex B: SPS + PPS + IDR for an I-frame, one non-IDR slice for a P-frame
export const H264_I = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00])
export const H264_P = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x00])

/**
 * @param {{ login?: 'ok'|'password'|'timeout', fps?: number, gop?: number, ipcfg?: Buffer, info?: object, startFails?: number }} [o]
 */
export function makeFakeHikSdk({ login = 'ok', fps = 25, gop = 25, ipcfg = fakeIpConfig(), info = fakeInfo(), startFails = 0 } = {}) {
  let next = 100
  let userId = 0
  const live = new Map() // handle -> { timer, onPacket, ch, type }
  const calls = []
  let fails = startFails
  const sdk = {
    calls,
    live,
    /** Sends one packet on a stream now (tests). */
    push(handle, p) {
      live.get(handle)?.onPacket(p)
    },
    stats: () => ({ inFlight: 0, oldestMs: 0, calls: [] }),
    async init(o) {
      calls.push(['init', o?.logDir ?? null])
      return { ok: true, notes: [] }
    },
    async version() {
      return 0x0601_0b28 // V6.1.11.40
    },
    async cleanup() {
      return { ok: true, code: 0 }
    },
    async close() {},
    async p2pLogin2C(s) {
      calls.push(['p2pLogin2C', { ...s, password: s.password ? '***' : '' }])
      return { ok: true }
    },
    async login(o) {
      calls.push(['login', o.host, o.port, o.user])
      if (login === 'password') return { userId: -1, info, code: 1 }
      if (login === 'timeout') throw Object.assign(new Error('NET_DVR_Login_V40 did not return within 30 s'), { name: 'HikTimeout' })
      return { userId: ++userId, info }
    },
    async logout(id) {
      calls.push(['logout', id])
      return true
    },
    async deviceCfg() {
      return { ok: true, name: 'Yard NVR', model: 'DS-7608NI-K2', serial: info.serial }
    },
    async ipConfig() {
      calls.push(['ipConfig'])
      return { ok: true, buf: ipcfg }
    },
    async startLive(uid, ch, type, onPacket) {
      calls.push(['startLive', uid, ch, type])
      if (fails > 0) {
        fails--
        return { handle: -1, code: 7, step: 'RealPlay_V40' }
      }
      const handle = next++
      let n = 0
      const timer = fps > 0
        ? setInterval(() => {
            const key = n % gop === 0
            onPacket({ type: key ? 1 : 3, width: type === 0 ? 1920 : 640, height: type === 0 ? 1080 : 360, tsMs: 1_000_000 + n * Math.round(1000 / fps), bytes: key ? H264_I : H264_P })
            n++
          }, Math.round(1000 / fps))
        : null
      timer?.unref?.()
      live.set(handle, { timer, onPacket, ch, type })
      return { handle }
    },
    async stopLive(handle) {
      calls.push(['stopLive', handle])
      const s = live.get(handle)
      if (s) clearInterval(s.timer)
      live.delete(handle)
      return true
    }
  }
  return sdk
}

export default makeFakeHikSdk({ login: process.env.FAKE_HIK_LOGIN || 'ok', fps: Number(process.env.FAKE_HIK_FPS || 25) })
