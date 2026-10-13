// Keeps the vendor SDK's own chatter out of the journal. The SDK prints from inside each NVR worker,
// and the worker's output is copied to ours line by line (worker-supervisor.mjs prefixLines). On
// 2026-10-13 about 81 % of the journal (22,000 of 27,500 lines an hour) was that chatter: NAT
// addresses, connection attempts, thread names. The journal is capped at 300 MB, so it held only 30
// hours, and the night's fault was gone by the time anyone looked.
//
// Only what is positively recognised as the SDK's is dropped: a line this does not know is written,
// as before. What was dropped is not invisible: once a minute one line says how many, by kind. The
// lines people and the code rely on stay: "Net Disconnected" always (the link-drop watcher reads it
// from every line anyway, whatever is written), and "StartLive false" and
// NET_SDK_NETWORK_RECV_TIMEOUT once in 10 s each, with how many more there were.
// CCTV_LOG_SDK=all writes everything again, for debugging (read at each line, not at import).
// Pure: no SDK, no timers. Tested in test/log-filter.test.mjs.

export const SUMMARY_MS = 60_000
export const REPEAT_MS = 10_000

// always written, each one: the NVR dropped a link (worker-supervisor.mjs LINK_RESET_RE is the same words)
const ALWAYS_RE = /Net Disconnected/
// written, but one in REPEAT_MS of each kind: a stream the NVR would not start, a call it did not answer
const REPEATS = [
  { id: 'startlive', re: /StartLive false/ },
  { id: 'timeout', re: /NET_SDK_NETWORK_RECV_TIMEOUT/ }
]

// the SDK starts some lines with its own clock: "2026-10-13 14:07:08  ../../DVR_NET_SDK/..."
const STAMP_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+/
// a source file of the SDK's at the start ("../../DVR_NET_SDK/source/nat/NatCommon.cpp(241): INFO:",
// "../NatComm/NatPeerBase.cpp, ...") or its tree anywhere in the line
const SOURCE_RE = /^(?:\.\.\/)+[\w./-]+\.(?:cpp|h)\b|DVR_NET_SDK\/source\//
// lines it prints without a file: a C++ method ("CNatUdt::Start: remote ip:..."), its thread names,
// and each connection attempt
const METHOD_RE = /^C[A-Z]\w+::\w+/
const THREAD_RE = /^THREADDDD=/
const CONNECT_RE = /^StartTryToConnect \|/

const NAT_RE = /\/nat\/|Nat[A-Z]\w*\.cpp|NatComm|^CNat|\bNAT_|UseNAT|^THREADDDD=/
const NETWORK_RE = /\/netservice\/|SWL_\w+\.cpp|^StartTryToConnect|getaddrinfo|Connection reset|Net Disconnected/

/**
 * What kind of SDK print a line is: 'blank', 'nat', 'network' or 'other'; null for a line that is
 * not recognised as the SDK's (everything the app prints: "[tag] ...", "stream nvr1/3:sub started").
 * @param {string} line a worker's line, without the "[worker <id>] " prefix
 */
export function sdkKind(line) {
  const s = String(line ?? '').trim()
  if (s === '') return 'blank'
  if (s.startsWith('[')) return null // the app's own lines start with their tag
  const body = s.replace(STAMP_RE, '')
  if (!SOURCE_RE.test(body) && !METHOD_RE.test(body) && !THREAD_RE.test(body) && !CONNECT_RE.test(body)) return null
  if (NAT_RE.test(body)) return 'nat'
  if (NETWORK_RE.test(body)) return 'network'
  return 'other'
}

/** The kind of line that is written once in REPEAT_MS ('startlive', 'timeout'), or null. */
export const repeatKind = (line) => REPEATS.find((r) => r.re.test(String(line ?? '')))?.id ?? null

/**
 * A line that is left out of the journal: the SDK's own print or a blank line, and not one of the
 * lines that carry a signal (above). Anything not recognised is not chatter.
 */
export function isSdkChatter(line) {
  const s = String(line ?? '')
  if (ALWAYS_RE.test(s) || repeatKind(s)) return false
  return sdkKind(s) !== null
}

const KIND_WORDS = { nat: 'NAT', network: 'network', blank: 'blank', other: 'other' }

/** How many lines were dropped, by kind, since it was last taken. */
export function makeDropCounter() {
  let counts = {}
  return {
    add(kind) {
      counts[kind] = (counts[kind] ?? 0) + 1
    },
    total: () => Object.values(counts).reduce((a, b) => a + b, 0),
    /** "412 SDK lines not logged in the last minute (NAT 301, network 96, other 15)", or null for none; starts again from nothing. */
    take() {
      const total = this.total()
      if (!total) return null
      const parts = Object.keys(KIND_WORDS).filter((k) => counts[k]).map((k) => `${KIND_WORDS[k]} ${counts[k]}`)
      counts = {}
      return `${total} SDK line${total === 1 ? '' : 's'} not logged in the last minute (${parts.join(', ')})`
    }
  }
}

/**
 * One worker's filter: lines(line) answers what to write for it, which is the line itself, nothing,
 * or the line with the minute's summary before it. The summary is written when the next line comes
 * after the minute is over (the SDK is never quiet for long), and by end() when the worker's output
 * ends. One filter for a worker's stdout and stderr together.
 * @param {{ now?: () => number, env?: object }} [o]
 */
export function makeSdkLogFilter({ now = Date.now, env = process.env } = {}) {
  const dropped = makeDropCounter()
  let since = now()
  const repeats = new Map() // kind -> { at, left }: when one was last written, and those left out since
  const summary = (t) => {
    if (t - since < SUMMARY_MS) return []
    since = t
    const line = dropped.take()
    return line ? [line] : []
  }
  return {
    lines(line) {
      if (env.CCTV_LOG_SDK === 'all') return [line]
      const t = now()
      const out = summary(t)
      const s = String(line ?? '')
      if (ALWAYS_RE.test(s)) return [...out, line]
      const rep = repeatKind(s)
      if (rep) {
        const r = repeats.get(rep)
        if (r && t - r.at < REPEAT_MS) {
          r.left++
          return out
        }
        repeats.set(rep, { at: t, left: 0 })
        return [...out, r?.left ? `${line}  (and ${r.left} more like it not logged since the last)` : line]
      }
      const kind = sdkKind(s)
      if (kind === null) return [...out, line]
      dropped.add(kind)
      return out
    },
    /** The worker's output has ended: what is still owed (the part-minute's summary). */
    end() {
      const line = dropped.take()
      return line ? [line] : []
    }
  }
}
