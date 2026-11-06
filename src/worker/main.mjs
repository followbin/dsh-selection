// Selection worker: a child process of the DSH Host. selection-hook watches the mouse and reads the
// selection; the overlay shows the toolbar and results; controller.mjs decides what happens.
// Model calls happen in the Host, never here.
import { createRequire } from 'node:module'
import { RESTART_NOW } from '../shared/protocol.mjs'
import { createController } from './controller.mjs'
import { openUrl } from './open-url.mjs'
import { createOverlay } from './overlay.mjs'
import { createSpeech } from './speech.mjs'

const require = createRequire(import.meta.url)
const SelectionHook = require('../../vendor/selection-hook/index.js')

const PERMISSION_POLL_MS = 1000

const send = (message) => process.send?.(message)
const log = (level, message, fields) => send({ type: 'log', level, message, fields })
const hook = new SelectionHook()
// A bug in one handler must not take the toolbar down: it is logged and the next event still works.
const guarded = (name, handler) => (...args) => {
  try {
    handler(...args)
  } catch (error) {
    log('error', `${name} failed`, { error: String(error?.stack ?? error).slice(0, 800) })
  }
}

let config = null
/** @type {Awaited<ReturnType<typeof createOverlay>> | null} */
let overlay = null
/** @type {ReturnType<typeof createController> | null} */
let controller = null
let speech = null
let altDown = false

process.on('disconnect', () => shutdown(0))
process.on('message', (message) => {
  if (message?.type === 'config') applyConfig(message.config)
  else if (message?.type === 'result') guarded('result', () => controller?.onResult(message))()
  else if (message?.type === 'shutdown') shutdown(0)
})

await new Promise((resolve) => {
  const waitForConfig = setInterval(() => {
    if (!config) return
    clearInterval(waitForConfig)
    resolve()
  }, 20)
  send({ type: 'hello' })
})
await waitForAccessibility()

speech = createSpeech({ log, onChange: (speaking) => overlay?.setSpeaking(speaking) })
overlay = await createOverlay({ onMessage: guarded('page message', (message) => controller?.onPage(message)), log })
controller = createController({
  overlay,
  speech,
  send,
  log,
  writeClipboard: (text) => hook.writeToClipboard(text),
  openUrl: (url) => openUrl(url, log),
  positions: { invalid: SelectionHook.INVALID_COORDINATE, fullSelection: SelectionHook.PositionLevel.SEL_FULL },
  idPrefix: String(process.pid),
})
applyConfig(config)

hook.on('text-selection', guarded('selection', (data) => controller.onSelection(data)))
hook.on('mouse-down', guarded('mouse-down', (point) => controller.onMouseDown(point)))
hook.on('mouse-wheel', guarded('mouse-wheel', (point) => controller.onMouseWheel(point)))
hook.on('key-down', guarded('key-down', ({ uniKey }) => {
  if (uniKey === 'Alt' && !altDown) {
    altDown = true
    applyHookFilters(config)
  }
  controller.onKeyDown(uniKey)
}))
hook.on('key-up', guarded('key-up', ({ uniKey }) => {
  if (uniKey === 'Alt' && altDown) {
    altDown = false
    applyHookFilters(config)
  }
  controller.onKeyUp(uniKey)
}))
hook.on('error', (error) => log('warn', 'selection-hook error', { error: String(error?.message ?? error) }))

const hookStarted = hook.start({ debug: false, enableClipboard: config.clipboardFallback })
applyHookFilters(config)
send({ type: 'ready', hookStarted, platform: process.platform, pid: process.pid })

function applyConfig(next) {
  config = next
  if (!controller) return
  controller.configure(next)
  applyHookFilters(next)
}

// The hook reads every selection before the controller sees it, and a read can be a simulated ⌘C in
// the app. While the toolbar cannot appear (turned off, or ⌥ not held), an empty include list makes
// the native engine skip the read entirely.
function applyHookFilters(next) {
  const reading = next.enabled && (next.trigger !== 'modifier' || altDown)
  if (next.clipboardFallback && reading) hook.enableClipboard()
  else hook.disableClipboard()
  if (!reading) hook.setGlobalFilterMode(SelectionHook.FilterMode.INCLUDE_LIST, [])
  else if (next.disabledApps.length) hook.setGlobalFilterMode(SelectionHook.FilterMode.EXCLUDE_LIST, next.disabledApps)
  else hook.setGlobalFilterMode(SelectionHook.FilterMode.DEFAULT, [])
}

// Without the accessibility grant macOS delivers no events to selection-hook. The grant belongs to the
// responsible process: DeepSeek Harness inside DSH, or the terminal app when running the dev script.
async function waitForAccessibility() {
  if (process.platform !== 'darwin') return
  if (hook.macIsProcessTrusted()) {
    send({ type: 'permission', trusted: true })
    return
  }
  const prompt = !process.argv.includes('--no-prompt')
  if (prompt) hook.macRequestProcessTrust()
  send({ type: 'permission', trusted: false, prompted: prompt })
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!hook.macIsProcessTrusted()) return
      clearInterval(timer)
      resolve()
    }, PERMISSION_POLL_MS)
  })
  send({ type: 'permission', trusted: true })
  // Event taps created before the grant stay deaf; a fresh process starts listening right away.
  hook.cleanup()
  process.exit(RESTART_NOW)
}

function shutdown(code) {
  try {
    speech?.stop()
    hook.stop()
    hook.cleanup()
  } catch {
    // Best effort on the way out.
  }
  try {
    overlay?.dispose()
  } catch {
    // Same.
  }
  process.exit(code)
}
