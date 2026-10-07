// Requests the main process sends to an NVR's live worker and waits on (worker-ipc.mjs REQ / RES).
// Everything else in the protocol is one-way. These exist for an NVR that refuses the main
// process's own login while its worker is logged in (shad, 2026-10-06, at its session limit): the
// command goes out on the worker's login instead (nvr-xml.mjs).
// Only the book-keeping lives here, with no child process in it, so it can be tested by itself:
// worker-supervisor.mjs supplies `send` and feeds the replies in.
import { MSG } from './worker-ipc.mjs'

// The wait for the worker's answer covers everything the worker may still do with the command. It
// is told to send it within SEND_BY_MS of being handed it, or not at all (nvr-xml.mjs notAfter), and
// one sent at the last moment then has its own time limit to run. At 5 s past the send-by time, a
// command sent at 88 s was reported as timed out and carried out after that: a reboot said to have
// failed, and the NVR rebooting.
export const SEND_BY_MS = 90_000 // nvr-xml.mjs takes its XML_CAP_MS from here
export const CALL_BUDGET_MS = 20_000 // the longest time limit of a call the worker makes for a request (sdk.mjs BUDGETS: TransparentConfig 20 s, a reboot 10 s)
export const REQUEST_TIMEOUT_MS = SEND_BY_MS + CALL_BUDGET_MS + 5000 // (5 s for the worker's own queue and the way back)

const named = (name, message, more = {}) => Object.assign(new Error(message), { name, ...more })

/**
 * @param {{ send: (m: object) => boolean | void, timeoutMs?: number }} o send: hands a message to
 *   the worker; false (or a throw) means nothing was sent.
 */
export function makeRequests({ send, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const pending = new Map() // id -> { resolve, reject, timer }
  let nextId = 1
  return {
    size: () => pending.size,
    /** Resolves to the worker's reply; rejects with its refusal, a timeout, or the worker going. */
    request(msg, { timeoutMs: wait = timeoutMs } = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(named('SdkTimeout', 'the video connection did not answer in time'))
        }, wait)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        let sent = false
        try {
          sent = send({ ...msg, t: MSG.REQ, id }) !== false
        } catch {
          sent = false
        }
        if (sent) return
        clearTimeout(timer)
        pending.delete(id)
        reject(named('WorkerNotReady', 'the video connection is not ready; nothing was sent'))
      })
    },
    /** A RES message from the worker; false if nobody is waiting for it (it timed out meanwhile). */
    onReply(m) {
      const p = pending.get(m?.id)
      if (!p) return false
      clearTimeout(p.timer)
      pending.delete(m.id)
      if (m.ok) p.resolve(m)
      else p.reject(named(m.error?.name || 'Error', m.error?.message || 'the request failed', { status: m.error?.status ?? undefined, extra: m.error?.extra ?? undefined }))
      return true
    },
    /** The worker exited or was restarted: nothing still waiting will be answered. */
    failAll(why) {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(named('WorkerLost', why))
      }
      pending.clear()
    }
  }
}
