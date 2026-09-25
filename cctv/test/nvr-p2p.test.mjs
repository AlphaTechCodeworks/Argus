// Offline tests for NVRs added by serial number (TVT P2P relay): the settings checks, the
// admin API's duplicate rules and the device identity used by change logs. No NVR, no network.
// Run inside the container:  node cctv/test/nvr-p2p.test.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p2p-'))
process.env.CCTV_P2P = 'on' // switched off by default (nvrs.mjs P2P_ENABLED); the default is checked at the end
const { P2P_RELAY, cleanNvrFields, whereIs } = await import('../nvrs.mjs')
const { handleAdmin } = await import('../admin.mjs')
const { deviceOf } = await import('../nvr-xml.mjs')

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
const base = { site: 'Remote yard', name: 'Yard NVR', user: 'admin' }

// ---- settings checks
const p = cleanNvrFields({ ...base, sn: ' n63432ab12cd ' })
check('by serial: serial cleaned (trimmed, upper case)', p.sn === 'N63432AB12CD', p.sn)
check('by serial: the relay takes the place of the address', p.host === P2P_RELAY.host && p.port === P2P_RELAY.port, `${p.host}:${p.port}`)
check('relay is TVT P2P 2.0 (c2020.autonat.com:7968)', P2P_RELAY.host === 'c2020.autonat.com' && P2P_RELAY.port === 7968)
check('by serial: spaces or symbols refused', throws(() => cleanNvrFields({ ...base, sn: 'N634 32' }), /letters and digits/) && throws(() => cleanNvrFields({ ...base, sn: 'N6343<2' }), /letters and digits/))
check('by serial: too short refused', throws(() => cleanNvrFields({ ...base, sn: 'N63' }), /letters and digits/))
const lan = cleanNvrFields({ ...base, host: '192.168.0.228', port: 6036 })
check('by address: unchanged, no serial', lan.host === '192.168.0.228' && lan.port === 6036 && !('sn' in lan))
check('by address: host still required', throws(() => cleanNvrFields({ ...base }), /IP address/))
const toP2p = cleanNvrFields({ sn: 'N63432AB12CD' }, { partial: true })
check('edit: switching to serial sets the relay', toP2p.sn === 'N63432AB12CD' && toP2p.host === P2P_RELAY.host && toP2p.port === P2P_RELAY.port)
check('edit: switching back to address without one is refused', throws(() => cleanNvrFields({ sn: '' }, { partial: true }), /IP address/))
const toLan = cleanNvrFields({ sn: '', host: '192.168.2.24', port: 6036 }, { partial: true })
check('edit: switching back to address', toLan.sn === '' && toLan.host === '192.168.2.24' && toLan.port === 6036)
const rename = cleanNvrFields({ name: 'Yard NVR 2' }, { partial: true })
check('edit: renaming touches nothing else', Object.keys(rename).join() === 'name', Object.keys(rename).join())

// ---- identity for change logs, labels
const fake = (cfg) => ({ cfg })
check('change logs: serial is the identity (all P2P NVRs share the relay address)', deviceOf(fake({ host: P2P_RELAY.host, port: 7968, sn: 'A1B2C3D4' })) === 'sn:A1B2C3D4' && deviceOf(fake({ host: P2P_RELAY.host, port: 7968, sn: 'Z9Y8X7W6' })) !== deviceOf(fake({ host: P2P_RELAY.host, port: 7968, sn: 'A1B2C3D4' })))
check('change logs: by address unchanged', deviceOf(fake({ host: '192.168.0.228', port: 6036 })) === '192.168.0.228:6036')
check('labels', whereIs({ sn: 'A1B2C3D4' }) === 'serial A1B2C3D4 (TVT P2P)' && whereIs({ host: '192.168.0.228', port: 6036 }) === '192.168.0.228:6036')

// ---- admin API (skipTest: nothing is logged in to)
const post = (body) => handleAdmin('POST', '/api/admin/nvrs', async () => ({ ...body, password: 'x', skipTest: true }))
const [s1, b1] = await post({ ...base, sn: 'N63432AB12CD' })
check('admin: add by serial', s1 === 201, JSON.stringify(b1))
const [s2, b2] = await post({ ...base, name: 'Same box', sn: 'n63432ab12cd' })
check('admin: the same serial twice is refused', s2 === 409 && /already/.test(b2.error), JSON.stringify(b2))
const [s3] = await post({ ...base, name: 'Other box', sn: 'N63108CD34EF' })
check('admin: another serial on the same relay is fine', s3 === 201)
const [s4] = await post({ ...base, name: 'LAN box', host: '192.168.0.228', port: 6036 })
check('admin: add by address next to them', s4 === 201)
const [, list] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
const byId = Object.fromEntries(list.map((n) => [n.name, n]))
check('admin: list says how each is reached', byId['Yard NVR']?.via === 'p2p' && byId['Yard NVR']?.sn === 'N63432AB12CD' && byId['LAN box']?.via === 'lan' && byId['LAN box']?.sn === '')
check('admin: passwords never listed', list.every((n) => !('password' in n)))
const [s5, b5] = await handleAdmin('PUT', `/api/admin/nvrs/${encodeURIComponent(byId['Other box'].id)}`, async () => ({ sn: 'N63432AB12CD', skipTest: true }))
check('admin: editing to a serial already used is refused', s5 === 409, JSON.stringify(b5))
const [s6] = await handleAdmin('PUT', `/api/admin/nvrs/${encodeURIComponent(byId['Other box'].id)}`, async () => ({ sn: '', host: '192.168.2.24', port: 6036, skipTest: true }))
const [, list2] = await handleAdmin('GET', '/api/admin/nvrs', async () => ({}))
const other = list2.find((n) => n.name === 'Other box')
check('admin: switched back to address, serial removed', s6 === 200 && other.via === 'lan' && other.host === '192.168.2.24' && other.sn === '')

// ---- switched off (the default): adding by serial is refused, with the reason
{
  const nvrsUrl = new URL('../nvrs.mjs', import.meta.url).href
  const code = `const { cleanNvrFields, P2P_ENABLED } = await import(${JSON.stringify(nvrsUrl)})
    try {
      cleanNvrFields({ site: 's', name: 'n', user: 'u', sn: 'N63432AB12CD' })
      console.log('accepted', P2P_ENABLED)
    } catch (e) {
      console.log('refused', P2P_ENABLED, e.message)
    }
    process.exit(0)`
  const env = { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'p2p-off-')) }
  delete env.CCTV_P2P
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' })
  const line = r.stdout.split('\n').find((l) => /^(refused|accepted)/.test(l)) ?? r.stderr.slice(0, 200)
  check('P2P off by default: adding by serial is refused, with the reason', /^refused false .*switched off/.test(line), line.slice(0, 120))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
