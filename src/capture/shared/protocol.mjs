// Agreements between the DSH Host plugin and the capture worker process.

/**
 * Exit code the worker uses to ask for an immediate restart with no backoff.
 * Screen-recording access is read once per process on macOS, so a worker that
 * observes a fresh grant exits with this code to be re-forked and see it.
 */
export const RESTART_NOW = 75

/** Worker -> Host. */
export const FROM_WORKER = Object.freeze({
  READY: 'ready',
  PERMISSION: 'permission',
  CAPTURED: 'captured',
  CANCELLED: 'cancelled',
  ASK: 'ask',
  PIN_ACTION: 'pin-action',
  CLIPBOARD_TEXT: 'clipboard-text',
  DISPLAYS: 'displays',
  /** The capture shortcut's state: { spec, registered, reason, listening }. */
  HOTKEY: 'hotkey',
  /** The capture overlay went up (true) or down (false). */
  CAPTURING: 'capturing',
  /** A surface asked to show the plugin's settings page in DSH. */
  OPEN_SETTINGS: 'open-settings',
  ERROR: 'error',
})

/** Host -> Worker. */
export const TO_WORKER = Object.freeze({
  SHUTDOWN: 'shutdown',
  SETTINGS: 'settings',
  TRIGGER: 'trigger',
  /** Show the system's screen-recording prompt; only an access never answered, as this process read it, gets one. */
  REQUEST_PERMISSION: 'request-permission',
  ANSWER_CHUNK: 'answer-chunk',
  ANSWER_END: 'answer-end',
  ANSWER_FAIL: 'answer-fail',
  CLOSE_SURFACES: 'close-surfaces',
})

/** Stable reasons a capture could not start; the UI translates these. */
export const BLOCKED = Object.freeze({
  /** This process started without screen recording; the Host reads the access anew and asks for it or restarts the process. */
  NO_PERMISSION: 'no-permission',
  /** Every display capture came back empty, as after a revocation in a running process. */
  CAPTURE_FAILED: 'capture-failed',
  NO_DISPLAY: 'no-display',
  ASLEEP: 'displays-asleep',
  BUSY: 'busy',
})
