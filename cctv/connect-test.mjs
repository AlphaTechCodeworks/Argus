// Logs in to the NVR, prints device info and saves a snapshot of channel 0.
// Reads connection details from environment variables (see .env.example).
import { mkdirSync } from 'node:fs'
import { Device } from '../build/device.js'

const { TVT_HOST, TVT_PORT = '6036', TVT_USER, TVT_PASS } = process.env
if (!TVT_HOST || !TVT_USER || !TVT_PASS) {
  console.error('Set TVT_HOST, TVT_USER and TVT_PASS in .env')
  process.exit(1)
}

const device = await Device.create(TVT_HOST, Number(TVT_PORT))

try {
  await device.login(TVT_USER, TVT_PASS)
  console.log('Login OK, SDK:', device.version)
  console.log('Device info:', await device.getInfo())
  mkdirSync('/app/snapshots', { recursive: true })
  const ok = await device.saveSnapshot(0, '/app/snapshots/ch0.jpg')
  console.log('Snapshot ch0:', ok ? 'saved to snapshots/ch0.jpg' : 'failed')
  await device.logout()
} catch (e) {
  console.error('Error:', e.message ?? e)
  process.exitCode = 1
} finally {
  await device.dispose()
}
