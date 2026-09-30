// Automatic bookmarks: the ones no person made (one around every line crossing, line-actions.mjs autoBookmark),
// how one is told from a person's, and forgetting them once they ended more than their camera's days kept, so
// their footage goes with the rest. A person's bookmark is a decision about what matters and is never forgotten
// by itself; an automatic one is a guess that it might, worth keeping as long as the camera's footage is.
//
// No SDK and no settings file here (line-actions.mjs hands in both), so these rules run on any PC:
//   node cctv/test/auto-bookmarks.test.mjs
//
// Data-safety review of 19321dd (2026-09-30), two changes from what line-actions.mjs did before:
// - Which are automatic. A person who edits an automatic bookmark takes it over (bookmarks.mjs updateBookmark),
//   but only since this rule: on the master deployed until then, an edit left "system" on it. So "system" alone
//   does not make a bookmark automatic; its description must also be one of the automatic texts, as every
//   automatic bookmark's has been since the first (2026-09-27). One an admin annotated on the master is a
//   person's: kept, never stretched by a later crossing. (A master-era edit of the title or the times alone
//   leaves no trace in the row; the pre-deploy count lists titles unlike their camera's others.)
// - How many are read. The forget step read every automatic bookmark older than the shortest days kept of any
//   camera, row by row in JavaScript, every 5 minutes on the main thread: 157-199 ms with 20,000 of them when
//   one other camera keeps 1-7 days. Now SQLite picks "system" rows that ended before that time
//   (bookmarks.mjs listEndedBefore) and a round reads at most FORGET_READ of them, going on from where the last
//   round stopped: a pass over 20,000 takes 10 rounds (50 minutes), and one that becomes due behind the cursor
//   is forgotten in the next pass. Late is the safe side: an automatic bookmark kept a little longer keeps its
//   minutes a little longer.
import { AUTO_USER } from './public/bookmarks-view.js'

export { AUTO_USER }
/** What an automatic bookmark's title starts with: "Line crossing — <camera>" (line-actions.mjs LINE_RULE_NAME). */
export const AUTO_TITLE_PREFIX = 'Line crossing'
/** What a new automatic bookmark says of itself (the playback page shows it): how long it lasts, and how to keep it. */
export const AUTO_DESCRIPTION = 'Kept automatically around line crossings on this camera; later crossings stretch it. It is forgotten after the camera\'s days kept, with the footage; edit it to keep it (it is then yours).'
/** What every automatic bookmark said from the first (2026-09-27) until this rule deploys (master f62d183 and before). */
export const OLD_AUTO_DESCRIPTION = 'Kept automatically around line crossings on this camera; later crossings stretch it.'
/** The texts an automatic bookmark carries; a "system" bookmark with any other description was changed by a person. */
export const AUTO_DESCRIPTIONS = Object.freeze([AUTO_DESCRIPTION, OLD_AUTO_DESCRIPTION])

/**
 * One no person made or changed: filed under "system", of one camera (`key`, when given), titled as a line
 * crossing, and still carrying an automatic text as its description. Anything else is a person's.
 * @param {object} b    a bookmark (bookmarks.mjs)
 * @param {string|null} [key]  "<nvr>/<ch>": the camera it must be of
 */
export function isAutoBookmark(b, key = null) {
  if (!b || b.user !== AUTO_USER || b.damaged) return false
  if (!Array.isArray(b.cameras) || b.cameras.length !== 1) return false
  if (key !== null && b.cameras[0] !== key) return false
  return String(b.title ?? '').startsWith(AUTO_TITLE_PREFIX) && AUTO_DESCRIPTIONS.includes(b.description)
}

const DAY = 86_400_000
/** Automatic bookmarks forgotten a round at most (one transaction): the next round goes on. */
export const FORGET_BATCH = 500
/**
 * "system" bookmarks read a round at most, due or not: about 8 us each on the main thread (SQLite's row and the
 * cameras' JSON), so about 16 ms a round at most, whatever the cameras keep.
 */
export const FORGET_READ = 2000
/** Where the next round goes on from: the { endMs, id } of the last one read, or null for the oldest. */
const forgetCursor = { after: null }

/**
 * Forgets the automatic bookmarks that ended more than their camera's retentionDays ago (settings.recording:
 * the camera's own, else the default); a person's, and one a person changed, stays. Every 5 minutes before
 * housekeeping (server.mjs, through line-actions.mjs forgetLineBookmarks). Reads at most `read` "system"
 * bookmarks and forgets at most `limit`; the cursor carries the place to the next round and goes back to the
 * oldest when a page comes back short. Its work is done before its first await when `store` is the store itself.
 *
 * @param {{ store: object | (() => Promise<object|null>) | null, settings: object, now?: number, log?: Function,
 *   limit?: number, read?: number, cursor?: { after?: { endMs: number, id: number } | null } }} o
 *   store: bookmarks.mjs (or a stand-in with listEndedBefore and removeBookmarks), or a loader of it
 * @returns {Promise<{ forgotten: number, newestEndMs: number|null, read: number }>}
 */
export async function forgetAutoBookmarks({ store = null, settings = null, now = Date.now(), log = console.log, limit = FORGET_BATCH, read = FORGET_READ, cursor = forgetCursor } = {}) {
  const none = { forgotten: 0, newestEndMs: null, read: 0 }
  const rec = settings?.recording ?? {}
  const daysOf = (key) => Number({ ...(rec.defaults ?? {}), ...(rec.cameras?.[key] ?? {}) }.retentionDays)
  const all = [rec.defaults?.retentionDays, ...Object.values(rec.cameras ?? {}).map((c) => c?.retentionDays)].map(Number).filter((d) => Number.isFinite(d) && d > 0)
  if (!all.length) return none // (no days kept set anywhere: nothing to forget by)
  const s = typeof store === 'function' ? await store() : store
  if (!s || typeof s.listEndedBefore !== 'function' || typeof s.removeBookmarks !== 'function') return none
  // only bookmarks that ended before the shortest days kept can have ended before their camera's
  const before = now - Math.min(...all) * DAY
  const due = (b) => {
    if (!isAutoBookmark(b)) return false
    const days = daysOf(b.cameras[0])
    return Number.isFinite(days) && days > 0 && b.endMs < now - days * DAY
  }
  const want = Math.max(1, Math.floor(Number(read)) || FORGET_READ)
  const most = Math.max(1, Math.floor(Number(limit)) || FORGET_BATCH)
  const page = s.listEndedBefore(AUTO_USER, before, { after: cursor.after ?? null, limit: want })
  const gone = []
  let seen = 0
  for (const b of page) {
    seen++
    if (due(b) && gone.push(b) >= most) break
  }
  // a short page read to its end: that was the newest, and the next round starts again from the oldest
  cursor.after = seen === 0 || (seen === page.length && page.length < want) ? null : { endMs: page[seen - 1].endMs, id: page[seen - 1].id }
  if (!gone.length) return { ...none, read: seen }
  const forgotten = s.removeBookmarks(gone.map((b) => b.id))
  const newestEndMs = Math.max(...gone.map((b) => b.endMs))
  log(`[lines] forgot ${forgotten} automatic line-crossing bookmark${forgotten === 1 ? '' : 's'} that ended more than their camera's days kept ago (the newest ended ${new Date(newestEndMs).toISOString().slice(0, 16).replace('T', ' ')} UTC): their footage goes with the rest`)
  return { forgotten, newestEndMs, read: seen }
}
