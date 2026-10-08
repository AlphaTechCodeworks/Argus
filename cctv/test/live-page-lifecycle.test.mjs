import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('history restoration discards frozen players and restores fresh streams', () => {
  const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const start = source.indexOf('let pageSuspended = false')
  const end = source.indexOf("document.addEventListener('visibilitychange'", start)
  const handlers = {}, events = []
  const context = vm.createContext({
    hiddenTimer: 7,
    tiles: [{ close: () => events.push('close') }],
    location: { reload: () => events.push('reload') },
    addEventListener: (name, handler) => { handlers[name] = handler },
    clearTimeout: () => events.push('clear'),
    freshenForPageChange: () => events.push('fresh'),
    render: () => events.push('render'),
    checkSession: () => events.push('session'),
    sync: { refresh: () => events.push('settings') },
    listSoon: () => events.push('list')
  })
  vm.runInContext(source.slice(start, end), context)
  handlers.pageshow({ persisted: false })
  assert.deepEqual(events, [])
  handlers.pagehide()
  assert.equal(context.tiles.length, 0)
  assert.deepEqual(events, ['clear', 'close'])
  handlers.pageshow({ persisted: true })
  assert.deepEqual(events.slice(2), ['reload'])
  events.length = 0
  handlers.pageshow({ persisted: false })
  assert.deepEqual(events, ['clear', 'fresh', 'render', 'session', 'settings', 'list'])
  events.length = 0
  handlers.pageshow({ persisted: false })
  assert.deepEqual(events, [])
})
