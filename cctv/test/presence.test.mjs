// Tests for makePresence (presence.mjs): distinct connected sessions, local vs remote, counted once
// whatever the number of sockets. No server, no sockets -- plain objects stand in for the sockets.
//   node cctv/test/presence.test.mjs
import { makePresence } from '../presence.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
const J = (o) => JSON.stringify(o)

// nobody connected
{
  const p = makePresence()
  check('empty: nobody connected', J(p.summary()) === J({ people: 0, local: 0, remote: 0 }))
}

// one local viewer with several sockets (tabs/cameras) is one person
{
  const p = makePresence()
  p.join('alice', {}, { remote: false })
  p.join('alice', {}, { remote: false })
  p.join('alice', {}, { remote: false })
  check('one person, many sockets, counted once', J(p.summary()) === J({ people: 1, local: 1, remote: 0 }))
}

// local and remote split
{
  const p = makePresence()
  p.join('alice', {}, { remote: false })
  p.join('bob', {}, { remote: true })
  p.join('carol', {}, { remote: true })
  check('local vs remote split', J(p.summary()) === J({ people: 3, local: 1, remote: 2 }))
}

// a viewer is forgotten only when its LAST socket closes
{
  const p = makePresence()
  const a1 = {}
  const a2 = {}
  p.join('alice', a1, { remote: false })
  p.join('alice', a2, { remote: false })
  p.leave('alice', a1)
  check('still present with one socket left', p.summary().people === 1)
  p.leave('alice', a2)
  check('gone when the last socket closes', p.summary().people === 0)
}

// leaving an unknown key or socket is harmless
{
  const p = makePresence()
  p.join('alice', {}, {})
  p.leave('nobody', {})
  p.leave('alice', {}) // a socket that was never joined
  check('leaving an unknown socket does not drop the viewer', p.summary().people === 1)
}

// a session that moves onto the tunnel is counted as remote (its latest state)
{
  const p = makePresence()
  const s1 = {}
  p.join('alice', s1, { remote: false })
  const s2 = {}
  p.join('alice', s2, { remote: true })
  check('latest socket decides local/remote', J(p.summary()) === J({ people: 1, local: 0, remote: 1 }))
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
