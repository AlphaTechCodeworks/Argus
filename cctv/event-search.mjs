import { Worker } from 'node:worker_threads'
const readers = new Map()
let sequence = 0
export function closeEventReaders() {
  for (const state of readers.values()) { state.fail(new Error('Event reader closed')); void state.worker.terminate() }
  readers.clear()
}
export function readEventPage(file, options, timeoutMs = 8000) {
  let state = readers.get(file)
  if (!state) {
    const worker = new Worker(new URL('./event-search-worker.mjs', import.meta.url), { workerData: { file } })
    const requests = new Map()
    state = { worker, requests, fail(error) {
      if (readers.get(file) === state) readers.delete(file)
      for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error) }
      requests.clear(); worker.unref()
    } }
    worker.on('message', ({ id, rows, error }) => {
      const request = requests.get(id)
      if (!request) return
      requests.delete(id); clearTimeout(request.timer)
      if (error) request.reject(new Error(error)); else request.resolve(rows)
      if (!requests.size) worker.unref()
    })
    worker.on('error', state.fail)
    worker.on('exit', () => state.fail(new Error('Event reader exited')))
    worker.unref(); readers.set(file, state)
  }
  if (state.requests.size >= 32) return Promise.reject(new Error('Event search busy'))
  state.worker.ref()
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { state.fail(new Error('Event search timed out')); void state.worker.terminate() }, Math.max(1, timeoutMs))
    state.requests.set(id, { resolve, reject, timer })
    state.worker.postMessage({ id, options })
  })
}
