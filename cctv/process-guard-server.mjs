// The main process's net under a promise rejection nobody catches (process-guard.mjs), as a module
// of its own so that server.mjs can import it before every other. A file's imports are all loaded
// before its own first line runs, wherever that line stands, and auth.mjs waits for a hash while it
// loads: timers and I/O already run then. A call in server.mjs itself came after all of that, and a
// rejection in the meantime still ended the process. Imports nothing else, or that would run first.
import { guardProcess } from './process-guard.mjs'

guardProcess({ name: 'server' })
