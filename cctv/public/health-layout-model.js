export function healthConnection(panel, raw = {}) {
  if (raw.status === 'connecting') return { text: 'Connecting', state: 'warn' }
  if (raw.loginError) return { text: 'Disconnected', state: 'bad' }
  const video = raw.videoOnline === true
  const management = raw.managementOnline ?? raw.online
  if (video && !management) return { text: 'Video only', state: 'warn' }
  if (management) return { text: 'Connected', state: raw.cooling ? 'warn' : 'ok' }
  return { text: 'Disconnected', state: 'bad' }
}

export function healthIssue(panel) {
  if (!panel) return false
  return panel.status.state !== 'ok' || panel.glance.cameras.state !== 'ok' || panel.disks.state === 'bad' || panel.retention.state === 'bad'
}
