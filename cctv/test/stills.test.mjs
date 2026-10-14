import assert from 'node:assert/strict'
let writes = 0, purged = []
globalThis.caches = { keys: async () => ['argus-stills','argus-stills:old','argus-app-v4'], delete: async key => purged.push(key), open: async () => { writes++; throw new Error('Images must not persist') } }
let finish
let saved = 0
let clock = 1000000
Date.now = () => clock
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: cb => { saved++; finish = cb } }) }
const { showStill, maybeKeepStill, purgeCameraStills, disposeStill } = await import('../public/stills.js')
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(purged, ['argus-stills','argus-stills:old'])
const tile = () => ({ isConnected:true, dataset:{}, style:{}, classList:{ add() {}, remove() {} } })
const source = { width:640, height:360 }
maybeKeepStill(source,'n1',1,clock)
maybeKeepStill(source,'n1',2,clock+2000)
assert.equal(saved,1,'one JPEG encoding at a time')
finish(new Blob([new Uint8Array(100)]))
const visible = tile()
await showStill(visible,'n1',1)
assert.ok(visible.dataset.stillUrl)
disposeStill(visible)
assert.equal(visible.dataset.stillUrl,undefined)
clock += 2000
maybeKeepStill(source,'n1',2,clock)
await purgeCameraStills()
finish(new Blob([new Uint8Array(100)]))
const stale = tile()
await showStill(stale,'n1',2)
assert.equal(stale.dataset.stillUrl,undefined,'in-flight JPEG cannot revive previews after purge')
for (let i=0;i<70;i++) { clock+=2000; maybeKeepStill(source,'n1',i,clock); finish(new Blob([new Uint8Array(20000)])) }
const evicted = tile(); await showStill(evicted,'n1',0)
assert.equal(evicted.dataset.stillUrl,undefined,'byte or entry ceiling evicts old previews')
const recent = tile(); await showStill(recent,'n1',69)
assert.ok(recent.dataset.stillUrl); disposeStill(recent)
clock+=900001
const expired = tile(); await showStill(expired,'n1',69)
assert.equal(expired.dataset.stillUrl,undefined)
assert.equal(writes,0)
await purgeCameraStills()
console.log('PASS session-only preview privacy, bounded encoding/storage, purge generation, expiry and URL disposal')
