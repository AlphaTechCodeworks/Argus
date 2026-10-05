// A short TCP reachability probe, used before an SDK login.
//
// Why: NET_SDK_Login blocks inside the SDK, on a thread-pool thread, for as long
// as the NVR takes to answer. Against an NVR whose network has failed (no reply
// at all, not a refusal) that was measured at over 90 s on the live server, which
// is longer than the watchdog's "one call stuck this long" limit, so the watchdog
// killed the whole process, systemd restarted it, the same NVR was tried again,
// and the four healthy NVRs and their cameras lost recording every time round.
//
// A plain TCP connect to the same address answers in milliseconds when the NVR is
// there, and tells us within a couple of seconds when it is not. So we ask that
// question first, in JavaScript, where a timeout really does abandon the attempt,
// instead of asking it through a native call we cannot cancel.
//
// This is deliberately only a reachability check: a socket that connects says
// nothing about the login succeeding. It exists to avoid the blocking call in the
// one case where it is certain to block, not to replace it.
import { createConnection, isIP } from 'node:net'

/** How long to wait for the TCP handshake (short: a reachable NVR answers in milliseconds). */
export const PROBE_MS = Number(process.env.CCTV_PROBE_MS ?? 2000)

// A name that will not resolve is a fault in name service, not an answer about the NVR, so we
// make no verdict: the probe is skipped and the login goes ahead as it did before. (It also keeps
// the fake-SDK tests, which use reserved *.invalid hostnames, behaving as they always have.)
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'])

/**
 * Can we open a TCP connection to host:port within timeoutMs?
 * Never throws and never rejects: a probe that cannot be made is not a reason to fail a login,
 * so anything we cannot interpret resolves { ok: true, skipped: true }.
 * @returns {Promise<{ ok: boolean, why: string, ms: number, skipped?: boolean }>}
 */
export function tcpReachable(host, port, timeoutMs = PROBE_MS) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    let socket = null
    let done = false
    const finish = (ok, why = '', skipped = false) => {
      if (done) return
      done = true
      try {
        socket?.destroy()
      } catch {}
      resolve({ ok, why, ms: Date.now() - t0, skipped })
    }
    try {
      socket = createConnection({ host: String(host), port: Number(port), timeout: timeoutMs })
    } catch {
      // bad arguments, no sockets left, ...: nothing was learnt about the NVR, so let the login go ahead
      return finish(true, '', true)
    }
    socket.once('connect', () => finish(true))
    // 'timeout' is the idle timer; before a connection it fires when the handshake has not completed
    socket.once('timeout', () => finish(false, `did not answer a connection to ${host}:${port} within ${timeoutMs} ms`))
    socket.once('error', (e) => {
      if (DNS_CODES.has(e?.code)) return finish(true, '', true)
      finish(false, `cannot be reached at ${host}:${port} (${e?.code || e?.message || 'connection failed'})`)
    })
  })
}

/**
 * The address to probe for an NVR config, or null when no sensible probe can be made
 * (then we skip the probe rather than guess). An NVR reached by serial number (cfg.sn) is
 * never probed: the SDK reaches it through the P2P cloud over UDP only, so a TCP connect
 * to any address says nothing about it, and the host/port in its record are not used.
 * @param {{ host?: string, port?: number|string, sn?: string }} cfg
 */
export function probeTarget({ host, port, sn } = {}) {
  const h = String(host ?? '').trim()
  const p = Number(port)
  if (sn) return null
  if (!h) return null
  if (!(PROBE_MS > 0)) return null // CCTV_PROBE_MS=0 switches the probe off entirely
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null
  // a hostname is fine (DNS failure is itself a real "cannot be reached"); only reject nonsense
  if (!isIP(h) && !/^[A-Za-z0-9._-]+$/.test(h)) return null
  return { host: h, port: p }
}
