// Lanes: small priority queues that limit how many SDK operations run at once.
//
// The TVT SDK serialises work internally and copes badly with bursts: 14
// simultaneous StopLivePlay calls took 3.7 s, 23 of them hung for 254 s and
// blocked every NVR. So each NVR gets its own lane (a couple of operations at a
// time, stops before starts, housekeeping last), and everything that opens a
// new connection to an NVR (logins, main-stream LivePlay) goes through one
// process-wide lane.
//
// A call that times out frees its lane slot, but the native call may still be
// stuck inside the SDK. So while an NVR has that many overdue calls, its lane
// holds back new work (stops excepted) until they really return, instead of
// piling more calls into a stuck SDK. The process-wide lane does the same for
// overdue calls of ANY NVR: the SDK makes other NVRs' calls queue behind them.
import { lateCalls, onCallSettled } from './sdk.mjs'

export const PRIORITY = { HIGH: 0, NORMAL: 1, LOW: 2 }

const lanes = new Set()
onCallSettled(() => {
  for (const lane of lanes) lane.kick()
})

export class Lane {
  /**
   * @param {string} name for NVR lanes, the NVR id (used to find its overdue calls)
   * @param {number} concurrency
   * @param {{ anyNvr?: boolean }} [opts] anyNvr: hold back for overdue calls of every NVR, not just this lane's
   */
  constructor(name, concurrency, { anyNvr = false } = {}) {
    this.name = name
    this.concurrency = concurrency
    this.anyNvr = anyNvr
    this.running = 0
    this.queue = [] // { task, priority, seq, resolve, reject, queuedAt }
    this.seq = 0
    this.closed = false
    lanes.add(this)
  }

  /**
   * Runs task() when a slot is free. Higher priority (lower number) goes first, FIFO within a priority.
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ priority?: number }} [opts]
   * @returns {Promise<T>}
   */
  /**
   * @param {{ priority?: number, urgent?: () => boolean }} opts urgent: asked again each time a job
   *   is picked -- true moves the job ahead of the others of its priority (a stream someone is
   *   waiting to watch, ahead of the recorder's after a restart), even if it was queued first as
   *   background work and a viewer arrived later
   */
  run(task, { priority = PRIORITY.NORMAL, urgent = null } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, priority, urgent, seq: this.seq++, resolve, reject, queuedAt: Date.now() })
      this.#order()
      this.kick()
    })
  }

  #order() {
    const u = (j) => (j.urgent?.() ? 0 : 1)
    this.queue.sort((a, b) => a.priority - b.priority || u(a) - u(b) || a.seq - b.seq)
  }

  /** Starts queued jobs while slots are free (called on new jobs, finished jobs and settled native calls). */
  kick() {
    // a viewer may have arrived for a queued background start since it was queued
    if (this.queue.length > 1 && this.queue.some((j) => j.urgent)) this.#order()
    while (this.running < this.concurrency && this.queue.length) {
      // with overdue calls stuck in the SDK for this NVR (any NVR: anyNvr), only stops may go ahead;
      // a native call returning kicks every lane (onCallSettled above), which ends the hold
      if (this.queue[0].priority !== PRIORITY.HIGH && lateCalls(this.anyNvr ? undefined : this.name) >= this.concurrency) return
      const job = this.queue.shift()
      this.running++
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--
          this.kick()
        })
    }
  }

  /** Drops queued (not yet started) jobs except stops, e.g. when an NVR is removed. */
  clear(reason = 'cancelled') {
    const keep = []
    for (const job of this.queue.splice(0)) {
      if (job.priority === PRIORITY.HIGH) keep.push(job)
      else job.reject(new Error(reason))
    }
    this.queue.push(...keep)
    this.kick()
  }

  /** Stops tracking this lane (its NVR was removed); queued stops still run. */
  close() {
    this.clear('NVR removed')
    lanes.delete(this)
  }

  get pending() {
    return this.queue.length
  }

  get oldestWaitMs() {
    return this.queue.length ? Date.now() - Math.min(...this.queue.map((j) => j.queuedAt)) : 0
  }
}

/**
 * Logins, logouts, login tests and main-stream LivePlay (each opens an NVR connection): one at a
 * time, process-wide. Nothing new starts here while any NVR has a call stuck in the SDK.
 */
export const connectLane = new Lane('connect', 1, { anyNvr: true })
