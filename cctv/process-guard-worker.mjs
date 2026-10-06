// An NVR worker's net under a promise rejection nobody catches (process-guard.mjs), as a module of
// its own so that nvr-worker.mjs can import it before every other module of the app (why that takes
// a module: process-guard-server.mjs). Imports nothing else, or that would run first.
import { guardProcess } from './process-guard.mjs'

// The name is the NVR's id alone, like the worker's other lines ("[nvr1] ..."): in the journal the
// supervisor puts "[worker nvr1] " in front of every line a worker prints (worker-supervisor.mjs).
guardProcess({ name: process.env.CCTV_WORKER_NVR })
