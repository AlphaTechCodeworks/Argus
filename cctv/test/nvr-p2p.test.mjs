// Offline tests for NVRs added by serial number (the P2P cloud): the settings checks, the admin
// API's duplicate rules, the device identity used by change logs, and logins by serial number over
// the fake SDK (test/fake-sdk.mjs): the plain serial registered with the add-on before the login, one
// P2P server per process, no TCP probe, and records saved with the old relay address in them.
// No NVR, no network. Run inside the container:  node cctv/test/nvr-p2p.test.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p2p-'))
process.env.UV_THREADPOOL_SIZE = '64' // as in the container (sdk.mjs sizes its native-call cap from it)
delete process.env.CCTV_P2P // on by default (nvrs.mjs P2P_ENABLED); CCTV_P2P=off is checked at the end
delete process.env.CCTV_P2P_SERVER
await import('./fake-sdk.mjs')
const { P2P_SERIAL, setP2pServer } = await import('../sdk.mjs')
const { Nvr, P2P_ENABLED, P2P_SERVER, cleanNvrFields, testLogin, whereIs } = await import('../nvrs.mjs')
const { handleAdmin } = await import('../admin.mjs')
const { deviceOf } = await import('../nvr-xml.mjs')
const { log, calls } = globalThis.__fakeSdk

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const throws = (fn, re) => {
  try {
    fn()
    return false
  } catch (e) {
    return re.test(e.message)
  }
}
const until = async (cond, maxMs) => {
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(50)) if (cond()) return true
  return cond()
}
const base = { site: 'Remote yard', name: 'Yard NVR', user: 'admin' }

// ---- settings checks
const p = cleanNvrFields({ ...base, sn: ' n63432ab12cd ' })
check('by serial: serial cleaned (trimmed, upper case)', p.sn === 'N63432AB12CD', p.sn)
check('by serial: no address needed, the record gets the P2P server’s', p.host === P2P_SERVER.host && p.port === P2P_SERVER.port, `${p.host}:${p.port}`)
check('P2P server: cli-nat20.eyeincloud.com:9969 by default', P2P_SERVER.host === 'cli-nat20.eyeincloud.com' && P2P_SERVER.port === 9969, `${P2P_SERVER.host}:${P2P_SERVER.port}`)
check('adding by serial number is on by default', P2P_ENABLED === true)
const sent = cleanNvrFields({ ...base, sn: 'N63432AB12CD', host: 'c2020.autonat.com', port: 7968 })
check('by serial: an address sent along is not used (one P2P server per process)', sent.host === P2P_SERVER.host && sent.port === P2P_SERVER.port, `${sent.host}:${sent.port}`)
check('by serial: spaces or symbols refused', throws(() => cleanNvrFields({ ...base, sn: 'N634 32' }), /letters and digits/) && throws(() => cleanNvrFields({ ...base, sn: 'N6343<2' }), /letters and digits/))
check('by serial: too short refused', throws(() => cleanNvrFields({ ...base, sn: 'N63' }), /letters and digits/))
const lan = cleanNvrFields({ ...base, host: '192.168.0.228', port: 6036 })
check('by address: unchanged, no serial', lan.host === '192.168.0.228' && lan.port === 6036 && !('sn' in lan))
check('by address: host still required', throws(() => cleanNvrFields({ ...base }), /IP address/))
const toP2p = cleanNvrFields({ sn: 'N63432AB12CD' }, { partial: true })
check('edit: switching to serial sets the P2P server', toP2p.sn === 'N63432AB12CD' && toP2p.host === P2P_SERVER.host && toP2p.port === P2P_SERVER.port)
check('edit: switching back to address without one is refused', throws(() => cleanNvrFields({ sn: '' }, { partial: true }), /IP address/))
const toLan = cleanNvrFields({ sn: '', host: '192.168.2.24', port: 6036 }, { partial: true })
check('edit: switching back to address', toLan.sn === '' && toLan.host === '192.168.2.24' && toLan.port === 6036)
const rename = cleanNvrFields({ name: 'Yard NVR 2' }, { partial: true })
check('edit: renaming touches nothing else', Object.keys(rename).join() === 'name', Object.keys(rename).join())

// ---- identity for change logs, labels
const fake = (cfg) => ({ cfg })
check('change logs: serial is the identity (all P2P NVRs share one address)', deviceOf(fake({ host: P2P_SERVER.host, port: P2P_SERVER.port, sn: 'A1B2C3D4' })) === 'sn:A1B2C3D4' && deviceOf(fake({ host: P2P_SERVER.host, port: P2P_SERVER.port, sn: 'Z9Y8X7W6' })) !== deviceOf(fake({ host: P2P_SERVER.host, port: P2P_SERVER.port, sn: 'A1B2C3D4' })))
check('change logs: by address unchanged', deviceOf(fake({ host: '192.168.0.228', port: 6036 })) === '192.168.0.228:6036')
check('labels', whereIs({ sn: 'A1B2C3D4' }) === 'serial A1B2C3D4 (P2P cloud)' && whereIs({ host: '192.168.0.228', port: 6036 }) === '192.168.0.228:6036')

// ---- admin API (skipTest: nothing is logged in to)
const post = (body) => handleAdmin('POST', '/api/admin/nvrs', async () => ({ ...body, password: 'x', skipTest: true }))
const [s1, b1] = await post({ ...base, sn: 'N63432AB12CD' })
check('admin: add by serial, without an address or port', s1 === 201, JSON.stringify(b1))
const [s2, b2] = await post({ ...base, name: 'Same box', sn: 'n63432ab12cd' })
check('admin: the same serial twice is refused', s2 === 409 && /already/.test(b2.error), JSON.stringify(b2))
const [s3] = await post({ ...base, name: 'Other box', sn: 'N63108CD34EF' })
check('admin: another serial through the same P2P server is fine', s3 === 201)
const [s4] = await post({ ...base, name: 'LAN box', host: '192.168.0.228', port: 6036 })
check('admin: add by address next to them', s4 === 201)
const [s7] = await post({ ...base, name: 'Relay box', sn: 'N63777EE56GH', host: 'c2020.autonat.com', port: 7968 })
const [, list] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
const byId = Object.fromEntries(list.map((n) => [n.name, n]))
check('admin: list says how each is reached', byId['Yard NVR']?.via === 'p2p' && byId['Yard NVR']?.sn === 'N63432AB12CD' && byId['LAN box']?.via === 'lan' && byId['LAN box']?.sn === '')
check('admin: a host and port sent with a serial number are not stored', s7 === 201 && byId['Relay box']?.host === P2P_SERVER.host && byId['Relay box']?.port === P2P_SERVER.port, `${byId['Relay box']?.host}:${byId['Relay box']?.port}`)
check('admin: passwords never listed', list.every((n) => !('password' in n)))
const [s5, b5] = await handleAdmin('PUT', `/api/admin/nvrs/${encodeURIComponent(byId['Other box'].id)}`, async () => ({ sn: 'N63432AB12CD', skipTest: true }))
check('admin: editing to a serial already used is refused', s5 === 409, JSON.stringify(b5))
const [s6] = await handleAdmin('PUT', `/api/admin/nvrs/${encodeURIComponent(byId['Other box'].id)}`, async () => ({ sn: '', host: '192.168.2.24', port: 6036, skipTest: true }))
const [, list2] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
const other = list2.find((n) => n.name === 'Other box')
check('admin: switched back to address, serial removed', s6 === 200 && other.via === 'lan' && other.host === '192.168.2.24' && other.sn === '')

// ---- logins by serial number (fake SDK: serials starting with FAKE log in, others are not found)
// The records below have a TCP listener's address in host/port: a probe of it would show up here.
let probes = 0
const listener = createServer((s) => {
  probes++
  s.destroy()
})
await new Promise((r) => listener.listen(0, '127.0.0.1', r))
const rec = (sn) => ({ ...base, name: `NVR ${sn}`, password: 'x', sn, host: '127.0.0.1', port: listener.address().port })
const loginsOf = (sn) => calls('LoginEx').filter((c) => c.args[6] === sn)
{
  const r = await testLogin(rec('FAKE0001')).catch((e) => e)
  check('a login by serial number goes to LoginEx with the serial', !(r instanceof Error) && loginsOf('FAKE0001').length === 1, r?.message ?? r)
  check('no TCP probe for an NVR by serial number (its record’s address was not connected to)', probes === 0, `${probes} connections`)
  const at = (fn, sn) => log.findIndex((c) => c.fn === fn && c.args.includes(sn))
  check('the plain serial is registered with the add-on before LoginEx', at('p2pserial_add', 'FAKE0001') >= 0 && at('p2pserial_add', 'FAKE0001') < at('LoginEx', 'FAKE0001'), log.map((c) => c.fn).join(','))
  const nat = calls('SetNat2Addr')
  check('the SDK is pointed at the P2P server, not at the address in the record', nat.length === 1 && nat[0].args[0] === P2P_SERVER.host && nat[0].args[1] === P2P_SERVER.port, JSON.stringify(nat.map((c) => c.args)))
}
{
  // the SDK now answers false to SetNat2Addr, as the real one does after its first call
  const r = await testLogin(rec('N63432AB12CD')).catch((e) => e)
  check('a second login by serial number in one process reaches LoginEx', loginsOf('N63432AB12CD').length === 1, `${calls('LoginEx').length} LoginEx calls`)
  check('... without asking the SDK for the P2P server again', calls('SetNat2Addr').length === 1)
  check('... and an NVR the cloud does not find fails with the SDK’s reason', r instanceof Error && /cannot connect/.test(r.message), r?.message)
}
{
  const r = await setP2pServer('device.provisionisr-nat2.com', 9968).catch((e) => e)
  check('another P2P server in the same process is refused, naming the one it is bound to', r instanceof Error && r.message.includes(`${P2P_SERVER.host}:${P2P_SERVER.port}`) && r.message.includes('device.provisionisr-nat2.com:9968'), r?.message)
  check('... without asking the SDK', calls('SetNat2Addr').length === 1)
  check('the same P2P server again is accepted without asking the SDK', (await setP2pServer(P2P_SERVER.host, P2P_SERVER.port)) === true && calls('SetNat2Addr').length === 1)
}
{
  // records saved before this release carry the relay of that time in host/port
  const old = { id: 'old-p2p', ...rec('FAKE0002'), host: 'c2020.autonat.com', port: 7968 }
  const r = await testLogin(old).catch((e) => e)
  check('an older record with the relay address stored still logs in (test login)', !(r instanceof Error) && loginsOf('FAKE0002').length === 1, r?.message ?? r)
  const nvr = new Nvr(old)
  check('... and as one of the server’s NVRs', await until(() => nvr.online, 5000), `${nvr.status} ${nvr.error}`)
  await nvr.stop()
  check('... through the P2P server only, never the stored relay', calls('SetNat2Addr').length === 1 && calls('LoginEx').every((c) => c.args[0] === P2P_SERVER.host && c.args[1] === P2P_SERVER.port), JSON.stringify(calls('LoginEx').map((c) => c.args.slice(0, 2))))
}
{
  // without the add-on (bin/linux/libp2pserial.so missing): still tried, and one warning says why
  const add = P2P_SERIAL.add
  P2P_SERIAL.add = null
  const warned = []
  const warn = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  await testLogin(rec('FAKE0003')).catch(() => {})
  await testLogin(rec('FAKE0004')).catch(() => {})
  console.warn = warn
  P2P_SERIAL.add = add
  const addOn = warned.filter((l) => /libp2pserial\.so/.test(l))
  check('without the add-on a login by serial number is still tried', loginsOf('FAKE0003').length === 1 && loginsOf('FAKE0004').length === 1)
  check('... with one clear warning, not one per login', addOn.length === 1 && /MD5/.test(addOn[0]), addOn.join(' | '))
}
listener.close()

// ---- in a process of their own: on by default, CCTV_P2P=off, CCTV_P2P_SERVER
{
  const nvrsUrl = new URL('../nvrs.mjs', import.meta.url).href
  const code = `const { cleanNvrFields, P2P_ENABLED, P2P_SERVER } = await import(${JSON.stringify(nvrsUrl)})
    const server = P2P_SERVER.host + ':' + P2P_SERVER.port
    try {
      cleanNvrFields({ site: 's', name: 'n', user: 'u', sn: 'N63432AB12CD' })
      console.log('accepted', P2P_ENABLED, server)
    } catch (e) {
      console.log('refused', P2P_ENABLED, server, e.message)
    }
    process.exit(0)`
  const run = (extra) => {
    const env = { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'p2p-env-')), ...extra }
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k]
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' })
    return { line: r.stdout.split('\n').find((l) => /^(refused|accepted)/.test(l)) ?? r.stderr.slice(0, 200), stderr: r.stderr }
  }
  const on = run({ CCTV_P2P: undefined, CCTV_P2P_SERVER: undefined })
  check('on by default: adding by serial is accepted', /^accepted true cli-nat20\.eyeincloud\.com:9969$/.test(on.line), on.line.slice(0, 120))
  const off = run({ CCTV_P2P: 'off', CCTV_P2P_SERVER: undefined })
  check('CCTV_P2P=off: adding by serial is refused, with the reason', /^refused false .*switched off.*CCTV_P2P=off/.test(off.line), off.line.slice(0, 160))
  const other = run({ CCTV_P2P: undefined, CCTV_P2P_SERVER: 'device.provisionisr-nat2.com:9968' })
  check('CCTV_P2P_SERVER=host:port sets the P2P server', /^accepted true device\.provisionisr-nat2\.com:9968$/.test(other.line), other.line.slice(0, 120))
  const bad = run({ CCTV_P2P: undefined, CCTV_P2P_SERVER: 'device.provisionisr-nat2.com' })
  check('... a value without a port: the default, with a warning', /^accepted true cli-nat20\.eyeincloud\.com:9969$/.test(bad.line) && /CCTV_P2P_SERVER=.*not host:port/.test(bad.stderr), `${bad.line.slice(0, 80)} | ${bad.stderr.split('\n').find((l) => l.includes('CCTV_P2P_SERVER')) ?? ''}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
