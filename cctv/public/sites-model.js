export function connectionState(n) {
  const management = n.managementOnline ?? n.status === 'online'
  if (n.videoOnline === true && !management) return { key: 'partial', text: 'Video only', detail: 'Management unavailable' }
  if (management) return { key: 'online', text: 'Connected', detail: n.videoOnline === false ? 'Video disconnected' : n.videoOnline === true ? 'Video connected' : 'Video status unknown' }
  return { key: n.status === 'connecting' ? 'connecting' : 'offline', text: n.status === 'connecting' ? 'Connecting' : 'Disconnected', detail: n.videoOnline === false ? 'Video disconnected' : 'Video status unknown' }
}
export function cameraConnectionState(cam) {
  if (typeof cam?.nvrOnline !== 'boolean' && typeof cam?.nvrVideoOnline !== 'boolean') return null
  return connectionState({ status: cam.nvrOnline ? 'online' : 'offline', managementOnline: cam.nvrOnline, videoOnline: cam.nvrVideoOnline })
}
export function matchesNvr(n, query, status) {
  const state = connectionState(n)
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const text = [n.site, n.name, n.model, n.sn, n.host].filter(Boolean).join(' ').toLocaleLowerCase()
  return (!status || state.key === status) && words.every((word) => text.includes(word))
}
