// What ended the process, when it was a JavaScript error: written to DATA_DIR/last-crash.json
// (last-crash-<nvr>.json for a live worker), next to the watchdog's last-hang.json.
// On 2026-10-07 the service restarted by itself at 06:10. The watchdog had not fired, so there was
// no last-hang.json, and the journal reached back only two and a half hours: nothing said why.
// A monitor, not a handler: it only watches. The error still prints its stack and still ends the
// process exactly as it did before, and systemd (or the supervisor) still starts a new one.
// A crash inside the native SDK (a segfault, an abort) never reaches JavaScript and leaves no
// record here: for those the journal's "Main process exited" line is the only trace.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// as the watchdog names its files (watchdog.mjs): a worker's are its own
const WORKER = String(process.env.CCTV_WORKER_NVR ?? '').replace(/[^A-Za-z0-9_-]/g, '')

/**
 * From now on, an uncaught error or an unhandled rejection is written down before the process ends.
 * @param {{ dataDir: string }} o
 */
export function recordCrashes({ dataDir }) {
  const file = join(dataDir, `last-crash${WORKER ? `-${WORKER}` : ''}.json`)
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    try {
      const isError = err instanceof Error
      const record = {
        at: new Date().toISOString(),
        origin, // 'uncaughtException' | 'unhandledRejection'
        name: isError ? err.name : typeof err,
        message: isError ? err.message : String(err),
        stack: isError ? (err.stack ?? null) : null,
        uptimeS: Math.round(process.uptime()),
        pid: process.pid,
        worker: WORKER || null
      }
      // synchronous: the process is about to end, and nothing asynchronous would finish
      writeFileSync(file, JSON.stringify(record, null, 2))
    } catch {} // (a record that cannot be written must not change how the process ends)
  })
}
