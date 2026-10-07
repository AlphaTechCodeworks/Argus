// Which modules ask "can an XML command be sent" (xml-session.mjs: the control login, or the
// worker's while it is borrowed) and which still ask for the control login itself. The settings
// modules must use the helpers, or an NVR that refuses the control login shows "offline" on their
// pages again; playback and searches must not, because they hold SDK handles on this process's
// own login and cannot be borrowed. Reads the sources only.
// Run:  node cctv/test/xml-online-wiring.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const lines = (f, re) => src(f).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l)).map(([n]) => n)

const XML_MODULES = ['imaging', 'lens', 'streams', 'substreams', 'tripwire', 'osd', 'nvr-clock', 'nvr-log', 'nvr-netstatus', 'nvr-probe', 'relays', 'alarm-watch', 'nvr-disks']
for (const m of XML_MODULES) {
  const f = `${m}.mjs`
  const left = lines(f, /\bnvr\??\.(online|degraded|gen)\b/)
  check(`${f}: asks the XML session, not the control login`, left.length === 0, left.length ? `lines ${left.join(', ')}` : '')
  check(`${f}: imports the helpers it uses`, /from '\.\/xml-session\.mjs'/.test(src(f)))
  const used = ['xmlOnline', 'xmlDegraded', 'xmlGen'].filter((h) => new RegExp(`\\b${h}\\(`).test(src(f)))
  const imported = (/import \{([^}]*)\} from '\.\/xml-session\.mjs'/.exec(src(f))?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  check(`${f}: imports exactly those`, used.slice().sort().join() === imported.slice().sort().join(), `uses ${used.join(' ')}; imports ${imported.join(' ')}`)
}

// the two admin routes in events.mjs that only send XML
const ev = src('events.mjs')
check('events.mjs: the probe route asks the XML session', /if \(!xmlOnline\(nvr\)\) return \[409[^\n]*\s+const run = await probeEvents/.test(ev))
check('events.mjs: the motion-tune route asks the XML session', /if \(!xmlOnline\(nvr\)\) return \[409[^\n]*\s+const ch = Number\(tune\[2\]\)/.test(ev))
check('events.mjs: the search poll still needs the control login', /export function pollable[\s\S]{0,400}if \(!nvr\.online\)/.test(ev) && /if \(nvr\.degraded\) return \{ ok: false/.test(ev))

// server.mjs: the disks route and the power route
const sv = src('server.mjs')
check('server.mjs: the NVR disks route asks the XML session', /if \(!xmlOnline\(nvr\)\) return sendJson\(res, 409[^\n]*\s+try \{\s+if \(url\.searchParams\.get\('discover'\)\)/.test(sv))
check('server.mjs: the power route asks the XML session', /if \(body\.confirm !== true\)[^\n]*\s+if \(!xmlOnline\(nvr\)\) return sendJson\(res, 409/.test(sv))
check('server.mjs: playback still needs the control login', /if \(!nvr\.online\) return ws\.close\(1013, 'NVR offline'\)/.test(sv))

// and the ones that must stay on the control login
for (const f of ['playback.mjs', 'motion.mjs', 'backfill.mjs', 'rec-playback.mjs', 'rec-fallback.mjs', 'camera-export.mjs']) {
  check(`${f}: does not use the XML session helpers`, !/xml-session\.mjs/.test(src(f)))
}
check('playback.mjs: its route still needs the control login', /if \(!nvr\.online\) return \[503/.test(src('playback.mjs')))

// the camera-detail read stays on the control login: heavy and unattended (the nightly export)
check('nvrs.mjs: camera detail is never asked of the worker', !/op: 'detail'/.test(src('nvrs.mjs')) && !/op === 'detail'/.test(src('nvr-worker.mjs')))
check('camera-export.mjs: still needs the control login', /if \(!nvr\.online\) \{/.test(src('camera-export.mjs')))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
