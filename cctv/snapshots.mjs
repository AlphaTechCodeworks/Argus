// Logs in, waits for the NVR to settle, then snapshots each channel to /app/snapshots.
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { Device } from '../build/device.js'

const { TVT_HOST, TVT_PORT = '6036', TVT_USER, TVT_PASS, CHANNELS = '8' } = process.env
const device = await Device.create(TVT_HOST, Number(TVT_PORT))
try {
  await device.login(TVT_USER, TVT_PASS)
  await sleep(3000)
  mkdirSync('/app/snapshots', { recursive: true })
  for (let ch = 0; ch < Number(CHANNELS); ch++) {
    const file = `/app/snapshots/ch${ch + 1}.jpg`
    const ok = await device.saveSnapshot(ch, file).catch(() => false)
    console.log(`channel ${ch + 1}:`, ok ? `saved ${file}` : `failed (${await device.getLastError()})`)
  }
  await device.logout()
} finally {
  await device.dispose()
}
