// Run by the RTSP server (MediaMTX runOnRead / runOnUnread, config by rtsp.mjs) when a program starts
// or stops reading a camera path: tells Argus, so /healthz and Health can count the readers.
//   node rtsp-hook.mjs <read|unread> <Argus event URL> <secret>     (MTX_PATH, MTX_READER_ID from MediaMTX)
// Never fails loudly: a reader count a little off is not worth a line per connection.
const [event, url, secret] = process.argv.slice(2)
if (event && url && secret) {
  try {
    await fetch(`${url}?s=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, path: process.env.MTX_PATH ?? '', id: process.env.MTX_READER_ID ?? `${process.env.MTX_READER_TYPE ?? ''}` }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {}
}
