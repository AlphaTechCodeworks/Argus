// Manage NVRs and sites. Changes apply to the running server within seconds.
//   node cctv/nvr.mjs list                       all NVRs, grouped by site
//   node cctv/nvr.mjs add                        add an NVR (asks for site, name, address, login; tests it)
//   node cctv/nvr.mjs label <id>                 change an NVR's site and/or name
//   node cctv/nvr.mjs rename-site "<old>" "<new>" rename a site on all of its NVRs
//   node cctv/nvr.mjs password <id>              change the login an NVR is accessed with
//   node cctv/nvr.mjs remove <id>                remove an NVR
import { NVRS_FILE, readConfig, testLogin, uniqueId, whereIs, writeConfig } from './nvrs.mjs'
import { ask, askHidden } from './prompt.mjs'
import { cleanupSdk } from './sdk.mjs'

const [cmd, ...args] = process.argv.slice(2)
const cfg = readConfig()
const find = (id) => {
  const nvr = cfg.nvrs.find((n) => n.id === id)
  if (!nvr) {
    console.error(`No NVR with id "${id ?? ''}". Run: node cctv/nvr.mjs list`)
    process.exit(1)
  }
  return nvr
}
const save = (msg) => {
  writeConfig(cfg)
  console.log(`${msg}\nSaved to ${NVRS_FILE}; the server picks it up within a few seconds.`)
}

const askLogin = async (defaults = {}) => {
  const user = await ask('NVR user name', defaults.user ?? 'admin')
  const password = await askHidden('NVR password: ')
  if (!password) {
    console.error('A password is required')
    process.exit(1)
  }
  return { user, password }
}

const tryLogin = async (nvr) => {
  process.stdout.write(`Testing login to ${whereIs(nvr)}... `)
  try {
    const model = await testLogin(nvr)
    console.log(`OK (${model})`)
    return true
  } catch (e) {
    console.log(`FAILED: ${e.message}`)
    const keep = await ask('Save anyway? (y/N)', 'n')
    return keep.toLowerCase().startsWith('y')
  } finally {
    // this tool exits right after: once a login by serial number has started the SDK's NAT threads,
    // an exit without NET_SDK_Cleanup can end in a segfault (sdk.mjs cleanupSdk)
    if (nvr.sn) await cleanupSdk()
  }
}

switch (cmd) {
  case 'list':
  case undefined: {
    if (cfg.nvrs.length === 0) {
      console.log('No NVRs yet. Add one with: node cctv/nvr.mjs add')
      break
    }
    const bySite = Map.groupBy(cfg.nvrs, (n) => n.site || 'Unassigned')
    for (const [site, list] of [...bySite].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${site}`)
      for (const n of list) console.log(`  ${n.id.padEnd(20)} ${n.name.padEnd(24)} ${whereIs(n)}  (user ${n.user})`)
    }
    break
  }

  case 'add': {
    const sites = [...new Set(cfg.nvrs.map((n) => n.site))]
    if (sites.length) console.log(`Existing sites: ${sites.join(', ')}`)
    const site = await ask('Site', sites[0] ?? 'Main site')
    const name = await ask('NVR name', `NVR ${cfg.nvrs.length + 1}`)
    const host = await ask('NVR IP address')
    if (!/^[\w.-]+$/.test(host)) {
      console.error('Enter an IP address or host name')
      process.exit(1)
    }
    const port = Number(await ask('SDK port', '6036'))
    const login = await askLogin()
    const nvr = { id: uniqueId(name, new Set(cfg.nvrs.map((n) => n.id))), site, name, host, port, ...login }
    if (!(await tryLogin(nvr))) process.exit(1)
    cfg.nvrs.push(nvr)
    save(`Added ${nvr.id} (${name}) at site "${site}".`)
    break
  }

  case 'label': {
    const nvr = find(args[0])
    nvr.site = await ask('Site', nvr.site)
    nvr.name = await ask('NVR name', nvr.name)
    save(`${nvr.id} is now "${nvr.name}" at site "${nvr.site}".`)
    break
  }

  case 'rename-site': {
    const [from, to] = args
    const list = cfg.nvrs.filter((n) => n.site === from)
    if (!from || !to || list.length === 0) {
      console.error('Usage: node cctv/nvr.mjs rename-site "<old site>" "<new site>"')
      process.exit(1)
    }
    for (const n of list) n.site = to
    save(`Renamed site "${from}" to "${to}" (${list.length} NVR${list.length > 1 ? 's' : ''}).`)
    break
  }

  case 'password': {
    const nvr = find(args[0])
    Object.assign(nvr, await askLogin(nvr))
    if (!(await tryLogin(nvr))) process.exit(1)
    save(`Updated the login for ${nvr.id}.`)
    break
  }

  case 'remove': {
    const nvr = find(args[0])
    const sure = await ask(`Remove ${nvr.id} (${nvr.name}, ${whereIs(nvr)})? (y/N)`, 'n')
    if (!sure.toLowerCase().startsWith('y')) break
    cfg.nvrs = cfg.nvrs.filter((n) => n !== nvr)
    save(`Removed ${nvr.id}.`)
    break
  }

  default:
    console.error('Commands: list | add | label <id> | rename-site "<old>" "<new>" | password <id> | remove <id>')
    process.exit(1)
}
process.exit(0)
