// Settings > Server > Reboot the machine. The app never gets root: it leaves a request file in its
// own data folder, and a root unit on the machine (deploy/argus-reboot.path -> argus-reboot.service
// -> /usr/local/sbin/argus-reboot) reboots when one appears. That side never reads what is in the
// file, only how old it is, deletes it before acting, and ignores it within 5 minutes of a boot.
// This side says why it will not, rather than let the page wait for a reboot that never comes.
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'

export const MIN_UPTIME_S = 300 // the root side ignores requests before this (loop guard)
export const ROOT_SIDE = '/etc/systemd/system/argus-reboot.path'

/** Whether the machine side is installed (the button is only offered where it is). */
export const machineRebootAvailable = (exists = existsSync) => exists(ROOT_SIDE)

/**
 * Asks for a reboot. @returns {{ status: number, body: object }}
 * @param {{ dataDir: string, upSeconds?: number, exists?: Function, write?: Function, rename?: Function }} o
 */
export function requestReboot({ dataDir, upSeconds = uptime(), exists = existsSync, write = writeFileSync, rename = renameSync }) {
  if (!machineRebootAvailable(exists)) return { status: 501, body: { error: 'Rebooting the machine is not set up on this server' } }
  if (upSeconds < MIN_UPTIME_S) {
    const wait = Math.ceil(MIN_UPTIME_S - upSeconds)
    return { status: 409, body: { error: `The machine started ${Math.floor(upSeconds)} s ago. Try again in ${wait} s.` } }
  }
  // written whole, then renamed into place: the root side never sees a half-written file
  const tmp = join(dataDir, 'reboot-request.tmp')
  write(tmp, '')
  rename(tmp, join(dataDir, 'reboot-request'))
  return { status: 200, body: { rebooting: true } }
}
