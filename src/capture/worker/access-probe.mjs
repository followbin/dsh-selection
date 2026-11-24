// Screen-recording access probe: a process of its own, started by the Host for one reading.
// macOS answers every access question from what a process first read, so the long-running capture
// worker cannot see a grant, a denial or a reset made after it started; a new process can.
// Prints `{ state, live }` (see native/darwin-access.mjs) as one JSON line and exits.
const access = process.platform === 'darwin'
  ? (await import('./native/darwin-access.mjs')).screenAccess()
  : { state: 'granted', live: true }
process.stdout.write(`${JSON.stringify(access)}\n`)
