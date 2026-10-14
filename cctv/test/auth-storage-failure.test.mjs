import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = mkdtempSync(join(tmpdir(),'argus-auth-failure-'))
const script = `import assert from 'node:assert/strict'; import {saveUsers,createSession,verifySession} from './cctv/auth.mjs'; saveUsers({alice:{hash:'x',role:'viewer'}}); assert.equal(verifySession(createSession('alice')),null);`
try {
  for (const invalid of ['broken','[]','{"bad":"not a number"}']) {
    writeFileSync(join(dir,'revoked-sessions.json'),invalid)
    const result = spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'})
    assert.equal(result.status,0,result.stderr)
  }
  console.log('PASS corrupt revocation storage fails closed across process startup')
} finally { rmSync(dir,{recursive:true,force:true}) }
