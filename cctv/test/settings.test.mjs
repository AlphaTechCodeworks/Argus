// Offline tests for the recording settings store and its admin routes (settings.mjs,
// settings-api.mjs). Temp data folder only; nothing is sent anywhere.
//   node cctv/test/settings.test.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'cctv-settings-test-'))
const DATA = process.env.DATA_DIR
writeFileSync(join(DATA, 'users.json'), JSON.stringify({ boss: { hash: 'x', role: 'admin' }, viewer: { hash: 'x', role: 'viewer' } }))
const { getSettings, saveSettings, cameraRecording, DEFAULTS, SETTINGS_FILE } = await import('../settings.mjs')
const { handleSettings } = await import('../settings-api.mjs')

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}
const refused = (patch, pattern) => {
  try {
    saveSettings(patch, 'boss')
    return false
  } catch (e) {
    return e.status === 400 && (!pattern || pattern.test(e.message))
  }
}

// ---- defaults ------------------------------------------------------------------------------
check('no file yet', !existsSync(SETTINGS_FILE))
const d = getSettings()
check(
  'defaults when the file is missing',
  d.recording.defaults.mode === 'off' && d.recording.defaults.fullDays === 30 && d.recording.defaults.after === 'timelapse' &&
    d.recording.defaults.timelapseS === 10 && d.recording.defaults.retentionDays === 183 && d.recording.defaults.preS === 10 &&
    d.recording.defaults.postS === 20 && d.memory.recentMinutes === 2 && d.thumbnails === 'off' &&
    d.storage.lowFreePct === 15 && d.storage.floorFreePct === 5 && Array.isArray(d.storage.locations) && d.storage.locations.length === 0 &&
    JSON.stringify(d.recording.cameras) === '{}',
  JSON.stringify(d)
)
check('DEFAULTS exported and equal to the defaults', JSON.stringify(DEFAULTS) === JSON.stringify(d))
check('getSettings returns a copy', (() => { getSettings().recording.defaults.mode = 'continuous'; return getSettings().recording.defaults.mode === 'off' })())
const cr0 = cameraRecording('nvr1', 3)
check('camera without an override: recording off, default values', cr0.mode === 'off' && cr0.fullDays === 30 && cr0.after === 'timelapse' && cr0.timelapseS === 10 && cr0.retentionDays === 183 && cr0.locationId === null, JSON.stringify(cr0))
check('cameraRecording has exactly the documented fields', Object.keys(cr0).sort().join() === 'after,fullDays,locationId,mode,retentionDays,timelapseS')

// ---- validation ----------------------------------------------------------------------------
check('mode not in the list: refused', refused({ recording: { defaults: { mode: 'always' } } }, /mode/))
check('fullDays > retentionDays: refused', refused({ recording: { defaults: { fullDays: 200, retentionDays: 100 } } }, /full/i))
check('retentionDays > 366: refused', refused({ recording: { defaults: { retentionDays: 367 } } }, /retention/i))
check('timelapseS < 1: refused', refused({ recording: { defaults: { timelapseS: 0 } } }, /time-?lapse/i))
check('fractional days refused', refused({ recording: { defaults: { fullDays: 1.5 } } }))
check('string numbers refused', refused({ recording: { defaults: { fullDays: '30' } } }))
check('after not in the list: refused', refused({ recording: { defaults: { after: 'archive' } } }))
check('memory.recentMinutes not a choice: refused', refused({ memory: { recentMinutes: 3 } }))
check('thumbnails not a choice: refused', refused({ thumbnails: '10m' }))
check('floor >= low-space threshold: refused', refused({ storage: { lowFreePct: 10, floorFreePct: 10 } }))
check('unknown top-level key refused', refused({ recordng: {} }))
check('unknown recording field refused', refused({ recording: { defaults: { speed: 2 } } }))
check('bad camera key refused', refused({ recording: { cameras: { 'nvr1:3': { mode: 'continuous' } } } }))
check('camera override that breaks fullDays <= retentionDays refused', refused({ recording: { cameras: { 'nvr1/3': { fullDays: 200 } } } }))
check('storage.locations cannot be set through saveSettings', refused({ storage: { locations: [] } }))
check('nothing was written by refused saves', !existsSync(SETTINGS_FILE))

// ---- per-camera overrides ----------------------------------------------------------------------
const s1 = saveSettings({ recording: { defaults: { retentionDays: 90 }, cameras: { 'nvr1/3': { mode: 'continuous', fullDays: 14 } } } }, 'boss')
check('save returns the new settings', s1.recording.defaults.retentionDays === 90 && s1.recording.cameras['nvr1/3'].mode === 'continuous')
const cr1 = cameraRecording('nvr1', 3)
check('override merges over the defaults', cr1.mode === 'continuous' && cr1.fullDays === 14 && cr1.retentionDays === 90 && cr1.after === 'timelapse', JSON.stringify(cr1))
check('other cameras keep the defaults', cameraRecording('nvr1', 4).mode === 'off' && cameraRecording('nvr1', 4).retentionDays === 90)
check('the override stores only what differs', JSON.stringify(getSettings().recording.cameras['nvr1/3']) === JSON.stringify({ mode: 'continuous', fullDays: 14 }))
saveSettings({ recording: { cameras: { 'nvr1/3': { locationId: 'loc-a' } } } }, 'boss')
check('a partial camera patch keeps its other overrides', cameraRecording('nvr1', 3).mode === 'continuous' && cameraRecording('nvr1', 3).locationId === 'loc-a')
saveSettings({ recording: { cameras: { 'nvr1/3': { fullDays: null } } } }, 'boss')
check('null removes one override field', cameraRecording('nvr1', 3).fullDays === 30 && cameraRecording('nvr1', 3).mode === 'continuous')
check('lowering the default retention below a camera\'s full days is refused', (() => {
  saveSettings({ recording: { cameras: { 'nvr1/5': { fullDays: 60 } } } }, 'boss')
  return refused({ recording: { defaults: { retentionDays: 45 } } }, /nvr1\/5/)
})())
saveSettings({ recording: { cameras: { 'nvr1/5': null } } }, 'boss')
check('null removes a camera\'s overrides', !('nvr1/5' in getSettings().recording.cameras))

// ---- the file --------------------------------------------------------------------------------
const st = statSync(SETTINGS_FILE)
check('file mode 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8))
check('no temp files left behind', readdirSync(DATA).every((f) => !f.includes('.tmp')), readdirSync(DATA).join())
const ino = st.ino
saveSettings({ thumbnails: '5m' }, 'boss')
check('written by temp file + rename (a new inode each save)', statSync(SETTINGS_FILE).ino !== ino)
check('file holds valid JSON with the change', JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).thumbnails === '5m')
writeFileSync(SETTINGS_FILE, '{ broken')
check('an unreadable file falls back to the defaults', getSettings().thumbnails === 'off')
writeFileSync(SETTINGS_FILE, JSON.stringify({ thumbnails: '1m', recording: { defaults: { mode: 'bogus' } } }))
check('a file with bad values: the bad values fall back to defaults, good ones stay', getSettings().thumbnails === '1m' && getSettings().recording.defaults.mode === 'off')

// ---- the routes ----------------------------------------------------------------------------------
writeFileSync(SETTINGS_FILE, '{}')
const json = (o) => async () => o
const [g1, b1] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss')
check('GET as admin: 200 with the settings', g1 === 200 && b1.settings.recording.defaults.mode === 'off' && Array.isArray(b1.choices.modes), JSON.stringify(b1).slice(0, 200))
const [p1, pb1] = await handleSettings('POST', '/api/admin/settings', json({ recording: { cameras: { 'nvr-2/0': { mode: 'motion' } } }, memory: { recentMinutes: 5 } }), 'boss')
check('POST as admin: 200 with the saved settings', p1 === 200 && pb1.settings.recording.cameras['nvr-2/0'].mode === 'motion' && pb1.settings.memory.recentMinutes === 5)
const [g2, b2] = await handleSettings('GET', '/api/admin/settings', json({}), 'boss')
check('GET after POST: round trip', g2 === 200 && b2.settings.recording.cameras['nvr-2/0'].mode === 'motion' && b2.settings.memory.recentMinutes === 5)
const [p2, pb2] = await handleSettings('POST', '/api/admin/settings', json({ recording: { defaults: { mode: 'nope' } } }), 'boss')
check('POST with a bad value: 400 with a message', p2 === 400 && /mode/.test(pb2.error))
const [p3] = await handleSettings('POST', '/api/admin/settings', async () => { throw new SyntaxError('x') }, 'boss')
check('POST with bad JSON: 400', p3 === 400)
const [v1] = await handleSettings('GET', '/api/admin/settings', json({}), 'viewer')
const [v2] = await handleSettings('POST', '/api/admin/settings', json({ thumbnails: '1m' }), 'viewer')
check('non-admin: 403 for GET and POST', v1 === 403 && v2 === 403)
check('non-admin POST changed nothing', getSettings().thumbnails === 'off')
const [m1] = await handleSettings('DELETE', '/api/admin/settings', json({}), 'boss')
check('other methods: 405', m1 === 405)
check('other paths: not handled (null)', (await handleSettings('GET', '/api/admin/nvrs', json({}), 'boss')) === null)
const [p4, pb4] = await handleSettings('POST', '/api/admin/settings', json({ storage: { locations: [{ path: '/' }] } }), 'boss')
check('locations are not settable through /settings', p4 === 400, pb4.error)

// which stream the server records: per camera, per NVR, or the default (recorder.mjs #streamPref)
check("the default recorded stream is 'auto'", getSettings().recording.defaults.stream === 'auto')
saveSettings({ recording: { nvrs: { 'nvr-2': { stream: 'sub' } } } }, 'boss')
check("an NVR can be set to record its sub-streams", getSettings().recording.nvrs['nvr-2']?.stream === 'sub')
saveSettings({ recording: { cameras: { 'nvr-2/5': { stream: 'main' } } } }, 'boss')
check('a camera can be set to a stream of its own', getSettings().recording.cameras['nvr-2/5']?.stream === 'main')
check('a stream that does not exist is refused', refused({ recording: { nvrs: { 'nvr-2': { stream: 'hd' } } } }))
check('an unknown NVR field is refused', refused({ recording: { nvrs: { 'nvr-2': { bitrate: 3 } } } }))
check('a bad NVR id is refused', refused({ recording: { nvrs: { 'nvr 2/x': { stream: 'sub' } } } }))
saveSettings({ recording: { nvrs: { 'nvr-2': null } } }, 'boss')
check('null removes an NVR override', !('nvr-2' in getSettings().recording.nvrs))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
