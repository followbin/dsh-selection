// The Host half: owns settings, the worker process and model calls, and answers the settings page.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './files.mjs'
import { fileURLToPath } from 'node:url'
import { CUSTOM_SKILL_ICONS, ICONS } from '../shared/icons.mjs'
import { openWithSystem } from '../shared/open-with-system.mjs'
import { dataDirectory } from '../shared/paths.mjs'
import { ModelError, createModelClient } from './llm.mjs'
import {
  BUILTIN_SKILLS, CAPTURE_ACTIONS, LANGUAGES, LIMITS, SEARCH_ENGINES,
  createSettingsStore, defaultSettings, enabledSkills, findSkill, searchTemplate,
} from './settings.mjs'
import { buildRequest } from './skills.mjs'
import { createCaptureService } from '../capture/host/capture.mjs'
import { BUILTIN_ACTION_ICONS, CUSTOM_ACTION_ICONS } from '../capture/shared/icons.mjs'
import { startWorker } from './supervisor.mjs'
import { createUsageStore } from './usage.mjs'

const WORKER_PATH = fileURLToPath(new URL('../worker/main.mjs', import.meta.url))
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])
const RECENT_APPS = 12
const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

export class BadRequest extends Error {}

/**
 * @param {{
 *   getLlm: () => any,
 *   getAttachments?: () => any,
 *   log: (level: string, message: string, fields?: object) => void,
 *   dataDir?: string,
 *   desktop: boolean,
 *   promptForPermission?: boolean,
 *   platform?: string,
 *   startWorker?: typeof startWorker,
 *   openExternal?: (url: string) => void,
 *   localePreference?: string,
 * }} options `desktop` is false when the Host is not on the user's machine (e.g. a remote web Host).
 *   Tests replace `platform`, `startWorker` and `openExternal`. `getAttachments` is DSH's attachment
 *   store, which screenshots go through to reach a vision model.
 */
export function createSelectionService({
  getLlm, getAttachments = () => null, log, localePreference, dataDir = dataDirectory(), desktop, promptForPermission = true,
  platform = process.platform, startWorker: launchWorker = startWorker, openExternal = (url) => openWithSystem(url, log),
}) {
  const settings = createSettingsStore({ file: join(dataDir, 'settings.json'), log })
  // The language DSH's interface shows; the toolbar and the screenshot pages follow it. The
  // DSH client reports its active language (it alone knows the browser's choice when no
  // language is set explicitly); until it does, DSH's saved preference stands, then the last
  // report, kept on disk so a restarted Host starts in the right language.
  const localeFile = join(dataDir, 'ui-locale.json')
  let reportedLocale = null
  let preferredLocale = uiLocaleOf(localePreference)
  let savedLocale = null
  try { savedLocale = uiLocaleOf(JSON.parse(readFileSync(localeFile, 'utf8')).locale) } catch { /* no report yet */ }
  const uiLocale = () => reportedLocale ?? preferredLocale ?? savedLocale ?? (settings.get().nativeLanguage.startsWith('zh') ? 'zh' : 'en')
  const model = createModelClient({ getLlm, log })
  const usage = createUsageStore({ file: join(dataDir, 'usage.json'), log })
  const subscribers = new Set()
  const runs = new Map()
  const recentApps = []
  const status = {
    platform,
    supported: desktop && SUPPORTED_PLATFORMS.has(platform),
    worker: 'stopped',
    permission: platform === 'darwin' ? 'unknown' : 'granted',
    hook: false,
    capture: null,
    uiLocale: null,
  }

  const worker = status.supported
    ? launchWorker({
      workerPath: WORKER_PATH,
      args: promptForPermission ? [] : ['--no-prompt'],
      log,
      onMessage: handleWorkerMessage,
      onState: ({ state }) => {
        // Answers in flight belong to the panel of the process that just went away.
        if (state !== 'starting' && state !== 'running') abortRuns()
        setStatus({ worker: state })
      },
    })
    : null
  if (!status.supported) log('info', 'selection toolbar not started', { platform, desktop })

  // Screenshots: their own worker process, the same settings, usage, events and permission page.
  const capture = createCaptureService({
    getLlm,
    getAttachments,
    log,
    dataDir: join(dataDir, 'capture'),
    supported: status.supported,
    platform,
    settings,
    recordUsage: (key, route, counts) => recordUsage(key, route, counts),
    onStatus: (next) => setStatus({ capture: next }),
    // A region dragged out on the capture overlay must not be read as a text selection.
    onCapturing: (active) => worker?.send({ type: 'suspend', on: active }),
    startWorker: launchWorker,
    openExternal,
    uiLocale,
  })
  status.capture = capture.status()
  status.uiLocale = uiLocale()
  capture.setOpenSettings(() => openSettingsPage())

  let modelChoice = JSON.stringify(settings.get().model)
  const unsubscribe = settings.onChange((next) => {
    worker?.send({ type: 'config', config: workerConfig(next) })
    // With no language reported, the native language decides, so it can move with the settings.
    if (uiLocale() !== status.uiLocale) setStatus({ uiLocale: uiLocale() })
    if (JSON.stringify(next.model) !== modelChoice) {
      modelChoice = JSON.stringify(next.model)
      model.invalidate()
    }
    emit('settings', next)
  })

  function abortRuns() {
    for (const controller of runs.values()) controller.abort()
    runs.clear()
  }

  function recordUsage(skill, route, counts) {
    usage.record({ skill, route, usage: counts })
    emit('usage', usage.summary())
  }

  function emit(event, data) {
    for (const subscriber of subscribers) subscriber(event, data)
  }

  function setStatus(patch) {
    Object.assign(status, patch)
    emit('status', status)
  }

  /** What the worker needs: no prompts or model details, only what to draw and how to behave. */
  function workerConfig(current) {
    return {
      enabled: current.enabled,
      trigger: current.trigger,
      toolbarSize: current.toolbarSize,
      toolbarStyle: current.toolbarStyle,
      skills: enabledSkills(current),
      disabledApps: current.disabledApps,
      clipboardFallback: current.clipboardFallback,
      maxTextLength: current.maxTextLength,
      searchTemplate: searchTemplate(current),
      translateTarget: current.translateTarget,
      languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
      locale: uiLocale(),
    }
  }

  /** The interface language changed: both worker pages and the settings page hear of it. */
  function applyUiLocale() {
    const next = uiLocale()
    if (next === status.uiLocale) return
    worker?.send({ type: 'config', config: workerConfig(settings.get()) })
    // Only called once construction is done, so the screenshot service exists.
    capture.refreshConfig()
    setStatus({ uiLocale: next })
  }

  function handleWorkerMessage(message) {
    switch (message?.type) {
      case 'hello':
        worker?.send({ type: 'config', config: workerConfig(settings.get()) })
        break
      case 'ready':
        setStatus({ hook: Boolean(message.hookStarted) })
        break
      case 'permission':
        setStatus({ permission: message.trusted ? 'granted' : 'denied' })
        break
      case 'selection':
        rememberApp(message.app)
        break
      case 'run':
        void runSkill(message)
        break
      case 'cancel':
        runs.get(message.requestId)?.abort()
        break
      case 'toolbar-style':
        if (message.style === 'full' || message.style === 'mini') {
          try {
            settings.update((current) => ({ ...current, toolbarStyle: message.style }))
          } catch (error) {
            log('error', 'saving settings failed', { error: String(error?.message ?? error) })
          }
        }
        break
      case 'disable-app':
        if (typeof message.app === 'string' && message.app) {
          try {
            const saved = settings.update((current) => ({ ...current, disabledApps: [...current.disabledApps, message.app] }))
            if (saved.disabledApps.includes(message.app)) log('info', 'app disabled from toolbar', { app: message.app })
            else log('warn', 'app not disabled: the list is full', { app: message.app, limit: LIMITS.disabledApps })
          } catch (error) {
            log('error', 'saving settings failed', { error: String(error?.message ?? error) })
          }
        }
        break
      case 'open-settings':
        openSettingsPage()
        break
      case 'log':
        log(message.level ?? 'info', `worker: ${message.message}`, message.fields ?? {})
        break
    }
  }

  function rememberApp(app) {
    if (typeof app !== 'string' || !app) return
    const index = recentApps.indexOf(app)
    if (index !== -1) recentApps.splice(index, 1)
    recentApps.unshift(app)
    recentApps.length = Math.min(recentApps.length, RECENT_APPS)
  }

  async function runSkill({ requestId, skillId, text, language, question, history }) {
    const current = settings.get()
    const controller = new AbortController()
    runs.set(requestId, controller)
    const started = Date.now()
    let outputChars = 0
    let route = null
    try {
      const skill = findSkill(current, skillId)
      if (!skill || (skill.kind !== 'prompt' && skill.kind !== 'ask')) throw new ModelError('MODEL_FAILED', `unknown skill: ${skillId}`)
      const input = {
        text: String(text ?? '').slice(0, current.maxTextLength),
        language: typeof language === 'string' ? language : undefined,
        question: typeof question === 'string' ? question.slice(0, 2000) : undefined,
        history: sanitizeHistory(history),
      }
      const prompt = (resolved) => {
        route = resolved
        return buildRequest(skill, current, { ...input, model: resolved.modelName })
      }
      const onUsage = (counts) => recordUsage(skillId, route, counts)
      for await (const chunk of model.stream({ settings: current, prompt, signal: controller.signal, onUsage })) {
        outputChars += chunk.length
        worker?.send({ type: 'result', requestId, chunk })
      }
      worker?.send({ type: 'result', requestId, done: true })
      log('info', 'skill finished', { skill: skillId, ...routeFields(route), ms: Date.now() - started, inputChars: String(text ?? '').length, outputChars })
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ModelError)) {
        log('info', 'skill cancelled', { skill: skillId, ms: Date.now() - started })
        return
      }
      const failure = toFailure(error)
      worker?.send({ type: 'result', requestId, error: failure, done: true })
      log('warn', 'skill failed', { skill: skillId, ...routeFields(route), ...failure, ms: Date.now() - started })
    } finally {
      if (runs.get(requestId) === controller) runs.delete(requestId)
    }
  }

  /** Runs one request to the end for the settings page's test buttons; the stream's own silence limits apply. */
  async function collect(skill, build, current) {
    const controller = new AbortController()
    const started = Date.now()
    let route = null
    const prompt = (resolved) => {
      route = resolved
      return build(resolved)
    }
    try {
      let output = ''
      const onUsage = (counts) => recordUsage(skill, route, counts)
      for await (const chunk of model.stream({ settings: current, prompt, signal: controller.signal, onUsage })) output += chunk
      return { ok: true, output, ms: Date.now() - started, route }
    } catch (error) {
      return { ok: false, error: toFailure(error), ms: Date.now() - started }
    }
  }

  function openSettingsPage() {
    emit('navigate', { panel: 'dsh-selection' })
    // The page is open inside DSH; bring the window forward so the user sees it.
    openExternal('dsh://open')
  }

  return {
    getState() {
      return {
        settings: settings.get(),
        defaults: defaultSettings(),
        status,
        recentApps: [...recentApps],
        catalog: {
          builtins: BUILTIN_SKILLS,
          languages: LANGUAGES,
          searchEngines: SEARCH_ENGINES,
          icons: ICONS,
          customIcons: CUSTOM_SKILL_ICONS,
          limits: LIMITS,
          capture: {
            actions: CAPTURE_ACTIONS,
            icons: { ...BUILTIN_ACTION_ICONS, ...CUSTOM_ACTION_ICONS },
            customIcons: Object.keys(CUSTOM_ACTION_ICONS),
          },
        },
      }
    },
    /** Applies the changed fields only, so edits made meanwhile from the toolbar are not overwritten. */
    saveSettings(patch) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new BadRequest('settings must be an object')
      return settings.update((current) => ({ ...current, ...patch }))
    },
    resetSettings: () => settings.reset(),
    getUsage: () => usage.summary(),
    resetUsage() {
      usage.reset()
      const summary = usage.summary()
      emit('usage', summary)
      return summary
    },
    /** DSH's model providers changed (sign-in, sign-out, a new API key). */
    invalidateModels() {
      model.invalidate()
      capture.invalidateModels()
    },
    async listModels() {
      try {
        const routes = await model.listRoutes({ fresh: true })
        const selected = routes.length ? await model.resolveRoute(settings.get()) : null
        return { routes, selected }
      } catch (error) {
        return { routes: [], selected: null, error: toFailure(error) }
      }
    },
    /** Sends one short translation through the selected route; the settings page shows the outcome. */
    testModel() {
      const current = settings.get()
      return collect('model-test', () => buildRequest(findSkill(current, 'translate'), { ...current, translateTarget: 'en' }, { text: '你好，世界' }), current)
    },
    /** Runs a draft custom skill against sample text without saving it. */
    testSkill(input) {
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim().slice(0, LIMITS.customPrompt) : ''
      const text = typeof input?.text === 'string' ? input.text.trim().slice(0, 2000) : ''
      if (!prompt || !text) throw new BadRequest('prompt and text are required')
      const current = settings.get()
      const skill = { id: 'custom-test', kind: 'prompt', custom: true, prompt }
      return collect('skill-test', (route) => buildRequest(skill, current, { text, model: route.modelName }), current)
    },
    restartWorker() {
      if (!worker) throw new BadRequest('the selection toolbar is not supported on this Host')
      worker.restart()
    },
    openPermissionSettings() {
      if (platform !== 'darwin') throw new BadRequest('only macOS needs an accessibility grant')
      openExternal(ACCESSIBILITY_SETTINGS_URL)
    },
    /**
     * The DSH client's active interface language, reported by client.js.
     * @param {unknown} input `{ locale }`, a BCP 47-style tag such as "zh" or "en-US".
     */
    reportLocale(input) {
      const locale = uiLocaleOf(input?.locale)
      if (!locale) throw new BadRequest('locale must be a language tag')
      reportedLocale = locale
      if (locale !== savedLocale) {
        savedLocale = locale
        try { writeFileAtomic(localeFile, `${JSON.stringify({ locale })}\n`) } catch (error) {
          log('warn', 'saving the interface language failed', { error: String(error?.message ?? error) })
        }
      }
      applyUiLocale()
      return { locale }
    },
    /** DSH's saved language preference changed (absent: the client's browser decides). */
    setLocalePreference(preference) {
      preferredLocale = uiLocaleOf(preference)
      applyUiLocale()
    },
    /** Screenshot operations for the settings page (see src/host/http.mjs). */
    capture: {
      start: () => capture.trigger(),
      listModels: () => capture.listModels(),
      testModel: () => capture.testModel(),
      testAction: (input) => capture.testAction(input, BadRequest),
      openFolder: () => capture.openSaveFolder(),
      chooseFolder: () => capture.chooseSaveFolder(),
      openPermissionSettings() {
        if (platform !== 'darwin') throw new BadRequest('only macOS needs a screen-recording grant')
        capture.openPermissionSettings()
      },
      restart: () => capture.restart(),
    },
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    async dispose() {
      unsubscribe()
      await capture.dispose()
      abortRuns()
      usage.flush()
      emit('closing', {})
      subscribers.clear()
      await worker?.stop()
    },
  }
}

/** The pages are translated into Chinese and English; any other language reads English. */
function uiLocaleOf(tag) {
  if (typeof tag !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return null
  return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history.slice(-6)
    .filter((turn) => typeof turn?.answer === 'string' && (typeof turn.question === 'string' || typeof turn.skillId === 'string'))
    .map((turn) => ({
      ...(typeof turn.question === 'string' ? { question: turn.question.slice(0, 2000) } : { skillId: turn.skillId.slice(0, 64) }),
      ...(typeof turn.language === 'string' ? { language: turn.language.slice(0, 16) } : {}),
      answer: turn.answer.slice(0, 6000),
    }))
}

/** Which route answered, for the log: ids only. */
function routeFields(route) {
  return route ? { provider: route.provider, model: route.model } : {}
}

function toFailure(error) {
  if (error instanceof ModelError) return { code: error.code, detail: error.detail.slice(0, 300) }
  return { code: 'MODEL_FAILED', detail: String(error?.message ?? error).slice(0, 300) }
}
