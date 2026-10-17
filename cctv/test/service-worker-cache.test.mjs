import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
function setup({ unavailable = false, quota = false, opaque = false } = {}) {
  const handlers = {}, writes = [], work = []
  const response = { ok:true, redirected:false, type:opaque ? 'opaque' : 'basic', clone() { return this } }
  const cache = { match:async()=>null, keys:async()=>[], put:async request => {
    if (quota) throw new Error('quota'); writes.push(request.url)
  } }
  const context = { URL, AbortSignal, setTimeout, clearTimeout,
    location:{origin:'https://cctv.test'}, navigator:{storage:{estimate:async()=>({usage:1,quota:100})}},
    caches:{open:async()=>{ if (unavailable) throw new Error('storage disabled'); return cache }},
    fetch:async()=>response, self:{addEventListener:(name,fn)=>{handlers[name]=fn}} }
  runInNewContext(source, context)
  const request = async url => {
    let result
    handlers.fetch({ request:{ url, method:'GET', mode:'cors' },
      respondWith(p) { result=p }, waitUntil(p) { work.push(p) } })
    return await result
  }
  return {request,response,writes,work}
}
for (const options of [{unavailable:true},{quota:true},{}]) {
  const env = setup(options)
  assert.equal(await env.request('https://cctv.test/player.js?v=build'),env.response)
  assert.equal(await env.request('https://cctv.test/style.css'),env.response)
}
const opaque = setup({opaque:true})
assert.equal(await opaque.request('https://tile.openstreetmap.org/1/2/3.png'),opaque.response)
assert.equal(opaque.writes.length,0,'opaque imagery cannot consume unknown cache quota')
const tile = setup()
await tile.request('https://tile.openstreetmap.org/1/2/3.png')
await Promise.all(tile.work)
assert.equal(tile.work.length,1,'cache maintenance belongs to FetchEvent lifetime')
assert.equal(tile.writes.length,1)
console.log('PASS asset cache failure isolation, opaque quota policy and protected tile maintenance')
