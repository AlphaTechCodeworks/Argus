// The pure half of time-lapse thinning: which keyframes of a segment survive, the new file built
// from them, the check that a rewrite on disk is what was meant, and the names of the files the
// journalled swap uses. No file calls here: thinning.mjs makes them on the server, and the share
// helper (share-ops.mjs) in a process of its own.
//
// Apart from thinning.mjs so that the helper can load it alone: thinning.mjs reaches auth.mjs through
// storage-report.mjs, which hashes a password as it loads (2026-09-29, perf report Task 2).
import { CODEC, splitUnits } from './rec-reader.mjs'

export const codecOf = (path) => (/\.h265$/i.test(String(path)) ? CODEC.h265 : CODEC.h264)

/** The swap's files beside a segment `p` (see thinning.mjs swapIn). */
export const THIN_SUFFIX = Object.freeze({ newSeg: '.thin-new', newIdx: '.idx.thin-new', oldSeg: '.thin-old', oldIdx: '.idx.thin-old', journal: '.thin-journal' })
export const thinNames = (p) => ({
  seg: p,
  idx: `${p}.idx`,
  newSeg: p + THIN_SUFFIX.newSeg,
  newIdx: p + THIN_SUFFIX.newIdx,
  oldSeg: p + THIN_SUFFIX.oldSeg,
  oldIdx: p + THIN_SUFFIX.oldIdx,
  journal: p + THIN_SUFFIX.journal
})

/**
 * Which keyframes of one segment survive, given a per-camera cursor of the last kept time so the
 * spacing holds across file boundaries too.
 * @returns {{ keep: {start:number,end:number,tsMs:number}[], units: number, cursor: number }}
 */
export function planThin(buf, idxRows, { codec, timelapseS, cursor = -Infinity }) {
  const keyOffsets = new Set(idxRows.map((r) => r.offset))
  const { units } = splitUnits(buf, codec, { final: true, keyOffsets, base: 0 })
  const tsOf = new Map(idxRows.map((r) => [r.offset, r.tsMs]))
  const stepMs = Math.max(1, Math.round(timelapseS * 1000))
  const keep = []
  let cur = cursor
  for (const u of units) {
    if (!u.isKey || !tsOf.has(u.start)) continue
    const ts = tsOf.get(u.start)
    if (!Number.isFinite(ts)) continue
    if (cur !== -Infinity && ts - cur < stepMs) continue
    keep.push({ start: u.start, end: u.end, tsMs: ts })
    cur = ts
  }
  return { keep, units: units.length, cursor: cur }
}

/** Builds the new segment bytes and its .idx from a plan. */
export function buildThinned(buf, keep) {
  const parts = keep.map((k) => buf.subarray(k.start, k.end))
  const out = Buffer.concat(parts)
  const idx = Buffer.alloc(keep.length * 16)
  let off = 0
  for (let i = 0; i < keep.length; i++) {
    idx.writeBigUInt64LE(BigInt(off), i * 16)
    idx.writeBigInt64LE(BigInt(Math.round(keep[i].tsMs)), i * 16 + 8)
    off += parts[i].length
  }
  return { bytes: out, idx }
}

/**
 * Checks a rewrite as read back off the disk (`buf`, and `rows` parsed from its .idx) against what
 * was meant: right size, one .idx row per unit, every row at a unit start, every unit a keyframe,
 * times increasing. Throws when it is not; `name` is the file named in the error.
 */
export function checkThinned(name, buf, rows, expect) {
  if (buf.length !== expect.bytes) throw new Error(`${name}: ${buf.length} bytes on disk, expected ${expect.bytes}`)
  if (rows.length !== expect.keyframes) throw new Error(`${name}: ${rows.length} index rows, expected ${expect.keyframes}`)
  const keyOffsets = new Set(rows.map((r) => r.offset))
  const { units } = splitUnits(buf, expect.codec, { final: true, keyOffsets, base: 0 })
  if (units.length !== rows.length) throw new Error(`${name}: ${units.length} frames for ${rows.length} index rows`)
  for (let i = 0; i < units.length; i++) {
    if (!units[i].isKey) throw new Error(`${name}: frame ${i} is not a keyframe`)
    if (!keyOffsets.has(units[i].start)) throw new Error(`${name}: frame ${i} does not start at an index offset`)
    if (i > 0 && rows[i].tsMs <= rows[i - 1].tsMs) throw new Error(`${name}: index times do not increase at row ${i}`)
  }
  return { bytes: buf.length, keyframes: rows.length, startMs: rows[0]?.tsMs ?? null, endMs: rows.at(-1)?.tsMs ?? null }
}
