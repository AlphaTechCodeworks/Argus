// Settings > Server: restart the server from the app (POST /api/admin/restart, admins only), then
// wait for it to answer again and say so.
const btn = document.getElementById('restartBtn')
const msg = document.getElementById('restartMsg')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

btn?.addEventListener('click', async () => {
  if (!confirm('Restart the server now? Live video and server recording pause for about 10 seconds.')) return
  btn.disabled = true
  msg.textContent = 'Restarting…'
  const res = await fetch('/api/admin/restart', { method: 'POST' }).catch(() => null)
  if (!res?.ok) {
    const body = await res?.json().catch(() => null)
    msg.textContent = body?.error ?? 'The server did not accept the restart.'
    btn.disabled = false
    return
  }
  const t0 = Date.now()
  await sleep(3000)
  for (let i = 0; i < 60; i++) {
    const ok = await fetch('/healthz', { cache: 'no-store' }).then((r) => r.ok).catch(() => false)
    if (ok) {
      msg.textContent = `Back up after ${Math.round((Date.now() - t0) / 1000)} s.`
      btn.disabled = false
      return
    }
    await sleep(1000)
  }
  msg.textContent = 'Not back after a minute: check the Health page, or the server itself.'
  btn.disabled = false
})
