// Nightly copies of the settings that would take a long time to type again: the settings file,
// the accounts, the NVR list and the saved user preferences. Written to every configured target
// (the recording drive, and a folder on the Windows side), each in its own dated folder.
//
// Deliberately NOT copied: recordings.db (large, and rebuilt from the files on disk by
// rec-recover.mjs) and session-secret (a secret whose only effect is signing people out).
//
// A target that cannot be written is reported, never thrown: one bad target must not stop the
// others, and a backup failure must never take the server down.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = ['settings.json', 'users.json', 'nvrs.json', 'user-prefs.json', 'maps.json']
const RESULT = 'last-backup.json'

// Colons and dots are illegal in Windows folder names, so the ISO stamp is flattened to dashes.
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)

/**
 * @param {{dataDir:string,targets:string[],now?:()=>number,keep?:number}} o
 * @returns {Promise<{at:number,files:string[],written:string[],errors:string[]}>}
 */
export async function runBackup({ dataDir, targets, now = Date.now, keep = 7 }) {
  const at = now()
  const name = stamp(at)
  const files = FILES.filter((f) => existsSync(join(dataDir, f)))
  const written = []
  const errors = []

  for (const target of targets ?? []) {
    try {
      const dir = join(target, name)
      mkdirSync(dir, { recursive: true })
      for (const f of files) copyFileSync(join(dataDir, f), join(dir, f))
      prune(target, keep)
      written.push(dir)
    } catch (e) {
      errors.push(`${target}: ${e.message}`)
    }
  }

  const result = { at, files, written, errors }
  // Written last so the Health page always shows the outcome of the most recent attempt, and
  // never fatal: losing the record of a backup is not worth failing the backup over.
  try { writeFileSync(join(dataDir, RESULT), JSON.stringify(result), { mode: 0o600 }) } catch { /* not fatal */ }
  return result
}

/** The newest backup result, or null. */
export function lastBackup(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, RESULT), 'utf8')) } catch { return null }
}

/** Keeps the newest `keep` dated folders in a target. */
function prune(target, keep) {
  // The stamp sorts lexicographically in date order, so a plain sort puts the oldest first.
  // Anything the user dropped in the target that is not one of our folders is left alone.
  const dirs = readdirSync(target, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
    .map((d) => d.name)
    .sort()
  for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) rmSync(join(target, old), { recursive: true, force: true })
}
