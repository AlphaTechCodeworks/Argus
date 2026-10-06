// P2P Main opens another cloud connection; do not discard its handle halfway
// through the vendor's approximately 30-second connection window.
export function liveStartTimeoutMs(streamType, serial) {
  return streamType === 0 && Boolean(serial) ? 35_000 : 15_000
}
