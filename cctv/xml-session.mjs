// Which NVR session an XML command (nvr-xml.mjs transparent / power) would go out on.
// Usually the main process's own "control" login. An NVR that refuses that login while its live
// worker is logged in lends the worker's instead (nvrs.mjs Nvr borrowing; shad, 2026-10-06), so the
// settings modules ask these rather than nvr.online / nvr.degraded / nvr.gen, which speak for the
// control login alone and are still what playback and searches must ask.
// An object that does not know about borrowing (the stand-ins in the settings tests) is judged by
// its plain fields. Imports nothing: modules that must load without the SDK use it too.

/** Whether an XML command can be sent to this NVR at all. */
export const xmlOnline = (nvr) => Boolean(nvr?.xmlOnline ?? nvr?.online)
/** Whether the session it would use is busy or recovering. */
export const xmlDegraded = (nvr) => Boolean(nvr?.xmlDegraded ?? nvr?.degraded)
/** That session's identity: a caller that read on one must not write on another. */
export const xmlGen = (nvr) => nvr?.xmlGen ?? nvr?.gen
