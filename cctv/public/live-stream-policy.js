export function gridStreamType({ cells, hd = true, remote = false, remotePage = false, unsupportedMain = false }) {
  return cells === 1 && hd !== false && !unsupportedMain && !(remote && remotePage) ? 0 : 1
}
