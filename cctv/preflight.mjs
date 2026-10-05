// Checks the native SDK loads and the NVR port is reachable. No login.
import { connect } from 'node:net'
import { Device } from '../build/device.js'

const host = process.env.TVT_HOST ?? '192.168.0.228'
const port = Number(process.env.TVT_PORT ?? 6036)

const d = await Device.create(host, port)
console.log('Native SDK loaded OK')
await d.dispose()

await new Promise((res) => {
  const s = connect(port, host, () => { console.log(`NVR ${host}:${port} reachable`); s.end(); res() })
  s.on('error', (e) => { console.log('Network error:', e.message); res() })
})
