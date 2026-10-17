// Settings > Active Directory, admins only (the server side is ad-api.mjs / ad.mjs): switch Windows
// sign-in on or off, the domain controllers and groups, trust each DC's certificate (Check connection,
// then Trust this certificate), or the domain CA instead, and test a sign-in. The server checks
// everything again; the look-up password never comes back to this page.

/** One line on how a server is trusted. */
export function trustText(how) {
  if (how === 'pinned') return 'Trusted (certificate pinned)'
  if (how === 'ca') return 'Trusted through the CA certificate, if the name matches'
  return 'Not trusted yet: check the connection, then trust its certificate'
}

/** The overall line at the top of the section. */
export function statusText(settings, status = {}) {
  if (!settings) return 'Could not read the Windows sign-in settings.'
  const untrusted = settings.servers.filter((s) => settings.trust?.[s] === 'none')
  const parts = []
  if (!settings.enabled) parts.push('Off: only local Argus accounts can sign in.')
  else parts.push(`On: staff can sign in with their ${settings.domain} Windows account.`)
  if (untrusted.length) parts.push(`Not trusted yet: ${untrusted.join(', ')}.`)
  if (settings.enabled && !settings.lookupUser) parts.push(`No look-up account: Windows users sign in again every ${settings.graceHours} hours.`)
  if (status.lastRecheckError) parts.push(`Last re-check failed: ${status.lastRecheckError}`)
  return parts.join(' ')
}

/** What a test sign-in found, in plain words. */
export function testText(r) {
  if (!r) return ''
  const lines = [r.message]
  if (r.groups) {
    for (const [role, g] of Object.entries(r.groups)) if (g?.name && !g.dn) lines.push(`The group "${g.name}" was not found in AD.`)
  }
  if (r.lookup) lines.push(r.lookup.message)
  return lines.join(' ')
}

/** A certificate, for a person to compare. */
export function certLines(c) {
  if (!c) return []
  return [
    ['Issued to', c.subject],
    ['Issued by', c.issuer],
    ...(c.altNames ? [['Other names', c.altNames]] : []),
    ['Valid', `${c.validFrom} to ${c.validTo}${c.expired ? ' (EXPIRED)' : c.notYetValid ? ' (not valid yet)' : ''}`],
    ['SHA-256 fingerprint', c.fingerprint256]
  ]
}

if (typeof document !== 'undefined' && document.getElementById('ad-form')) {
  const $ = (id) => document.getElementById(id)
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props)
    n.append(...kids.filter((k) => k !== null && k !== undefined))
    return n
  }
  const api = async (method, path = '', body) => {
    const r = await fetch(`/api/admin/ad${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `the server answered ${r.status}`)
    return j
  }
  const words = (e) => (e instanceof TypeError ? 'the server could not be reached' : e?.message || 'something went wrong')
  let current = null

  /** The form as settings (what is typed now, saved or not). */
  const formSettings = () => ({
    enabled: $('ad-enabled').checked,
    allowPasswordChange: $('ad-pwchange').checked,
    servers: $('ad-servers').value.split(/[\s,;]+/).filter(Boolean),
    domain: $('ad-domain').value.trim(),
    baseDn: $('ad-basedn').value.trim(),
    groups: { admin: $('ad-g-admin').value.trim(), viewer: $('ad-g-viewer').value.trim(), watch: $('ad-g-watch').value.trim() },
    graceHours: Number($('ad-grace').value),
    recheckMinutes: Number($('ad-recheck').value),
    lookupUser: $('ad-lookup-user').value.trim(),
    ...($('ad-lookup-pass').value ? { lookupPassword: $('ad-lookup-pass').value } : {})
  })

  const paint = (s, status) => {
    current = s
    $('ad-status').textContent = statusText(s, status)
    $('ad-enabled').checked = s.enabled
    $('ad-pwchange').checked = s.allowPasswordChange !== false
    $('ad-servers').value = s.servers.join('\n')
    $('ad-domain').value = s.domain
    $('ad-basedn').value = s.baseDn
    $('ad-g-admin').value = s.groups.admin ?? ''
    $('ad-g-viewer').value = s.groups.viewer ?? ''
    $('ad-g-watch').value = s.groups.watch ?? ''
    $('ad-grace').value = s.graceHours
    $('ad-recheck').value = s.recheckMinutes
    $('ad-lookup-user').value = s.lookupUser
    $('ad-lookup-pass').value = ''
    $('ad-lookup-pass').placeholder = s.lookupPasswordSet ? 'set: leave empty to keep' : 'not set'
    $('ad-ca').value = s.caPem
    paintTrust(s)
  }

  const paintTrust = (s) => {
    $('ad-servers-trust').replaceChildren(
      ...s.servers.map((server) => {
        const box = el('div', { className: 'ad-trust' })
        const state = el('span', { className: 'st-meta', textContent: trustText(s.trust?.[server]) })
        const details = el('div')
        const check = el('button', { type: 'button', textContent: 'Check connection' })
        check.addEventListener('click', async () => {
          check.disabled = true
          details.replaceChildren(el('p', { className: 'st-meta', textContent: `Connecting to ${server}…` }))
          try {
            const r = await api('POST', '/check', { server })
            if (!r.reachable) {
              details.replaceChildren(el('p', { className: 'st-error-text', textContent: `Could not connect: ${r.error}` }))
              return
            }
            const dl = el('dl', { className: 'ad-cert' })
            for (const [k, v] of certLines(r.cert)) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }))
            const note = r.trusted.pinMatches ? 'This is the certificate already trusted.' : r.trusted.pinned ? 'This is NOT the certificate trusted before: it has changed. Make sure it is genuine before trusting it.' : r.trusted.ca ? 'Trusted through the CA certificate.' : r.trusted.caReason || 'Not trusted yet.'
            const trust = el('button', { type: 'button', className: 'st-primary', textContent: 'Trust this certificate', hidden: r.trusted.pinMatches })
            const msg = el('span', { className: 'st-meta', role: 'status' })
            trust.addEventListener('click', async () => {
              if (!confirm(`Trust the certificate of ${server}?\n\n${r.cert.subject}\nSHA-256 ${r.cert.fingerprint256}`)) return
              trust.disabled = true
              try {
                const j = await api('POST', '/trust', { server, fingerprint: r.cert.fingerprint256 })
                paint(j.settings, {})
              } catch (e) {
                msg.textContent = words(e)
                trust.disabled = false
              }
            })
            details.replaceChildren(dl, el('p', { className: 'st-help', textContent: note }), el('p', {}, trust, ' ', msg))
          } catch (e) {
            details.replaceChildren(el('p', { className: 'st-error-text', textContent: words(e) }))
          } finally {
            check.disabled = false
          }
        })
        box.append(el('p', {}, el('b', { textContent: server }), ' · ', state, ' ', check), details)
        return box
      })
    )
  }

  const load = () =>
    api('GET')
      .then((j) => paint(j.settings, j.status))
      .catch((e) => {
        $('ad-status').textContent = `Could not read the Windows sign-in settings: ${words(e)}`
      })

  $('ad-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = $('ad-msg')
    msg.textContent = 'Saving…'
    try {
      const j = await api('POST', '', formSettings())
      paint(j.settings, {})
      msg.textContent = 'Saved.'
    } catch (err) {
      msg.textContent = words(err)
    }
  })

  $('ad-ca-save').addEventListener('click', async () => {
    const msg = $('ad-ca-msg')
    try {
      const j = await api('POST', '', { caPem: $('ad-ca').value })
      paint(j.settings, {})
      msg.textContent = j.settings.caPem ? 'CA certificate saved.' : 'CA certificate removed.'
    } catch (e) {
      msg.textContent = words(e)
    }
  })

  $('ad-test').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = $('ad-test-msg')
    msg.textContent = 'Asking the domain controller…'
    try {
      const r = await api('POST', '/test', { user: $('ad-test-user').value.trim(), password: $('ad-test-pass').value, settings: { ...formSettings(), enabled: false } })
      msg.textContent = testText(r)
    } catch (err) {
      msg.textContent = words(err)
    } finally {
      $('ad-test-pass').value = ''
    }
  })

  load()
}
