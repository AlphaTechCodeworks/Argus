// Settings > Active Directory > Single sign-on (Windows), admins only (the server side is sso.mjs):
// upload the keytab made on DC01, see what is in it (never the keys: the server never sends them),
// switch it on or off, and the last attempts with the reason each one was refused.

/** The overall line. */
export function ssoStatusText(sso) {
  if (!sso) return 'Could not read the single sign-on settings.'
  if (sso.killed) return 'Switched off on this server (CCTV_SSO=off).'
  if (sso.ready) return 'On: office Windows PCs on the domain are signed in automatically.'
  const parts = [sso.enabled ? 'Switched on, but not working yet.' : 'Off.']
  if (sso.problems?.length) parts.push(...sso.problems)
  return parts.join(' ')
}

/** One line per key in the keytab: principal, encryption type, key version, usable here. */
export function keytabLines(keytab) {
  if (!keytab?.present) return ['No keytab uploaded.']
  return keytab.entries.map((e) => `${e.principal} · ${e.etypeName} · key version ${e.kvno}${!e.usable ? ' · not accepted (only AES is)' : !e.matches ? ' · not for this server' : ''}`)
}

/** One attempt, for the list. */
export function attemptLine(a, fmt = (t) => new Date(t).toLocaleString()) {
  const who = a.user ? `${a.user}: ` : ''
  return `${fmt(a.at)} · ${a.ip || '?'} · ${who}${a.ok ? 'signed in' : `refused (${a.reason}) ${a.message ?? ''}`.trim()}`
}

if (typeof document !== 'undefined' && document.getElementById('sso-status')) {
  const $ = (id) => document.getElementById(id)
  const api = async (method, path = '', body) => {
    const r = await fetch(`/api/admin/ad/sso${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `the server answered ${r.status}`)
    return j
  }
  const words = (e) => (e instanceof TypeError ? 'the server could not be reached' : e?.message || 'something went wrong')
  const li = (text) => Object.assign(document.createElement('li'), { textContent: text })

  const paint = (sso) => {
    $('sso-status').textContent = ssoStatusText(sso)
    $('sso-principal').textContent = sso.servicePrincipal
    $('sso-enabled').checked = sso.enabled
    $('sso-enabled').disabled = sso.killed
    $('sso-remove').hidden = !sso.keytab.present
    const info = document.createElement('ul')
    info.className = 'st-help'
    info.append(...keytabLines(sso.keytab).map(li))
    const when = sso.keytab.present && sso.keytab.uploadedAt ? Object.assign(document.createElement('p'), { className: 'st-meta', textContent: `Uploaded ${new Date(sso.keytab.uploadedAt).toLocaleString()}${sso.keytab.uploadedBy ? ` by ${sso.keytab.uploadedBy}` : ''}.` }) : ''
    $('sso-keytab-info').replaceChildren(info, when)
    $('sso-recent').replaceChildren(...(sso.recent.length ? sso.recent.map((a) => li(attemptLine(a))) : [li('None since the server started.')]))
  }
  const load = () => api('GET').then((j) => paint(j.sso)).catch((e) => { $('sso-status').textContent = `Could not read the single sign-on settings: ${words(e)}` })

  $('sso-upload').addEventListener('click', async () => {
    const msg = $('sso-keytab-msg')
    const file = $('sso-keytab').files?.[0]
    if (!file) { msg.textContent = 'Choose the keytab file first.'; return }
    if (file.size > 64 * 1024) { msg.textContent = 'That file is far too large to be a keytab.'; return }
    msg.textContent = 'Uploading…'
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const j = await api('POST', '/keytab', { keytab: btoa(bin) })
      $('sso-keytab').value = ''
      paint(j.sso)
      msg.textContent = 'Keytab saved. Now delete the file from DC01.'
    } catch (e) {
      msg.textContent = words(e)
    }
  })
  $('sso-remove').addEventListener('click', async () => {
    if (!confirm('Remove the keytab? Single sign-on stops until a new one is uploaded.')) return
    const msg = $('sso-keytab-msg')
    try {
      paint((await api('POST', '/keytab', { keytab: null })).sso)
      msg.textContent = 'Keytab removed.'
    } catch (e) {
      msg.textContent = words(e)
    }
  })
  $('sso-enabled').addEventListener('change', async (e) => {
    const msg = $('sso-msg')
    msg.textContent = 'Saving…'
    try {
      paint((await api('POST', '', { enabled: e.target.checked })).sso)
      msg.textContent = 'Saved.'
    } catch (err) {
      e.target.checked = !e.target.checked
      msg.textContent = words(err)
    }
  })
  load()
}
