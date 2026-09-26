// Settings > Server: restart the server (POST /api/admin/restart), or reboot the whole machine
// (POST /api/admin/reboot, shown only where the machine side is installed: /api/me canRebootMachine).
// Either way: ask first, then wait for the server to answer again and say how long it took.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function wire({ btn, msg, url, confirmText, waitingText, firstWaitMs, giveUpS }) {
  btn?.addEventListener('click', async () => {
    if (!confirm(confirmText)) return
    btn.disabled = true
    msg.textContent = waitingText
    const res = await fetch(url, { method: 'POST' }).catch(() => null)
    if (!res?.ok) {
      const body = await res?.json().catch(() => null)
      msg.textContent = body?.error ?? 'The server did not accept that.'
      btn.disabled = false
      return
    }
    const t0 = Date.now()
    await sleep(firstWaitMs)
    // (answering at all is not enough after a reboot request: wait until it has actually gone away)
    for (let i = 0; i < giveUpS; i++) {
      const ok = await fetch('/healthz', { cache: 'no-store' }).then((r) => r.ok).catch(() => false)
      if (ok) {
        msg.textContent = `Back up after ${Math.round((Date.now() - t0) / 1000)} s.`
        btn.disabled = false
        return
      }
      await sleep(1000)
    }
    msg.textContent = `Not back after ${Math.round(giveUpS / 60)} minutes: check the Health page, or the machine itself.`
    btn.disabled = false
  })
}

wire({
  btn: document.getElementById('restartBtn'),
  msg: document.getElementById('restartMsg'),
  url: '/api/admin/restart',
  confirmText: 'Restart the server now? Live video and server recording pause for about 10 seconds.',
  waitingText: 'Restarting…',
  firstWaitMs: 3000,
  giveUpS: 60
})

wire({
  btn: document.getElementById('rebootBtn'),
  msg: document.getElementById('rebootMsg'),
  url: '/api/admin/reboot',
  confirmText: 'Reboot the whole machine now? Live video and server recording stop for a minute or two.',
  waitingText: 'Rebooting… (this page waits for it to come back)',
  firstWaitMs: 20_000, // the old server answers for a few seconds before the machine goes down
  giveUpS: 300
})

// the reboot section only where the machine side is installed (and for an admin)
fetch('/api/me')
  .then((r) => r.json())
  .then((me) => {
    const s = document.getElementById('rebootSection')
    if (s && me?.canRebootMachine) s.hidden = false
  })
  .catch(() => {})
