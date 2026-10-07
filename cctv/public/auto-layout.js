export function autoLayout(count) {
  const total = Math.max(1, Math.min(16, Math.floor(Number(count) || 0)))
  const size = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / size)
  const cells = Array.from({ length: total }, (_, i) => [i % size + 1, Math.floor(i / size) + 1, 1, 1])
  return { size, rows, cells }
}
