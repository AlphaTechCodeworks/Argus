// Viewers' live starts, paced per NVR inside the NVR's worker (live.mjs #start).
//
// /live-mux lets a page subscribe up to 200 tiles at once, then 20 a second (live-mux.mjs), so the
// ~250 ms handshake per tile that used to space LivePlay calls out is gone. An NVR handed dozens of
// LivePlays at once answers them slowly, and a slow live call freezes that NVR's recording in the
// same worker: at 03:51:54 two sub LivePlays went to a struggling nvr1 together, one came back after
// 78 s, the other never did, and the worker was killed with every recording on that NVR. So a
// viewer's (or a warm-up's) start waits here for its turn:
//   - at most 2 live calls of that NVR at a time; 1 while it is slow (its last LivePlay took over
//     3 s, or one of its calls came back late in the last 10 minutes);
//   - starts at least the last LivePlay's duration apart (never under 250 ms, never over 10 s);
//   - at most 40 starts a minute;
//   - none while one of its calls is still late, nor for 60 s after its links were reset (the SDK
//     printed "Net Disconnected": worker-supervisor.mjs -> MSG.LINKRESET -> live.mjs linkReset).
// The recorder's starts never wait here. A start that waits is only waiting: its stream stays
// 'starting' and the tile goes on waiting for its picture; nothing fails, and a tile that
// reconnects meanwhile keeps its place (the stream stays wanted through the linger).
//
// Pure apart from the clock, the timers and the three readings it is given (tests: fakes).
export const PACE = {
  FAST: 2, // live calls at a time on an NVR that answers quickly
  SLOW: 1, // ... and on one that does not
  SLOW_PLAY_MS: 3000, // a LivePlay slower than this: the NVR is slow
  LATE_WINDOW_MS: 10 * 60_000, // a call back late this recently: the NVR is slow
  MIN_GAP_MS: 250,
  MAX_GAP_MS: 10_000,
  PER_MINUTE: 40,
  // after the NVR dropped its links: the SDK's own reconnect took 20-25 s in the journals (02:25:03 ->
  // 02:25:26 on 2026-09-27); holding viewers a whole minute left tiles blank for nothing
  RESET_HOLD_MS: 25_000,
  RECHECK_MS: 1000 // waiting for a call to return: looked at again this often (a returning call also wakes it)
}

/**
 * One NVR's pacer.
 * @param {{ now?: () => number, liveInFlight?: () => number, lateNow?: () => number, lateAt?: () => number,
 *   setTimer?: (fn: Function, ms: number) => any, clearTimer?: (t: any) => void }} [deps]
 *   liveInFlight: this NVR's LivePlay/StopLivePlay calls inside the SDK now, anyone's (sdk.mjs
 *   liveCallsInFlight); lateNow: its calls inside the SDK past their limit (lateCalls); lateAt: when
 *   one last came back late, 0 never (lastLateReturnAt)
 */
export function livePacer({ now = Date.now, liveInFlight = () => 0, lateNow = () => 0, lateAt = () => 0, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const waiters = [] // { rank, cancelled, bypass, resolve, seq }
  const recent = [] // when each start of the last minute went
  let active = 0 // starts let through whose LivePlay is not over yet
  let lastStartAt = -Infinity
  let lastPlayMs = 0
  let resetAt = -Infinity
  let seq = 0
  let timer = null

  const slow = (t) => lastPlayMs > PACE.SLOW_PLAY_MS || lateNow() > 0 || (lateAt() > 0 && t - lateAt() < PACE.LATE_WINDOW_MS)
  const gapMs = () => Math.max(PACE.MIN_GAP_MS, Math.min(PACE.MAX_GAP_MS, lastPlayMs))

  /** 0: the next start may go now; a number of ms: not before then; Infinity: not before a call returns. */
  const blockedFor = (t) => {
    if (lateNow() > 0) return Infinity
    while (recent.length && t - recent[0] >= 60_000) recent.shift()
    const full = recent.length >= PACE.PER_MINUTE ? recent[0] + 60_000 - t : 0
    const ms = Math.max(0, resetAt + PACE.RESET_HOLD_MS - t, lastStartAt + gapMs() - t, full)
    if (ms > 0) return ms
    const limit = slow(t) ? PACE.SLOW : PACE.FAST
    // (our own starts count until their LivePlay is over, even while they still wait in the lane)
    return active >= limit || liveInFlight() >= limit ? Infinity : 0
  }

  const pump = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    // gone (the stream was stopped) or no longer paced (the recorder came for it): out of the queue at once
    for (let i = 0; i < waiters.length; ) {
      const w = waiters[i]
      if (w.cancelled() || w.bypass()) {
        waiters.splice(i, 1)
        w.resolve(() => {})
      } else i++
    }
    while (waiters.length) {
      const t = now()
      const ms = blockedFor(t)
      if (ms > 0) {
        timer = setTimer(pump, Number.isFinite(ms) ? ms : PACE.RECHECK_MS)
        timer?.unref?.()
        return
      }
      // a viewer's start before a warm-up's, first come first served within each
      waiters.sort((a, b) => a.rank() - b.rank() || a.seq - b.seq)
      const w = waiters.shift()
      active++
      lastStartAt = t
      recent.push(t)
      let over = false
      w.resolve(() => {
        if (over) return
        over = true
        active--
        pump()
      })
    }
  }

  return {
    /**
     * Resolves when this start may go, with the function to call once its LivePlay is over (it
     * never rejects). Not paced (bypass true, cancelled true): resolves at once.
     * @param {{ rank?: () => number, cancelled?: () => boolean, bypass?: () => boolean }} [o]
     */
    wait({ rank = () => 1, cancelled = () => false, bypass = () => false } = {}) {
      return new Promise((resolve) => {
        waiters.push({ rank, cancelled, bypass, resolve, seq: seq++ })
        pump()
      })
    },
    /** A LivePlay of this NVR took ms (the recorder's too): how quickly the NVR answers now. */
    played(ms) {
      if (Number.isFinite(ms) && ms >= 0) lastPlayMs = ms
      pump()
    },
    /** The NVR reset its links: no start for RESET_HOLD_MS. */
    linkReset(at = now()) {
      resetAt = at
      pump()
    },
    /** Something may let a start go: a native call returned (sdk.mjs onCallSettled). */
    kick: pump,
    get waiting() {
      return waiters.length
    },
    get active() {
      return active
    }
  }
}
