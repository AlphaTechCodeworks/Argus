import { parentPort, workerData } from 'node:worker_threads'
import { listEvents, useEventsDb } from './events-db.mjs'
useEventsDb(workerData.file)
parentPort.on('message', ({ id, options }) => {
  try { parentPort.postMessage({ id, rows: listEvents(options) }) }
  catch (error) { parentPort.postMessage({ id, error: error.message }) }
})
