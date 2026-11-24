// Screenshots, Host side: the capture worker's lifetime, the screen-recording grant, the model
// calls behind the AI actions, and what happens to a finished capture. Settings, usage and the
// event stream belong to the selection service, which owns this one and passes them in.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemShortcutFor } from './system-shortcuts.mjs'
import { createVisionClient, VisionError } from './vision.mjs'
import { actionPrompt, customPrompt, replyLanguageFor, systemPrompt } from './prompts.mjs'
import { copyImage, copyText } from './clipboard.mjs'
import { BLOCKED, FROM_WORKER, TO_WORKER } from '../shared/protocol.mjs'

const WORKER_PATH = fileURLToPath(new URL('../worker/main.mjs', import.meta.url))
const PROBE_PATH = fileURLToPath(new URL('../worker/access-probe.mjs', import.meta.url))
/** A small rendered card with known text: what the settings page's model test reads back. */
const TEST_CARD = fileURLToPath(new URL('../../../assets/test-card.png', import.meta.url))
/** After asking for access, how often and for how long it is read again. */
const PERMISSION_POLL_MS = 2000
const PERMISSION_WATCH_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 5000
const ACCESS_STATES = new Set(['granted', 'denied', 'not-determined'])
/** A second ask this soon after the last one (a double press) shows nothing new. */
const ASK_GAP_MS = 1500
/** Restarts in a row for a grant that a fresh process still cannot use, before giving up. */
const MAX_GRANT_RESTARTS = 2
/** A capture that fails again this soon after a restart is not retried a second time. */
const RETRY_GAP_MS = 10_000
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
/** Earlier exchanges sent with a follow-up; older ones are dropped, the image never is. */
const MAX_HISTORY_TURNS = 12
const MAX_QUESTION_CHARS = 2000

/** Filename stamp: local date and time, safe on every filesystem. */
const stamp = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

/** Failure as the settings page and the answer panel show it. */
function toFailure(error) {
  return { code: error instanceof VisionError ? error.code : 'MODEL_FAILED', detail: String(error?.detail ?? error?.message ?? error).slice(0, 300) }
}

/**
 * Read this app's screen-recording access in a new process (worker/access-probe.mjs): macOS answers
 * every process from what it first read, so only a new one sees a change made since.
 * @returns {Promise<{ state: string, live: boolean }>}
 */
export function probeScreenAccess() {
  const env = { ...process.env }
  // The DSH Host is Electron in Node mode; the probe reuses that executable, which must stay in Node mode.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE_PATH], { env, timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) { reject(error); return }
      try {
        resolve(JSON.parse(String(stdout).trim()))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

/** What the capture worker needs: the shortcut, the interface language and the AI row. */
function workerConfig(settings, locale) {
  return { hotkey: settings.capture.hotkey, locale, actions: settings.capture.actions }
}

/**
 * @param {{
 *   getLlm: () => any,
 *   getAttachments: () => any,
 *   log: (level: string, message: string, fields?: object) => void,
 *   dataDir: string,
 *   supported: boolean,
 *   platform: string,
 *   settings: { get: () => any, update: (change: (current: any) => any) => any, onChange: (listener: (next: any) => void) => () => void },
 *   recordUsage: (key: string, route: object, counts: object) => void,
 *   onStatus: (status: object) => void,
 *   onCapturing: (active: boolean) => void,
 *   startWorker: Function,
 *   openExternal: (url: string) => void,
 *   uiLocale: () => string,
 *   probeAccess?: typeof probeScreenAccess,
 * }} options `onCapturing` reports the capture overlay going up and down, so the selection
 *   toolbar can stop reading selections meanwhile (a region drag is not a text selection).
 *   `probeAccess` reads the screen-recording access on macOS; tests replace it.
 */
export function createCaptureService({
  getLlm, getAttachments, log, dataDir, supported, platform, settings, recordUsage, onStatus, onCapturing,
  startWorker: launchWorker, openExternal, uiLocale, probeAccess = probeScreenAccess,
}) {
  const config = (current) => workerConfig(current, uiLocale())
  const vision = createVisionClient({ getLlm, getAttachments, log })
  const state = {
    supported,
    worker: 'stopped',
    permission: platform === 'darwin' ? 'unknown' : 'granted',
    displays: 0,
    hotkey: null,
  }
  let worker = null
  /** What the running worker read when it started, and whether it can capture (see worker/main.mjs). */
  let workerAccess = { state: 'unknown', live: true, process: platform !== 'darwin' }
  /** The probe in flight, which callers meanwhile share. */
  let probing = null
  let lastAsk = 0
  let watchTimer = null
  let watchUntil = 0
  let grantRestarts = 0
  let lastRetry = 0
  /** A restart this service asked for and whose worker is not ready yet. */
  let restartPending = false
  /** When a capture, or the system prompt, was put off until the restarted worker is ready; or 0. */
  let retriggerAt = 0
  let requestAt = 0
  /** In-flight model calls by panel id, so a regenerate cancels the previous reply. */
  const inflight = new Map()

  const publish = () => onStatus({ ...state })
  const setState = (patch) => { Object.assign(state, patch); publish() }

  function start() {
    if (worker || !supported || !settings.get().capture.enabled) return
    worker = launchWorker({
      workerPath: WORKER_PATH,
      args: [`--config=${JSON.stringify(config(settings.get()))}`],
      log,
      onMessage: handleWorkerMessage,
      onState: ({ state: next }) => {
        if (next === 'stopped' || next === 'failed') restartPending = false
        if (next !== 'starting' && next !== 'running') abortAnswers()
        setState({ worker: next, ...(next === 'running' ? {} : { hotkey: null }) })
      },
    })
  }

  async function stop() {
    stopWatch()
    retriggerAt = 0
    requestAt = 0
    restartPending = false
    abortAnswers()
    const current = worker
    worker = null
    await current?.stop()
    onCapturing(false)
  }

  let lastModel = JSON.stringify(settings.get().capture.model)
  const unsubscribe = settings.onChange((next) => {
    if (!next.capture.enabled) { void stop(); return }
    if (!worker) { start(); return }
    worker.send({ type: TO_WORKER.SETTINGS, settings: config(next) })
    const model = JSON.stringify(next.capture.model)
    if (model !== lastModel) { lastModel = model; vision.invalidate() }
  })

  function abortAnswers() {
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
  }

  async function applyHotkeyStatus(status) {
    if (!status || typeof status !== 'object') return
    setState({
      hotkey: {
        spec: status.spec ?? null,
        registered: Boolean(status.registered),
        reason: status.reason ?? null,
        listening: Boolean(status.listening),
        system: await systemShortcutFor(status.spec ?? ''),
      },
    })
  }

  function handleWorkerMessage(message) {
    switch (message?.type) {
      case 'log':
        log(message.level ?? 'info', `capture worker: ${message.message}`, message.fields ?? {})
        return
      case FROM_WORKER.READY: {
        state.displays = message.displays ?? state.displays
        log('info', 'capture worker ready', { permission: message.permission, displays: message.displays, hotkey: message.hotkey })
        worker?.send({ type: TO_WORKER.SETTINGS, settings: config(settings.get()) })
        void applyHotkeyStatus(message.hotkey)
        restartPending = false
        takeWorkerAccess(message.permission)
        // What was put off for a fresh process happens now, unless it is stale.
        const now = Date.now()
        if (retriggerAt && now - retriggerAt < RETRY_GAP_MS) worker?.send({ type: TO_WORKER.TRIGGER })
        if (requestAt && now - requestAt < RETRY_GAP_MS && workerAccess.state === 'not-determined') worker?.send({ type: TO_WORKER.REQUEST_PERMISSION })
        retriggerAt = 0
        requestAt = 0
        publish()
        return
      }
      case FROM_WORKER.PERMISSION:
        takeWorkerAccess(message)
        return
      case FROM_WORKER.HOTKEY:
        void applyHotkeyStatus(message)
        return
      case FROM_WORKER.DISPLAYS:
        setState({ displays: message.count ?? state.displays })
        return
      case FROM_WORKER.CAPTURING:
        onCapturing(Boolean(message.active))
        return
      case FROM_WORKER.CANCELLED:
        if (message.reason) log('info', 'capture did not start', { reason: message.reason })
        if (message.reason === BLOCKED.NO_PERMISSION || message.reason === BLOCKED.CAPTURE_FAILED) void captureBlocked(message.reason)
        return
      case FROM_WORKER.ASK:
        void answer(message)
        return
      case FROM_WORKER.PIN_ACTION:
        void pinAction(message).catch((error) =>
          log('error', 'pin action failed', { action: message.action, error: String(error?.message ?? error) }))
        return
      case FROM_WORKER.CLIPBOARD_TEXT:
        void copyText(String(message.text ?? '')).catch((error) =>
          log('warn', 'copying text failed', { error: String(error?.message ?? error) }))
        return
      case FROM_WORKER.OPEN_SETTINGS:
        openSettings?.()
        return
      case FROM_WORKER.CAPTURED:
        handleCapture(message).catch((error) => log('error', 'capture handling failed', { error: String(error?.message ?? error) }))
        return
      default:
    }
  }

  function savePng(png) {
    const current = settings.get()
    mkdirSync(current.capture.saveDir, { recursive: true })
    const prefix = current.nativeLanguage.startsWith('zh') ? '截图' : 'Screenshot'
    const file = join(current.capture.saveDir, `${prefix} ${stamp()}.png`)
    writeFileSync(file, png)
    return file
  }

  async function handleCapture(message) {
    const png = Buffer.from(message.png, 'base64')
    log('info', 'capture finished', { action: message.action, bytes: png.length })
    // 'done' (the check button, or Enter) means the same as copy: finishing a capture puts
    // it on the clipboard, which is where a screenshot is pasted from next.
    if (message.action === 'copy' || message.action === 'done') await copyImage(png)
    else if (message.action === 'save') log('info', 'capture saved', { file: savePng(png) })
  }

  /** One pin's toolbar asked for something only the Host can do. */
  async function pinAction(message) {
    const png = Buffer.from(message.png, 'base64')
    if (message.action === 'copy') await copyImage(png)
    else if (message.action === 'save') log('info', 'pin saved', { file: savePng(png) })
  }

  /**
   * The model-facing turns for one panel's conversation. The first user turn is the action's
   * instruction (or the typed question); later turns are verbatim.
   */
  function turnsFor(request, current) {
    const first = actionPrompt(String(request.action ?? 'ask'), current, String(request.question ?? '').slice(0, MAX_QUESTION_CHARS))
    const history = Array.isArray(request.history) ? request.history : []
    if (history.length === 0) return [{ role: 'user', text: first }]
    // history[0] answers the first turn; each later entry is a follow-up and its answer.
    const turns = [{ role: 'user', text: first }, { role: 'assistant', text: String(history[0].answer ?? '') }]
    for (const entry of history.slice(1).slice(-MAX_HISTORY_TURNS)) {
      turns.push({ role: 'user', text: String(entry.question ?? '').slice(0, MAX_QUESTION_CHARS) }, { role: 'assistant', text: String(entry.answer ?? '') })
    }
    turns.push({ role: 'user', text: String(request.followUp ?? '').slice(0, MAX_QUESTION_CHARS) })
    return turns
  }

  /** Stream one answer back to the panel that asked, by panel id. */
  async function answer(message) {
    const png = Buffer.from(message.png, 'base64')
    const id = message.id
    const current = settings.get()
    const followUp = Array.isArray(message.history) && message.history.length > 0
    const usageKey = `capture:${followUp ? 'followUp' : String(message.action ?? 'ask')}`
    inflight.get(id)?.abort()
    const controller = new AbortController()
    inflight.set(id, controller)
    const started = Date.now()
    try {
      const chunks = vision.ask({
        png,
        system: systemPrompt(current),
        turns: turnsFor(message, current),
        model: modelChoice(current),
        signal: controller.signal,
        onUsage: (route, counts) => recordUsage(usageKey, route, counts),
      })
      for await (const text of chunks) {
        if (controller.signal.aborted) return
        worker?.send({ type: TO_WORKER.ANSWER_CHUNK, id, text })
      }
      worker?.send({ type: TO_WORKER.ANSWER_END, id })
      log('info', 'capture answer finished', { action: message.action, ms: Date.now() - started })
    } catch (error) {
      if (controller.signal.aborted) return
      const { code, detail } = toFailure(error)
      log('warn', 'vision request failed', { code, detail })
      worker?.send({ type: TO_WORKER.ANSWER_FAIL, id, code, detail })
    } finally {
      if (inflight.get(id) === controller) inflight.delete(id)
    }
  }

  const modelChoice = (current) => (current.capture.model.provider && current.capture.model.model ? current.capture.model : null)

  /** The worker's report from its start: as fresh as a probe at that moment. */
  function takeWorkerAccess(report) {
    if (!report || typeof report !== 'object') return
    workerAccess = { state: String(report.state ?? 'unknown'), live: report.live !== false, process: Boolean(report.process) }
    setState({ permission: workerAccess.state })
    if (workerAccess.process) grantRestarts = 0
    if (workerAccess.process && workerAccess.state === 'granted') stopWatch()
  }

  /**
   * The access read in a new process. Callers while it runs share its reading; null when the
   * probe fails. A grant the running worker cannot use (it started without one) restarts it, a
   * bounded number of times in a row.
   * @returns {Promise<{ state: string, live: boolean } | null>}
   */
  function readAccess() {
    if (platform !== 'darwin') return Promise.resolve({ state: 'granted', live: true })
    if (probing) return probing
    probing = probeAccess().then((answer) => {
      if (!ACCESS_STATES.has(answer?.state)) throw new Error(`unexpected probe answer ${JSON.stringify(answer)}`)
      const reading = { state: answer.state, live: answer.live !== false }
      noteAccess(reading)
      return reading
    }).catch((error) => {
      log('warn', 'reading the screen-recording access failed', { error: String(error?.message ?? error) })
      return null
    }).finally(() => { probing = null })
    return probing
  }

  function noteAccess(reading) {
    setState({ permission: reading.state })
    if (reading.state !== 'granted') return
    if (workerAccess.process) { stopWatch(); return }
    if (!worker || restartPending || grantRestarts >= MAX_GRANT_RESTARTS) return
    grantRestarts += 1
    log('info', 'restarting the capture worker so it can use the new screen-recording grant')
    restartWorker()
  }

  function restartWorker() {
    if (restartPending || !worker) return
    restartPending = true
    worker.restart()
  }

  /**
   * A capture this process could not take. The moment to ask: the user just said what they wanted,
   * so the system prompt or the settings pane is expected rather than unexplained. A grant this
   * process cannot use, or a revocation it did not see, means a new process captures instead.
   */
  async function captureBlocked(reason) {
    const reading = await readAccess()
    if (!reading) return
    if (reading.state === 'granted') restartAndCapture(reason)
    else askForPermission(reading)
  }

  /**
   * Ask for access as `reading` found it. Never answered: the system prompt, shown by a worker that
   * read the same at its start (another one is restarted first, as its process would not prompt).
   * Denied: the Screen Recording pane, as the system never prompts again. Without TCC's record
   * the two cannot be told apart, so both.
   */
  function askForPermission(reading, { force = false } = {}) {
    if (!worker || platform !== 'darwin' || reading.state === 'granted') return
    const now = Date.now()
    if (!force && now - lastAsk < ASK_GAP_MS) return
    lastAsk = now
    const prompt = reading.state === 'not-determined' || !reading.live
    log('info', 'asking for screen-recording access', { access: reading.state, prompt, pane: reading.state === 'denied' })
    if (reading.state === 'denied') openExternal(SCREEN_RECORDING_SETTINGS_URL)
    if (prompt && workerAccess.state === reading.state) worker.send({ type: TO_WORKER.REQUEST_PERMISSION })
    else if (prompt) { requestAt = now; restartWorker() }
    watch()
  }

  /** Read the access every few seconds for a while, so a grant reaches a capturing process without a press. */
  function watch() {
    watchUntil = Date.now() + PERMISSION_WATCH_MS
    if (watchTimer) return
    watchTimer = setInterval(() => {
      if (Date.now() > watchUntil) stopWatch()
      else void readAccess()
    }, PERMISSION_POLL_MS)
  }

  function stopWatch() {
    clearInterval(watchTimer)
    watchTimer = null
  }

  /** A new process can capture where this one cannot: restart it and capture once it is up. */
  function restartAndCapture(reason) {
    const now = Date.now()
    if (now - lastRetry < RETRY_GAP_MS) {
      log('warn', 'capture failed again right after a restart', { reason })
      return
    }
    lastRetry = now
    retriggerAt = now
    log('info', 'restarting the capture worker and capturing again', { reason })
    // A grant just read may already have restarted it; the capture waits for that one.
    restartWorker()
  }

  let openSettings = null
  start()
  if (!supported) log('info', 'screenshots not started', { platform })

  return {
    status: () => ({ ...state }),
    /** Resend the worker its configuration (the interface language changed). */
    refreshConfig() { worker?.send({ type: TO_WORKER.SETTINGS, settings: config(settings.get()) }) },
    /** Called when the capture worker asks for the settings page. */
    setOpenSettings(fn) { openSettings = fn },
    /** Start a capture now, as if the shortcut had been pressed. */
    trigger() {
      if (!worker) return { ok: false, reason: supported ? 'disabled' : 'unsupported' }
      if (!workerAccess.process) {
        // Same moment as a shortcut press this process cannot capture.
        void captureBlocked(BLOCKED.NO_PERMISSION)
        return state.permission === 'granted' ? { ok: true } : { ok: false, reason: BLOCKED.NO_PERMISSION }
      }
      worker.send({ type: TO_WORKER.TRIGGER })
      return { ok: true }
    },
    /** Ask for screen-recording access: the system prompt if it was never answered, else the settings pane. */
    async requestPermission() {
      const reading = await readAccess()
      if (reading) askForPermission(reading, { force: true })
    },
    /** Read the access again; the answer arrives as a status update. */
    checkPermission() {
      void readAccess()
    },
    async listModels() {
      try {
        const routes = await vision.imageRoutes({ fresh: true })
        const chosen = modelChoice(settings.get())
        const selected = routes.length === 0 ? null
          : (chosen && routes.find((r) => r.provider === chosen.provider && r.model === chosen.model)) || routes[0]
        return { routes, selected }
      } catch (error) {
        return { routes: [], selected: null, error: toFailure(error) }
      }
    },
    /** Read the bundled test card back through the chosen route. */
    async testModel() {
      const started = Date.now()
      try {
        const current = settings.get()
        const route = await vision.resolveRoute(modelChoice(current))
        let output = ''
        for await (const text of vision.ask({
          png: readFileSync(TEST_CARD),
          system: systemPrompt(current),
          turns: [{ role: 'user', text: actionPrompt('ocr', current) }],
          model: modelChoice(current),
          signal: AbortSignal.timeout(90_000),
          onUsage: (used, counts) => recordUsage('capture:modelTest', used, counts),
        })) output += text
        return { ok: true, route, output: output.trim(), ms: Date.now() - started }
      } catch (error) {
        return { ok: false, error: toFailure(error), ms: Date.now() - started }
      }
    },
    /**
     * Run a draft instruction once, as a custom action would, on the image the page sent
     * (PNG, JPEG or WebP, base64) or on the bundled test card.
     * @param {{ prompt?: string, image?: string }} input
     */
    async testAction(input, BadRequest) {
      const instruction = String(input?.prompt ?? '').trim()
      if (!instruction || instruction.length > 4000) throw new BadRequest('the instruction is empty or too long')
      const started = Date.now()
      try {
        const current = settings.get()
        const image = typeof input.image === 'string' && input.image ? Buffer.from(input.image, 'base64') : readFileSync(TEST_CARD)
        let output = ''
        for await (const text of vision.ask({
          png: image,
          system: systemPrompt(current),
          turns: [{ role: 'user', text: customPrompt(instruction, replyLanguageFor(current)) }],
          model: modelChoice(current),
          signal: AbortSignal.timeout(120_000),
          onUsage: (used, counts) => recordUsage('capture:actionTest', used, counts),
        })) output += text
        return { ok: true, output: output.trim(), ms: Date.now() - started }
      } catch (error) {
        return { ok: false, error: toFailure(error), ms: Date.now() - started }
      }
    },
    /** Show the save folder in Finder / Explorer. */
    openSaveFolder() {
      const dir = settings.get().capture.saveDir
      mkdirSync(dir, { recursive: true })
      openExternal(dir)
    },
    /** Ask the system for a folder; resolves to the saved settings, or null when cancelled. */
    chooseSaveFolder() {
      return new Promise((resolve) => {
        const done = (error, stdout) => resolve(error ? null : String(stdout).trim() || null)
        if (platform === 'darwin') {
          execFile('osascript', ['-e', 'POSIX path of (choose folder)'], { timeout: 300_000 }, done)
        } else if (platform === 'win32') {
          // UTF-8 output, or a Chinese folder name comes back in the legacy code page.
          const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; '
            + '$d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'
          execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 300_000, windowsHide: true, encoding: 'utf8' }, done)
        } else resolve(null)
      }).then((dir) => (dir
        ? settings.update((current) => ({ ...current, capture: { ...current.capture, saveDir: dir.replace(/[\\/]$/, '') || dir } }))
        : null))
    },
    invalidateModels: () => vision.invalidate(),
    restart() {
      if (!worker) start()
      else worker.restart()
    },
    async dispose() {
      unsubscribe()
      await stop()
    },
    /** Developer prompt lab support: the vision client and the data directory it runs in. */
    lab: { dataDir },
  }
}
