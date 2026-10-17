// The Hikvision SDK's structures (hik-structs.mjs): the hand-worked sizes and offsets of LAYOUT
//   1. agree with koffi's own C layout of the same fields (when koffi can be loaded: in the repo's
//      node_modules, or CCTV_KOFFI_PATH=<path to koffi's index.js>; skipped otherwise, and said so);
//   2. follow incEn/HCNetSDK.h itself, field for field (when the header is at HIK_HEADER or in the
//      unpacked SDK under Downloads; skipped otherwise, and said so): member order and names, array
//      lengths, the enum values, the command numbers, every function hik-sdk.mjs binds;
//   3. read and write correctly.
// No SDK and no device are needed.   node cctv/test/hik-structs.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ES_CALLBACK, FUNCTIONS, decodePacket } from '../hik-sdk.mjs'
import { LAYOUT, LOCAL_CFG, LOCAL_CFG_ORDER, NET_DVR_GET_DEVICECFG_V40, NET_DVR_GET_IPPARACFG_V40, INIT_CFG, alloc, defineHikTypes, layoutMismatches, readField, writeField } from '../hik-structs.mjs'

let failures = 0
let skipped = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const skip = (name, why) => {
  skipped++
  console.log(`SKIP  ${name}  (${why})`)
}

// ---- 3. LAYOUT on its own ----
for (const [name, l] of Object.entries(LAYOUT)) {
  const size = (k, n) => ({ u8: 1, u16: 2, u32: 4, i32: 4, ptr: 8 })[k] ?? n
  const spans = Object.entries(l.fields).map(([f, [off, k, n]]) => ({ f, off, end: off + size(k, n), k }))
  const inside = spans.every((s) => s.off >= 0 && s.end <= l.size)
  const aligned = spans.every((s) => s.off % ({ u16: 2, u32: 4, i32: 4, ptr: 8 }[s.k] ?? 1) === 0)
  const sorted = [...spans].sort((a, b) => a.off - b.off)
  const apart = sorted.every((s, i) => i === 0 || s.off >= sorted[i - 1].end)
  check(`${name}: fields inside ${l.size} bytes, naturally aligned, not overlapping`, inside && aligned && apart)
  check(`${name}: size is a multiple of its alignment`, l.size % l.align === 0)
}
check('USER_LOGIN_INFO.cbLoginResultV40 at offset 296 (the header says so in its own comment)', LAYOUT.NET_DVR_USER_LOGIN_INFO.fields.cbLoginResultV40[0] === 296)
check('IPPARACFG_V40: 64 IP devices of 296 bytes and 64 stream modes of 496 bytes', LAYOUT.NET_DVR_IPPARACFG_V40.fields.struStreamMode[0] === 84 + 64 * 296 && LAYOUT.NET_DVR_IPPARACFG_V40.size === 84 + 64 * 296 + 64 * 496 + 20)
check('P2P_LOGIN_2C is member 23 of NET_SDK_LOCAL_CFG_TYPE (counted from 0)', LOCAL_CFG_ORDER.indexOf('NET_SDK_P2P_LOGIN_2C') === LOCAL_CFG.P2P_LOGIN_2C && LOCAL_CFG_ORDER.indexOf('NET_SDK_P2P_LOGOUT') === LOCAL_CFG.P2P_LOGOUT)

const b = alloc('NET_DVR_USER_LOGIN_INFO')
writeField(b, 'NET_DVR_USER_LOGIN_INFO', 'sDeviceAddress', '192.168.1.64')
writeField(b, 'NET_DVR_USER_LOGIN_INFO', 'wPort', 8000)
writeField(b, 'NET_DVR_USER_LOGIN_INFO', 'sPassword', 'pä$$')
check('writeField/readField: strings, NUL-terminated', readField(b, 'NET_DVR_USER_LOGIN_INFO', 'sDeviceAddress') === '192.168.1.64' && b[12] === 0)
check('writeField/readField: a WORD, little-endian at 130', readField(b, 'NET_DVR_USER_LOGIN_INFO', 'wPort') === 8000 && b.readUInt16LE(130) === 8000)
check('writeField: a password as UTF-8 at 196', b.subarray(196, 196 + 5).toString('utf8') === 'pä$$' && b[201] === 0)
let threw = false
try { writeField(b, 'NET_DVR_USER_LOGIN_INFO', 'sUserName', 'x'.repeat(64)) } catch { threw = true }
check('writeField: a string that would fill the field (no room for its NUL) is refused', threw)
threw = false
try { readField(b, 'NET_DVR_USER_LOGIN_INFO', 'nope') } catch { threw = true }
check('readField: an unknown field throws', threw)

// ---- 1. koffi ----
let koffi = null
try {
  koffi = (await import('koffi')).default
} catch {
  if (process.env.CCTV_KOFFI_PATH) koffi = (await import(pathToFileURL(process.env.CCTV_KOFFI_PATH).href)).default
}
if (!koffi) skip('LAYOUT against koffi', 'koffi is not installed here; set CCTV_KOFFI_PATH to run it')
else {
  const bad = layoutMismatches(koffi)
  check(`LAYOUT agrees with koffi's layout of every structure (koffi ${koffi.version})`, bad.length === 0, bad.slice(0, 5).join('; '))
  const t = defineHikTypes(koffi)
  check('koffi: NET_DVR_GET_STREAM_UNION is 492 bytes (its largest member, NET_DVR_PU_STREAM_CFG)', koffi.sizeof(t.NET_DVR_GET_STREAM_UNION) === 492)
  // every function hik-sdk.mjs binds is a prototype koffi accepts, with the parameter count the header has
  koffi.proto(ES_CALLBACK)
  const counts = {}
  let parsed = true
  for (const [k, sig] of Object.entries(FUNCTIONS)) {
    try {
      if (sig.length === 1) koffi.proto(sig[0].replace(/(NET_DVR_\w+)\(/, `HikTest_${k}(`))
      else koffi.proto(`HikTest_${k}`, sig[1], sig[2])
      // (koffi does not report a prototype's arguments: counted from what it just accepted)
      counts[k] = sig.length === 1 ? (/\(\s*\)/.test(sig[0]) ? 0 : sig[0].split(',').length) : sig[2].length
    } catch (e) {
      parsed = false
      console.log(`      ${k}: ${e.message}`)
    }
  }
  check(`koffi parses all ${Object.keys(FUNCTIONS).length} bound prototypes`, parsed)
  check('... with the header\'s parameter counts', counts.Login_V40 === 2 && counts.RealPlay_V40 === 4 && counts.GetDVRConfig === 6 && counts.SetESRealPlayCallBack === 3 && counts.SetSDKLocalCfgP2P2C === 2 && counts.SetLogToFile === 3, JSON.stringify(counts))
  // the ES callback's decoding, on native memory laid out as the SDK would hand it over
  const data = koffi.alloc('uint8_t', 8)
  koffi.encode(data, koffi.array('uint8_t', 8), [0, 0, 0, 1, 0x65, 1, 2, 3])
  const info = koffi.alloc(t.NET_DVR_PACKET_INFO_EX, 1)
  const z = (n) => new Array(n).fill(0)
  koffi.encode(info, t.NET_DVR_PACKET_INFO_EX, { wWidth: 1920, wHeight: 1080, dwTimeStamp: 5, dwTimeStampHigh: 1, dwYear: 2026, dwMonth: 10, dwDay: 16, dwHour: 0, dwMinute: 0, dwSecond: 0, dwMillisecond: 0, dwFrameNum: 9, dwFrameRate: 25, dwFlag: 0, dwFilePos: 0, dwPacketType: 1, dwPacketSize: 8, pPacketBuffer: data, byRes1: z(4), dwPacketMode: 0, byRes2: z(16), dwReserved: z(6) })
  const p = decodePacket(koffi, t, info)
  check('decodePacket: type, size, 64-bit time stamp and a copy of the bytes', p && p.type === 1 && p.width === 1920 && p.height === 1080 && p.tsMs === 2 ** 32 + 5 && p.frameNum === 9 && p.bytes.toString('hex') === '0000000165010203', JSON.stringify(p && { ...p, bytes: p.bytes.toString('hex') }))
  const empty = koffi.alloc(t.NET_DVR_PACKET_INFO_EX, 1)
  koffi.encode(empty, t.NET_DVR_PACKET_INFO_EX, { wWidth: 0, wHeight: 0, dwTimeStamp: 0, dwTimeStampHigh: 0, dwYear: 0, dwMonth: 0, dwDay: 0, dwHour: 0, dwMinute: 0, dwSecond: 0, dwMillisecond: 0, dwFrameNum: 0, dwFrameRate: 0, dwFlag: 0, dwFilePos: 0, dwPacketType: 0, dwPacketSize: 0, pPacketBuffer: null, byRes1: z(4), dwPacketMode: 0, byRes2: z(16), dwReserved: z(6) })
  check('decodePacket: no buffer -> null', decodePacket(koffi, t, empty) === null)
  koffi.free(data)
  koffi.free(info)
  koffi.free(empty)
  // the Hik-Connect structure from a plain object: strings become char * for the call, at the header's offsets
  const p2p = koffi.alloc(t.NET_SDK_P2P_SERVER_2C, 1)
  koffi.encode(p2p, t.NET_SDK_P2P_SERVER_2C, { byPlatformType: 2, byRes1: z(3), pAppID: 'APP', pAuthAddr: 'auth.test', pPlatformAddr: 'plat.test', pUserName: 'me@example.com', pPassword: 'pw', byRes: z(40) })
  const back = koffi.decode(p2p, t.NET_SDK_P2P_SERVER_2C)
  check('NET_SDK_P2P_SERVER_2C: koffi turns the object\'s strings into char * members', back.byPlatformType === 2 && back.pAppID === 'APP' && back.pUserName === 'me@example.com' && back.pPassword === 'pw')
  koffi.free(p2p)
}

// ---- 2. the header ----
const headerPath = process.env.HIK_HEADER || join(homedir(), 'Downloads/hcnetsdk-linux64-6.1.11.40/EN-HCNetSDKV6.1.11.40_build20260922_linux64/incEn/HCNetSDK.h')
if (!existsSync(headerPath)) skip('LAYOUT against HCNetSDK.h', `no header at ${headerPath}; set HIK_HEADER`)
else {
  const h = readFileSync(headerPath, 'latin1').replace(/\r/g, '')
  const lines = h.split('\n')
  // a #define's number; a sum of other defines (MAX_CHANNUM_V30 is "( MAX_ANALOG_CHANNUM + MAX_IP_CHANNEL )") is added up
  const define = (name, depth = 0) => {
    const m = h.match(new RegExp(`#define\\s+${name}\\s+([^\\n/]+)`))
    if (!m || depth > 4) return NaN
    const terms = m[1].replace(/[()]/g, ' ').trim().split(/\s*\+\s*/)
    return terms.reduce((sum, t) => sum + (/^\d+$/.test(t) ? Number(t) : define(t, depth + 1)), 0)
  }
  /** The members of the struct/union whose closing line names it, in order; the first branch of an #if. */
  const members = (name) => {
    const end = lines.findIndex((l) => new RegExp(`^\\s*}\\s*${name}\\s*[,;]`).test(l))
    if (end < 0) return null
    let start = end
    while (start > 0 && !/^\s*typedef\s+(struct|union)/.test(lines[start])) start--
    const out = []
    let skipping = false
    for (const raw of lines.slice(start + 1, end)) {
      const l = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim()
      if (/^#if/.test(l)) continue
      if (/^#else/.test(l)) { skipping = true; continue }
      if (/^#endif/.test(l)) { skipping = false; continue }
      if (skipping || !l || l === '{') continue
      const m = /^([A-Za-z_][\w\s]*?)\s*(\*?)\s*([A-Za-z_]\w*)\s*(\[([^\]]*)\])?\s*;$/.exec(l)
      if (m) out.push({ type: m[1].trim(), ptr: m[2] === '*', name: m[3], len: m[5]?.trim() ?? null })
    }
    return out
  }
  const lenOf = (expr) => {
    if (expr === null) return null
    const e = expr.replace(/\/\*.*?\*\//g, '').trim()
    if (/^\d+$/.test(e)) return Number(e)
    return define(e)
  }
  const koffiFields = koffi ? defineHikTypes(koffi) : null
  for (const name of Object.keys(LAYOUT)) {
    const m = members(name)
    if (!m) {
      check(`${name} found in the header`, false)
      continue
    }
    if (name === 'NET_DVR_GET_STREAM_UNION') {
      check(`${name}: the header's members are the seven koffi has`, m.map((x) => x.name).join() === 'struChanInfo,struIPServerStream,struPUStream,struDDNSStream,struStreamUrl,struHkDDNSStream,struIPChan')
      continue
    }
    // every LAYOUT field is a header member, in the header's order, with the header's array length
    const names = m.map((x) => x.name)
    const mine = Object.keys(LAYOUT[name].fields)
    const order = mine.map((f) => names.indexOf(f))
    check(`${name}: every LAYOUT field is in the header, in the same order`, order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), mine.filter((f) => !names.includes(f)).join(','))
    const lens = Object.entries(LAYOUT[name].fields).filter(([, [, k]]) => k === 'char' || k === 'bytes').every(([f, [, , n]]) => {
      const mm = m.find((x) => x.name === f)
      const want = lenOf(mm?.len)
      // (bytes fields that stand for a nested structure or a typed array have no [] of their own)
      return want === null ? true : want === n || (mm.type === 'DWORD' && want * 4 === n) || (Boolean(LAYOUT[mm.type]) && want * LAYOUT[mm.type].size === n)
    })
    check(`${name}: array lengths match the header`, lens)
    if (koffiFields) {
      const kt = koffiFields[name]
      const kn = koffi.introspect(kt).members ? Object.keys(koffi.introspect(kt).members) : []
      check(`${name}: the koffi definition has exactly the header's members, in order`, kn.join() === names.join(), `${kn.length} vs ${names.length}`)
    }
  }
  // the enum of local settings, up to P2P_LOGOUT
  const e = /typedef enum tagNET_SDK_LOCAL_CFG_TYPE\s*{([\s\S]*?)}\s*NET_SDK_LOCAL_CFG_TYPE/.exec(h)
  const enumNames = e ? e[1].replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).map((l) => /^([A-Za-z_]\w*)/.exec(l)?.[1]).filter(Boolean) : []
  check('NET_SDK_LOCAL_CFG_TYPE: starts at 0 and lists LOCAL_CFG_ORDER in order', /TCP_PORT_BIND\s*=\s*0/.test(e?.[1] ?? '') && LOCAL_CFG_ORDER.every((n, i) => enumNames[i] === n), enumNames.slice(20, 26).join(','))
  const init = /typedef enum tagNET_SDK_INIT_CFG_TYPE\s*{([\s\S]*?)}/.exec(h)?.[1] ?? ''
  check('NET_SDK_INIT_CFG_TYPE: SDK_PATH 2, LIBEAY_PATH 3, SSLEAY_PATH 4', new RegExp(`NET_SDK_INIT_CFG_SDK_PATH\\s*=\\s*${INIT_CFG.SDK_PATH}`).test(init) && new RegExp(`NET_SDK_INIT_CFG_LIBEAY_PATH\\s*=\\s*${INIT_CFG.LIBEAY_PATH}`).test(init) && new RegExp(`NET_SDK_INIT_CFG_SSLEAY_PATH\\s*=\\s*${INIT_CFG.SSLEAY_PATH}`).test(init))
  check('NET_DVR_GET_IPPARACFG_V40 is 1062', define('NET_DVR_GET_IPPARACFG_V40') === NET_DVR_GET_IPPARACFG_V40)
  check('NET_DVR_GET_DEVICECFG_V40 is 1100', define('NET_DVR_GET_DEVICECFG_V40') === NET_DVR_GET_DEVICECFG_V40)
  check('the header has no #pragma pack (natural alignment, as LAYOUT assumes)', !/#pragma\s+pack/.test(h))
  check('on Linux LONG is int, DWORD unsigned int, BOOL int, HWND unsigned int', /typedef\s+int\s+LONG;/.test(h) && /typedef\s+unsigned int\s+DWORD;/.test(h) && /#define\s+BOOL\s+int/.test(h) && /#elif defined\(__linux__\)\s*\ntypedef unsigned int HWND;/.test(h))
  check('cbLoginResultV40 "offset 296" is the header\'s own statement', /cbLoginResultV40 byte offset in NET_DVR_USER_LOGIN_INFO must match SDK internal and all platforms \(offset 296\)/.test(h))
  // every function hik-sdk.mjs binds, with the parameter count it binds
  const bound = Object.values(FUNCTIONS).map((sig) => (sig.length === 1 ? /(NET_DVR_\w+)\(/.exec(sig[0])[1] : sig[0]))
  const declared = (fn) => new RegExp(`NET_DVR_API\\s+[\\w*]+\\s*\\*?\\s*__stdcall\\s+${fn}\\s*\\(`).test(h)
  check(`every bound function is declared in the header (${new Set(bound).size} functions)`, bound.length >= 15 && bound.every(declared), bound.filter((f) => !declared(f)).join(','))
  const params = (fn) => {
    const m = new RegExp(`NET_DVR_API[^;]*?__stdcall\\s+${fn}\\s*\\(([\\s\\S]*?)\\);`).exec(h)
    if (!m) return -1
    // a callback parameter has its own parentheses: count the commas outside them
    let depth = 0
    let n = m[1].trim() ? 1 : 0
    for (const c of m[1]) {
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 0) n++
    }
    return n
  }
  const want = { NET_DVR_Login_V40: 2, NET_DVR_RealPlay_V40: 4, NET_DVR_GetDVRConfig: 6, NET_DVR_SetESRealPlayCallBack: 3, NET_DVR_SetLogToFile: 3, NET_DVR_SetSDKLocalCfg: 2, NET_DVR_SetSDKInitCfg: 2, NET_DVR_StopRealPlay: 1, NET_DVR_Logout: 1, NET_DVR_SetConnectTime: 2, NET_DVR_SetReconnect: 2 }
  check('parameter counts match the header', Object.entries(want).every(([f, n]) => params(f) === n), Object.entries(want).filter(([f, n]) => params(f) !== n).map(([f]) => `${f}=${params(f)}`).join(','))
  check('the ES callback takes (LONG, NET_DVR_PACKET_INFO_EX *, void *)', /NET_DVR_SetESRealPlayCallBack\(LONG iRealHandle, void\(__stdcall \*fPlayESCallBack\)\(LONG lPreviewHandle, NET_DVR_PACKET_INFO_EX \*pstruPackInfo, void\* pUser\), void\* pUser\)/.test(h))
}

console.log(failures ? `\n${failures} FAILED` : `\nall passed${skipped ? ` (${skipped} skipped)` : ''}`)
process.exit(failures ? 1 : 0)
