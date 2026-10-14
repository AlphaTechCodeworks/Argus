import assert from 'node:assert/strict'
let resolvePreferences
const startup = new Promise(resolve => { resolvePreferences = resolve })
const writes = []
globalThis.fetch = async (url, options) => {
  if (options?.method === 'PATCH') {
    writes.push(JSON.parse(options.body))
    assert.ok(options.signal, 'saving has a deadline')
    return {ok:true,status:200}
  }
  return startup
}
globalThis.document = { hidden:false, dispatchEvent() {}, addEventListener() {} }
globalThis.CustomEvent = class { constructor(type,options) { Object.assign(this,{type,...options}) } }
globalThis.localStorage = {getItem:()=>null,setItem() {}}
const importResult = import('../public/user-settings.js?startup-test')
const module = await Promise.race([importResult,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Import blocked by preferences network request')),1000))])
module.preferenceStorage.setItem('cctv.layout.phone','g3')
resolvePreferences({ok:true,json:async()=>({user:'alice',preferences:{'cctv.layout.phone':'g1'}})})
await module.preferencesReady
assert.equal(module.preferenceStorage.getItem('cctv.layout.phone'),'g3','user selection during loading wins over stored preferences')
await module.savePendingSettings()
assert.equal(writes[0].account,'alice')
assert.equal(writes[0].preferences['cctv.layout.phone'],'g3')
console.log('PASS nonblocking preferences import, pending-setting hydration and account-bound deadline save')
