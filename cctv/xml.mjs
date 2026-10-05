// The NVR's XML dialect, with nothing else attached.
//
// This is the same parser nvr-xml.mjs has always used; it lives in its own module so that code
// which only needs to read an NVR's answer (nvr-disks.mjs, and its tests) does not have to import
// nvr-xml.mjs, which loads the native SDK. The SDK is a Linux .so, so anything that reaches it
// cannot even be imported on a Windows development PC, and the offline tests have to run there.
//
// nvr-xml.mjs re-exports all of this, so every existing importer is unaffected.

export const XML_HEADER = '<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB">'

const decode = (s) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'"
      : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))

export const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Parses XML into { name, attrs, children, text }. Throws on malformed input. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(xml))) {
    const top = stack.at(-1)
    if (m[1] !== undefined) top.text += m[1]
    else if (m[2]) {
      if (top.name !== m[2]) throw new Error(`bad answer from the NVR (</${m[2]}> closes <${top.name}>)`)
      stack.pop()
    } else if (m[3]) {
      const attrs = {}
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3])
      const node = { name: m[3], attrs, children: [], text: '' }
      top.children.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6] !== undefined) top.text += decode(m[6])
  }
  if (stack.length !== 1) throw new Error(`bad answer from the NVR (<${stack.at(-1).name}> not closed)`)
  return root
}

export const kid = (n, name) => n?.children.find((c) => c.name === name)
export const kids = (n, name) => n?.children.filter((c) => c.name === name) ?? []
