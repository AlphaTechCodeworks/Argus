// GET /api/osd for someone who is not an admin (camera-notes.mjs handleOsd): an overlay's text is a
// camera's name, so a viewer is told only about the cameras they may see. camera-notes.mjs imports
// nvrs.mjs, which loads the NVR SDK, so this runs where the SDK does (the server copy); it never
// contacts an NVR.
//   node cctv/test/osd-rights.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
}

const DATA = mkdtempSync(join(tmpdir(), 'cctv-osd-rights-'))
process.env.DATA_DIR = DATA // camera-notes.mjs reads it when first imported
writeFileSync(join(DATA, 'camera-notes.json'), JSON.stringify({ osd: { cameras: { 'nvr1/0': { text: 'Vault' }, 'nvr2/0': { text: 'Office' } } } }))

const { OSD_PATH, handleOsd } = await import('../camera-notes.mjs')
const read = async (ctx) => (await handleOsd('GET', OSD_PATH, async () => ({}), ctx))[1]

const viewer = await read({ admin: false, canSee: (nvr) => nvr === 'nvr1' })
check('a viewer gets only the cameras they may see', Object.keys(viewer.cameras).join() === 'nvr1/0', JSON.stringify(viewer.cameras))
check('...and the default the pages draw with', Boolean(viewer.default))
check('no rights check handed in is no cameras (default deny)', JSON.stringify((await read({ admin: false })).cameras) === '{}')
check('an admin gets every camera', Object.keys((await read({ admin: true })).cameras).sort().join() === 'nvr1/0,nvr2/0')

rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
