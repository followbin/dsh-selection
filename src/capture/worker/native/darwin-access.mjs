// macOS screen-recording access: the system's record, this process's snapshot, and the prompt.
// Kept apart from darwin.mjs so the access probe (../access-probe.mjs) loads only what it reads.
import { koffi } from './koffi.mjs'

const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
const cgPreflight = CG.func('bool CGPreflightScreenCaptureAccess(void)')
const cgRequest = CG.func('bool CGRequestScreenCaptureAccess(void)')
const cfStringFromC = CF.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t encoding)')
const UTF8 = 0x08000100

/**
 * TCC's record for this app's screen recording. TCCAccessPreflight is private API; where it is
 * missing, {@link screenAccess} reads CGPreflightScreenCaptureAccess instead.
 */
const tccScreenPreflight = (() => {
  try {
    const TCC = koffi.load('/System/Library/PrivateFrameworks/TCC.framework/TCC')
    const preflight = TCC.func('int TCCAccessPreflight(void *service, void *options)')
    const service = cfStringFromC(null, 'kTCCServiceScreenCapture', UTF8)
    return () => preflight(service, null)
  } catch {
    // TCC.framework or the symbol is gone on this macOS version: only CoreGraphics' answer is left.
    return null
  }
})()
/** TCCAccessPreflight results: 0 allowed, 1 denied (the system will not ask again), 2 never answered. */
const TCC_ACCESS = ['granted', 'denied', 'not-determined']

/**
 * This app's screen-recording access. Both sources answer from what this process first read and do
 * not follow later changes, so only a new process (the access probe, or a restarted worker) sees a
 * grant, a denial or a reset made since.
 * `not-determined` means {@link requestScreenPermission} shows the system prompt; after `denied`
 * only System Settings can change it. With `live` false the answer comes from CoreGraphics, which
 * cannot tell the two apart and reads `denied`.
 * @returns {{ state: 'granted' | 'denied' | 'not-determined', live: boolean }}
 */
export function screenAccess() {
  const state = tccScreenPreflight ? TCC_ACCESS[tccScreenPreflight()] : undefined
  if (state) return { state, live: true }
  return { state: cgPreflight() ? 'granted' : 'denied', live: false }
}

/**
 * Whether this process can capture the screen. Fixed when the process starts: a grant made later
 * only reaches a new process, and after a revocation captures return null although this still says true.
 * @returns {boolean}
 */
export function processCanCapture() {
  return cgPreflight()
}

/**
 * Shows the system prompt when the access was never answered (`not-determined`), as this process
 * read it; otherwise does nothing. Returns immediately; the grant only takes effect in a later process.
 * @returns {boolean} true when access was already present.
 */
export function requestScreenPermission() {
  return cgRequest()
}
