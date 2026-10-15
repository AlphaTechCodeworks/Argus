// ONVIF discovery (WS-Discovery): one standard "who is there?" Probe for network video devices, sent
// to the multicast address 239.255.255.250:3702, the way SADP-style tools and every VMS find cameras.
// TVT's own search (mhed.mjs) is answered only by its recorders on this network; its IP cameras answer
// this one (2026-10-15 on prod: an IP619E5W-28-S4 at 192.168.2.118 that TVT's search did not find).
// Nothing is changed on any device: the Probe only asks devices to say what they are.
//
//   wsDiscover({ waitMs }) -> { ran, devices: [{ ip, name, model, type, port, onvif }], why? }
import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'

const GROUP = '239.255.255.250'
const PORT = 3702
const MAX_DEVICES = 256

/** The Probe for ONVIF network video devices (cameras and the recorders that also speak ONVIF). */
export function probeMessage(id = randomUUID()) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
}

const text = (xml, tag) => (String(xml).match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`)) ?? [])[1] ?? ''
const scope = (scopes, key) => {
  const m = String(scopes).match(new RegExp(`onvif://www\\.onvif\\.org/${key}/(\\S+)`, 'i'))
  if (!m) return ''
  try { return decodeURIComponent(m[1]).replace(/_/g, ' ').slice(0, 64) } catch { return m[1].slice(0, 64) }
}

/**
 * One ProbeMatch answer as a device, or null. A recorder (its model says NVR/DVR/XVR) is named so;
 * anything else answering for "network video transmitter" is taken for an IP camera.
 * @param {string} xml @param {string} from the sender's address
 */
export function parseProbeMatch(xml, from) {
  if (!/ProbeMatch/.test(xml)) return null
  const xaddrs = text(xml, 'XAddrs').trim().split(/\s+/)
  const scopes = text(xml, 'Scopes')
  const model = scope(scopes, 'hardware')
  const name = scope(scopes, 'name')
  let port = 80
  try { port = Number(new URL(xaddrs[0]).port) || 80 } catch {}
  const recorder = /\b(N|D|X|H)VR|NVR/i.test(`${model} ${name}`)
  return { ip: from, name: name && name !== model ? name : '', model: model || null, type: recorder ? 'NVR' : 'IP camera', port, onvif: xaddrs[0] || null }
}

/** Sends the Probe twice (UDP can lose one) and gathers the answers for waitMs. */
export function wsDiscover({ waitMs = 3000, socket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }) } = {}) {
  return new Promise((resolve) => {
    const found = new Map()
    let s
    const finish = (why) => {
      try { s?.close() } catch {}
      resolve(why ? { ran: false, devices: [], why } : { ran: true, devices: [...found.values()] })
    }
    try {
      s = socket()
    } catch (e) {
      return resolve({ ran: false, devices: [], why: e.message })
    }
    s.on('error', (e) => finish(e.message))
    s.on('message', (m, r) => {
      if (found.size >= MAX_DEVICES || found.has(r.address)) return
      const d = parseProbeMatch(m.toString('utf8').slice(0, 64 * 1024), r.address)
      if (d) found.set(r.address, d)
    })
    s.bind(0, () => {
      const msg = Buffer.from(probeMessage())
      s.send(msg, PORT, GROUP)
      setTimeout(() => { try { s.send(msg, PORT, GROUP) } catch {} }, 400)
      setTimeout(() => finish(null), waitMs)
    })
  })
}
