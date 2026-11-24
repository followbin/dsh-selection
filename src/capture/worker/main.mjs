// Capture worker. Runs as a child of the DSH Host so the screen-recording grant stays
// attributed to DeepSeek Harness, and so a fault in native code only takes this process down.
import { DEFAULT_HOTKEY } from '../shared/defaults.mjs'
import { BUILTIN_ACTION_ICONS, CUSTOM_ACTION_ICONS } from '../shared/icons.mjs'
import { createDisplayTracker } from './displays.mjs'
import { createOverlay } from './overlay.mjs'
import { createCaptureSession } from './session.mjs'
import { createHotkey } from './hotkey.mjs'
import { createPins } from './pins.mjs'
import { createAnswers } from './answers.mjs'
import { dataDirectory } from '../../shared/paths.mjs'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { FROM_WORKER, TO_WORKER, RESTART_NOW } from '../shared/protocol.mjs'


const send = (type, payload = {}) => { if (process.send) process.send({ type, ...payload }) }
const log = (level, message, fields) => send(FROM_WORKER.ERROR === level ? FROM_WORKER.ERROR : 'log', { level, message, fields })

function loadNative() {
  if (process.platform === 'darwin') return import('./native/darwin.mjs')
  if (process.platform === 'win32') return import('./native/win32.mjs')
  throw new Error(`unsupported platform ${process.platform}`)
}

const native = await loadNative()
const dataDir = join(dataDirectory(), 'capture')
/**
 * What the Host told this process: the shortcut, the interface language and the AI row. The first copy
 * arrives as `--config=<json>` so the shortcut is armed before the IPC channel is up; later
 * changes arrive as SETTINGS messages.
 */
let settings = { hotkey: DEFAULT_HOTKEY, locale: 'zh', actions: null, debugKeys: false }
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--config=')) continue
  try { settings = { ...settings, ...JSON.parse(arg.slice('--config='.length)) } } catch { /* the defaults stand */ }
}
/** DSH's interface language, as the Host reports it: 'zh' or 'en'. */
const uiLocale = () => (settings.locale === 'en' ? 'en' : 'zh')
/** Enabled AI actions in the user's order, with the icon markup the pages draw. */
const aiActions = () => (Array.isArray(settings.actions) ? settings.actions : [])
  .filter((entry) => entry.enabled !== false)
  .map((entry) => entry.custom
    ? { id: entry.id, name: entry.name, icon: CUSTOM_ACTION_ICONS[entry.icon] ?? CUSTOM_ACTION_ICONS.sparkles }
    : { id: entry.id, name: null, icon: BUILTIN_ACTION_ICONS[entry.id] ?? '' })
/** What an answer panel calls an action: a custom action's own name, or null for a built-in. */
const actionName = (id) => (Array.isArray(settings.actions) ? settings.actions : []).find((entry) => entry.custom && entry.id === id)?.name ?? null

// The access as this process read it at start, and whether it can capture. Neither follows later
// changes (see native/darwin-access.mjs); the Host reads them anew in a probe process.
const startAccess = native.screenAccess()
const permission = { state: startAccess.state, live: startAccess.live, process: native.processCanCapture() }
send(FROM_WORKER.PERMISSION, permission)

const tracker = createDisplayTracker({
  native,
  log,
  onChange: (displays) => {
    // A capture on screen is now drawn against a topology that no longer exists.
    session?.abort('displays changed')
    overlay?.hide()
    overlay?.retopology(displays)
    send(FROM_WORKER.DISPLAYS, { count: displays.length })
  },
})

const overlay = await createOverlay({
  native,
  displays: () => tracker.displays,
  locale: uiLocale,
  actions: () => (Array.isArray(settings.actions) ? aiActions() : null),
  log,
  onMessage: (displayId, message) => session.handle(displayId, message),
  onClipboardText: (text) => send(FROM_WORKER.CLIPBOARD_TEXT, { text }),
})

const pins = createPins({
  app: overlay.app,
  native,
  log,
  awake: { hold: (key) => overlay.holdAwake(key), release: (key) => overlay.releaseAwake(key) },
  locale: uiLocale,
  // A pin cannot copy, save or call a model itself: those belong to the Host, which owns
  // the clipboard, the save directory and the model route.
  onAction: (action, pin) => {
    if (action === 'ask') {
      answers.open({ png: pin.png, rect: pin.rect, action: 'ask', prompt: '' })
        .catch((error) => fatalNote('answer panel failed to open', error, false))
      return
    }
    send(FROM_WORKER.PIN_ACTION, { action, png: pin.png.toString('base64') })
  },
})

const answers = createAnswers({
  app: overlay.app,
  native,
  log,
  awake: { hold: (key) => overlay.holdAwake(key), release: (key) => overlay.releaseAwake(key) },
  locale: uiLocale,
  actionName,
  displays: () => tracker.displays,
  onRequest: ({ png, ...request }) => send(FROM_WORKER.ASK, { ...request, png: png.toString('base64') }),
  onClipboardText: (text) => send(FROM_WORKER.CLIPBOARD_TEXT, { text }),
  onOpenSettings: () => send(FROM_WORKER.OPEN_SETTINGS, {}),
})

const session = createCaptureSession({
  native,
  overlay,
  tracker,
  dataDir,
  log,
  onResult: (result) => {
    if (result.kind === 'cancelled' || result.kind === 'failed') {
      send(FROM_WORKER.CANCELLED, { reason: result.reason ?? null })
      return
    }
    // Pins and answer panels are windows, and windows belong to this process; only the
    // actions that need the Host's clipboard, disk or model route are forwarded.
    if (result.kind === 'pin') {
      pins.open({ png: result.png, rect: result.rect })
        .catch((error) => fatalNote('pin failed to open', error, false))
      return
    }
    if (result.kind === 'ai') {
      answers.open({ png: result.png, rect: result.rect, action: result.action ?? 'ask', prompt: result.prompt })
        .catch((error) => fatalNote('answer panel failed to open', error, false))
      return
    }
    // PNG bytes ride as base64 over the Node IPC channel; the Host owns the attachment
    // store and the model call, so the worker never touches either.
    send(FROM_WORKER.CAPTURED, {
      action: result.kind,
      aiAction: result.action,
      rect: result.rect,
      prompt: result.prompt,
      shapes: result.shapes,
      png: result.png.toString('base64'),
    })
  },
  onBlocked: (reason) => send(FROM_WORKER.CANCELLED, { reason }),
  // The selection toolbar stops reading selections while the overlay is up.
  onActive: (active) => send(FROM_WORKER.CAPTURING, { active }),
})

const hotkey = createHotkey({
  spec: settings.hotkey,
  log,
  native,
  debugKeys: process.env.DSH_SHOT_DEBUG_KEYS === '1' || settings.debugKeys === true,
  onTrigger: () => session.begin(),
  onStatus: (status) => send(FROM_WORKER.HOTKEY, status),
})

process.on('message', (message) => {
  switch (message?.type) {
    case TO_WORKER.TRIGGER:
      session.begin()
      return
    case TO_WORKER.SETTINGS:
      settings = { ...settings, ...message.settings }
      if (message.settings && 'hotkey' in message.settings) hotkey.setSpec(message.settings.hotkey)
      return
    case TO_WORKER.REQUEST_PERMISSION:
      // The Host sends this only to a process that read the access as never answered. The grant
      // only lands in a later process; the Host restarts this one once a probe reads it.
      native.requestScreenPermission()
      return
    case TO_WORKER.ANSWER_CHUNK:
      answers.chunk(message.id, message.text)
      return
    case TO_WORKER.ANSWER_END:
      answers.end(message.id)
      return
    case TO_WORKER.ANSWER_FAIL:
      answers.fail(message.id, message.code, message.detail)
      return
    case TO_WORKER.CLOSE_SURFACES:
      pins.closeAll()
      answers.closeAll()
      return
    case TO_WORKER.SHUTDOWN:
      shutdown(0)
      return
    default:
      return
  }
})

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try { hotkey.dispose() } catch { /* hook already gone */ }
  try { pins.dispose() } catch { /* no pins open */ }
  try { answers.dispose() } catch { /* no panels open */ }
  try { session.dispose() } catch { /* nothing on screen */ }
  try { overlay.dispose() } catch { /* windows already closed */ }
  try { tracker.dispose() } catch { /* callback already removed */ }
  if (code === 0 || !process.connected) { process.exit(code); return }
  // A crash report travels over IPC, which is asynchronous; exiting at once drops it.
  setTimeout(() => process.exit(code), 150)
}

/**
 * Record a failure where it survives this process. IPC sends are asynchronous, so an
 * error reported only through log() is lost when the process exits right after; the
 * file write is synchronous and the Host prints it on the next start.
 */
function fatalNote(what, error, fatal = true) {
  const text = `${new Date().toISOString()} ${what}: ${error?.stack ?? error}\n`
  try {
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(join(dataDir, 'worker-errors.log'), text)
  } catch { /* the data directory is unwritable; the IPC log below is all that is left */ }
  log('error', what, { error: String(error?.stack ?? error).slice(0, 2000), fatal })
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('uncaughtException', (error) => { fatalNote('uncaught exception in worker', error); shutdown(1) })
process.on('unhandledRejection', (error) => { fatalNote('unhandled rejection in worker', error); shutdown(1) })

// Build one spare pin and one spare answer panel once startup has settled, so the first
// of each opens immediately instead of after a second and a half.
pins.warm(1500)
answers.warm(2500)

send(FROM_WORKER.READY, {
  permission,
  displays: tracker.displays.length,
  overlays: overlay.screenCount(),
  surfaces: { pins: pins.count, answers: answers.count },
  hotkey: hotkey.status(),
})

export { RESTART_NOW }
