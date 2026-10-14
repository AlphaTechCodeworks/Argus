import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'argus-event-worker-'))
process.env.DATA_DIR = dir
const { addEvent, listEventsAsync, closeEvents } = await import('../events-db.mjs')
try {
  for (let i = 0; i < 600; i++) addEvent({ nvr: 'n1', ch: i % 2, type: 'motion', startMs: 1000 + Math.floor(i / 4), subtype: String(i) })
  const rows = await listEventsAsync({ limit: 300, keep: row => row.ch === 1 })
  assert.equal(rows.length, 300, 'permission filtering fills the result across worker pages')
  assert.ok(rows.every(row => row.ch === 1))
  assert.equal(new Set(rows.map(row => row.id)).size, 300, 'equal timestamps do not duplicate or skip rows')
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].startMs <= rows[i-1].startMs)
  const limited = await listEventsAsync({ keep: () => false, maxScan: 260 })
  assert.equal(limited.scanLimited, true)
  const [a,b] = await Promise.all([listEventsAsync({ limit: 1 }), listEventsAsync({ limit: 2 })])
  assert.equal(a.length, 1); assert.equal(b.length, 2)
  console.log('PASS worker paging, permission filter, equal timestamp cursor, concurrent requests and scan ceiling')
} finally { closeEvents(); await new Promise(resolve => setTimeout(resolve, 100)); rmSync(dir, { recursive: true, force: true }) }
