// SMART, in words.
//
// A raw SMART table is close to unreadable: two dozen numbered attributes, each with a normalised
// value, a worst-ever value, a threshold and a raw count, where the numbers mean entirely different
// things from one attribute to the next and some of them mean nothing at all. Printing that table
// verbatim would satisfy the letter of "show me the SMART data" and help nobody.
//
// So each attribute gets three things: its real name, its raw count written in whatever unit it is
// actually in, and a plain sentence about what it means here. The ones that matter are marked.
//
// Three judgements are baked in, all of them learned from nvr-2's real drive on 2026-09-25:
//
//   - Only five attributes reliably predict a failure (Backblaze, on a fleet of hundreds of
//     thousands): reallocated sectors, reported uncorrectable, command timeout, pending sectors
//     and offline uncorrectable. Those are marked "key". A non-zero count on any of them is worth
//     acting on; on the rest it usually is not.
//
//   - Attributes 1 and 7 are vendor-encoded. This healthy drive reports 889,728,777 "seek errors".
//     The raw number is meaningless on its own, so it is shown but explicitly labelled as such
//     rather than left to frighten somebody.
//
//   - Attributes 241 and 242 are 32-bit and have wrapped about 150 times on this drive: it claims
//     0.93 TB written where the true figure is nearer 331 TB. They are shown as unreliable rather
//     than as a number, because a confident wrong number is worse than an admitted gap.

const n = (v) => (Number.isFinite(v) ? v.toLocaleString('en-GB') : null)

/** Hours as hours and something a person can picture. */
export function hours(h) {
  if (!Number.isFinite(h)) return null
  const d = h / 24
  return d < 90 ? `${n(h)} h (${Math.round(d)} days)` : `${n(h)} h (${(d / 365).toFixed(1)} years)`
}

/** The five that actually predict a failure, and what a count above zero means on each. */
export const KEY_ATTRS = Object.freeze({
  5: 'Sectors that have already failed and been swapped for spares. Above zero means the drive has started to go.',
  187: 'Reads the drive could not correct, even with its own error correction.',
  188: 'Commands the drive gave up on. Often a cable or power problem rather than the disk.',
  197: 'Sectors waiting to be swapped out. The earliest honest warning there is.',
  198: 'Sectors that could not be read even when the drive checked in its own time.'
})

// What each attribute's raw count is actually counting, and how to write it.
const AS = {
  1: { unit: 'vendor', note: 'Vendor-encoded. On a Seagate a healthy drive reports millions here; the number on its own means nothing.' },
  3: { unit: 'ms', note: 'How long the platters take to come up to speed.' },
  4: { unit: 'count', note: 'Times the motor has started and stopped.' },
  5: { unit: 'sectors', note: KEY_ATTRS[5], key: true },
  7: { unit: 'vendor', note: 'Vendor-encoded. Seagate report hundreds of millions on a perfectly good drive; ignore the raw figure.' },
  9: { unit: 'hours', note: 'How long the drive has been powered on in its life.' },
  10: { unit: 'count', note: 'Times the motor failed to spin up first go.' },
  12: { unit: 'count', note: 'Times the drive has been powered up.' },
  18: { unit: 'count', note: 'The drive\'s own check on its heads.' },
  187: { unit: 'count', note: KEY_ATTRS[187], key: true },
  188: { unit: 'count', note: KEY_ATTRS[188], key: true },
  190: { unit: 'airflow', note: 'Airflow temperature. The worst-ever figure is the only record of how hot this drive has been.' },
  192: { unit: 'count', note: 'Times the heads parked because the power went, rather than because the drive was asked to stop.' },
  193: { unit: 'count', note: 'Times the heads have parked and unparked. These are rated for hundreds of thousands.' },
  194: { unit: '°C', note: 'Temperature now.' },
  197: { unit: 'sectors', note: KEY_ATTRS[197], key: true },
  198: { unit: 'sectors', note: KEY_ATTRS[198], key: true },
  199: { unit: 'count', note: 'Errors on the cable between the drive and the recorder. Above zero usually means reseat the cable, not replace the disk.' },
  200: { unit: 'count', note: 'Errors while writing.' },
  240: { unit: 'hours', note: 'Hours the heads have actually been flying over the platters, as against merely powered.' },
  241: { unit: 'wrapped', note: 'Total written. This counter is 32-bit and has wrapped many times over, so the figure cannot be believed.' },
  242: { unit: 'wrapped', note: 'Total read. Wrapped, like the one above.' }
}

/** One attribute's raw count, written in the unit it is really in. */
export function rawText(attr) {
  const a = AS[attr.id]
  const r = attr.raw
  if (!Number.isFinite(r)) return '—'
  switch (a?.unit) {
    case 'hours': return hours(r)
    case '°C': return `${r} °C`
    case 'airflow': return `${r} °C`
    case 'ms': return `${n(r)} ms`
    case 'vendor': return `${n(r)} (encoded)`
    case 'wrapped': return `${n(r)} (counter wrapped)`
    default: return n(r)
  }
}

/**
 * The SMART table as rows a person can read.
 * `state` is 'bad' for a key attribute that has started counting, 'warn' for one the drive itself
 * flags, 'muted' for the ones whose raw number means nothing, and '' otherwise.
 */
export function smartRows(smart) {
  if (!smart?.attrs?.length) return []
  return smart.attrs.map((a) => {
    const meta = AS[a.id] ?? {}
    const flagged = String(a.status ?? '').toLowerCase() === 'warn'
    const counting = meta.key && Number.isFinite(a.raw) && a.raw > 0
    return {
      id: a.id,
      name: a.name,
      raw: rawText(a),
      // The normalised value against the threshold, which is how the drive itself judges it.
      margin: Number.isFinite(a.value) && Number.isFinite(a.threshold) ? `${a.value} / ${a.threshold}` : '—',
      kind: a.kind === 'Pre-fail' ? 'Predicts failure' : a.kind === 'Oldage' ? 'Wears out' : '',
      note: meta.note ?? '',
      key: Boolean(meta.key),
      state: counting ? 'bad' : flagged ? 'warn' : meta.unit === 'vendor' || meta.unit === 'wrapped' ? 'muted' : ''
    }
  })
}

/**
 * The handful of facts worth reading before the table: the things that are actually actionable.
 * Each is {label, value, state, note}. A figure the drive did not give is left out entirely
 * rather than shown as a zero.
 */
export function smartSummary(smart) {
  if (!smart) return []
  const out = []
  const push = (label, value, state = '', note = '') => out.push({ label, value, state, note })

  if (smart.verdict) {
    push('The drive\'s own verdict', smart.verdict === 'lowHealth' ? 'Low health' : smart.verdict[0].toUpperCase() + smart.verdict.slice(1),
      smart.state, smart.state === 'ok' ? '' : 'the drive is reporting a problem with itself')
  }
  if (Number.isFinite(smart.temperature)) {
    const peak = Number.isFinite(smart.peakTemp) ? `, peak ${smart.peakTemp} °C` : ''
    push('Temperature', `${smart.temperature} °C${peak}`, smart.temperature >= 50 ? 'bad' : smart.temperature >= 45 ? 'warn' : 'ok',
      'a drive that has crept up since it was installed usually means a fan has stopped')
  }
  if (Number.isFinite(smart.powerOnHours)) {
    push('Age', hours(smart.powerOnHours), '', Number.isFinite(smart.flyingHours) && smart.powerOnHours > 0
      ? `${Math.round((smart.flyingHours / smart.powerOnHours) * 100)} % of that spent actually reading and writing`
      : '')
  }
  // The one that is usually a building problem rather than a disk problem, and is worth fixing.
  if (Number.isFinite(smart.unsafeShutdowns) && Number.isFinite(smart.powerCycles) && smart.powerCycles > 0) {
    const pct = Math.round((smart.unsafeShutdowns / smart.powerCycles) * 100)
    push('Unclean power-downs', `${smart.unsafeShutdowns} of ${smart.powerCycles} (${pct} %)`,
      pct >= 50 ? 'warn' : pct >= 20 ? 'warn' : 'ok',
      pct >= 20 ? 'the heads parked because the power went. A recorder writing continuously can lose its filesystem this way — this is an argument for a UPS, not for a new disk.' : '')
  }
  if (Number.isFinite(smart.crcErrors)) {
    push('Cable errors', n(smart.crcErrors), smart.crcErrors > 0 ? 'warn' : 'ok',
      smart.crcErrors > 0 ? 'reseat the SATA cable before suspecting the disk' : '')
  }
  const bad = smartRows(smart).filter((r) => r.state === 'bad')
  push('Failing sectors', bad.length ? bad.map((r) => `${r.name}: ${r.raw}`).join(', ') : 'None',
    bad.length ? 'bad' : 'ok',
    bad.length ? 'these are the counts that actually predict a drive failing' : 'the five counts that predict a failure are all zero')
  return out
}
