// A small JSON file (users.json, rights.json) that nearly every request consults: read once, then
// again only when the file has changed (one stat per use: size and modified time). It was
// read and parsed from disk several times per request and per video socket, on the event loop
// that also fans out every camera's frames.
import { statSync } from 'node:fs'

/**
 * @param {string} path
 * @param {() => any} load the uncached read (called when the file is new or changed)
 * @returns {{ get: () => any, forget: () => void }} forget(): after this process wrote the file
 */
export function fileCache(path, load) {
  let value
  let mtime = null // null: not read yet
  const stamp = () => {
    try {
      const st = statSync(path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return 'missing' // load() decides what that means
    }
  }
  return {
    get() {
      const m = stamp()
      if (m !== mtime) {
        value = load()
        mtime = m
      }
      return value
    },
    forget() {
      mtime = null
    }
  }
}
