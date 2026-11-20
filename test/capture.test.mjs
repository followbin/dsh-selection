import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createSelectionService } from '../src/host/service.mjs'
import { canonicalHotkey, defaultSettings, normalizeSettings } from '../src/host/settings.mjs'
import { actionPrompt, systemPrompt } from '../src/capture/host/prompts.mjs'
import { createHotkey } from '../src/capture/worker/hotkey.mjs'
import { personHolds, shortcutArgs } from '../src/capture/worker/modifiers.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-selection-capture-'))
after(() => rmSync(directory, { recursive: true, force: true }))

/** A one-pixel PNG: enough for the attachment store fake, which never decodes it. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

async function until(check, ms = 2000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Both worker processes through one launcher, told apart by their path. */
function fakeWorkers() {
  const workers = { selection: null, capture: null }
  workers.start = (options) => {
    const which = options.workerPath.includes('/capture/') ? 'capture' : 'selection'
    const entry = { options, sent: [], stopped: false, restarts: 0 }
    workers[which] = entry
    options.onState({ state: 'running', pid: which === 'capture' ? 2 : 1 })
    return {
      send: (message) => entry.sent.push(message),
      restart() { entry.restarts += 1 },
      stop: async () => { entry.stopped = true; options.onState({ state: 'stopped', pid: null }) },
    }
  }
  return workers
}

/** DSH's llm and attachments services, with one image-capable route. */
function fakeServices() {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async () => [
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { id: 'deepseek-vision', name: 'DeepSeek Vision', inputModalities: ['text', 'image'] },
    ],
    prepareCall: async (options) => ({
      config: options,
      async *stream(request) {
        calls.push({ model: options.model, system: request.system, messages: request.messages })
        yield { type: 'reasoning-delta', index: 0, text: 'thinking that must not be shown' }
        yield { type: 'text-delta', index: 1, text: '图里' }
        yield { type: 'text-delta', index: 1, text: '是一张表' }
        yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 12 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const attachments = { saveImages: async (images) => images.map((image, index) => ({ attachmentId: `sha256:${index}`, mediaType: image.mediaType })) }
  return { llm, attachments, calls }
}

function createService(name, { desktop = true, workers = fakeWorkers(), services = fakeServices() } = {}) {
  const service = createSelectionService({
    getLlm: () => services.llm,
    getAttachments: () => services.attachments,
    log: () => {},
    dataDir: join(directory, name),
    desktop,
    platform: 'darwin',
    startWorker: workers.start,
    openExternal: () => {},
  })
  return { service, workers, services }
}

describe('screenshot settings', () => {
  test('default to Alt+D, the four built-in actions and the automatic vision route', () => {
    const { capture } = defaultSettings()
    assert.equal(capture.enabled, true)
    assert.equal(capture.hotkey, 'Alt+D')
    assert.deepEqual(capture.actions.map((action) => action.id), ['ocr', 'translate', 'explain', 'ask'])
    assert.deepEqual(capture.model, { provider: '', model: '' })
  })

  test('store one spelling per shortcut and refuse ones without a modifier', () => {
    assert.equal(canonicalHotkey('Meta+Shift+2'), 'Shift+Meta+2')
    assert.equal(canonicalHotkey('cmd+shift+a'), 'Shift+Meta+A')
    assert.equal(canonicalHotkey('Alt+Left'), 'Alt+Left')
    assert.equal(canonicalHotkey('D'), null)
    assert.equal(canonicalHotkey('Meta+Shift+@'), null)
    assert.equal(normalizeSettings({ capture: { hotkey: 'D' } }).capture.hotkey, 'Alt+D', 'an invalid shortcut falls back to the default')
  })

  test('keep custom actions with a known icon, drop unknown ids, and append missing built-ins', () => {
    const { actions } = normalizeSettings({
      capture: {
        actions: [
          { id: 'custom-tbl1', name: '转成表格', icon: 'table', prompt: '整理成 Markdown 表格' },
          { id: 'custom-odd1', name: '奇怪图标', icon: 'nope', prompt: 'x' },
          { id: 'ask', enabled: false },
          { id: 'evil' },
          { id: 'ask', enabled: true },
        ],
      },
    }).capture
    assert.deepEqual(actions.map((action) => [action.id, action.enabled, action.icon ?? null]), [
      ['custom-tbl1', true, 'table'], ['custom-odd1', true, 'sparkles'], ['ask', false, null],
      ['ocr', true, null], ['translate', true, null], ['explain', true, null],
    ])
  })

  test('fall back to the default folder for a relative save path', () => {
    assert.equal(normalizeSettings({ capture: { saveDir: 'relative/dir' } }).capture.saveDir, defaultSettings().capture.saveDir)
  })
})

describe('screenshot prompts', () => {
  const settings = defaultSettings()

  test('name the reply language from the shared language settings', () => {
    assert.match(systemPrompt(settings), /Reply in Simplified Chinese/)
    assert.match(actionPrompt('explain', { ...settings, answerLanguage: 'ja' }), /^Explain this screenshot in Japanese\./)
    assert.match(actionPrompt('explain', { ...settings, answerLanguage: 'source' }), /in the language of the text in the screenshot \(Simplified Chinese when it has none\)/)
  })

  test('translate between the native language and English unless a target is set', () => {
    assert.match(actionPrompt('translate', settings), /into Simplified Chinese\. If it is already written in Simplified Chinese, translate it into English instead/)
    assert.match(actionPrompt('translate', { ...settings, nativeLanguage: 'en' }), /into English\. If it is already written in English, translate it into Simplified Chinese instead/)
    assert.match(actionPrompt('translate', { ...settings, translateTarget: 'ja' }), /into Japanese\. If it is already written in Japanese, translate it into Simplified Chinese instead/)
  })

  test('send a custom action\'s own instruction, and explain for an action that no longer exists', () => {
    const custom = { ...settings, capture: { ...settings.capture, actions: [...settings.capture.actions, { id: 'custom-tbl1', custom: true, enabled: true, name: '表格', icon: 'table', prompt: '整理成表格' }] } }
    assert.match(actionPrompt('custom-tbl1', custom), /^Apply this instruction to the screenshot: 整理成表格/)
    assert.match(actionPrompt('custom-gone', custom), /^Explain this screenshot/)
    assert.equal(actionPrompt('ask', custom, '这是什么？'), '这是什么？')
  })
})

describe('screenshot process under the selection service', () => {
  test('starts with the shortcut, language and AI row, and gets every later change', async () => {
    const { service, workers } = createService('start')
    const config = JSON.parse(workers.capture.options.args[0].slice('--config='.length))
    assert.equal(config.hotkey, 'Alt+D')
    assert.equal(config.locale, 'zh', 'before DSH reports its language, the native language decides')
    assert.deepEqual(config.actions.map((action) => action.id), ['ocr', 'translate', 'explain', 'ask'])
    service.saveSettings({ capture: { ...service.getState().settings.capture, hotkey: 'Control+Alt+S' } })
    const last = workers.capture.sent.at(-1)
    assert.equal(last.type, 'settings')
    assert.equal(last.settings.hotkey, 'Control+Alt+S')
    await service.dispose()
  })

  test('both processes follow DSH\'s interface language: its saved preference, then what the client reports', async () => {
    const workers = fakeWorkers()
    const service = createSelectionService({
      getLlm: () => null, log: () => {}, dataDir: join(directory, 'locale'), desktop: true, platform: 'darwin',
      startWorker: workers.start, openExternal: () => {}, localePreference: 'en-US',
    })
    assert.equal(JSON.parse(workers.capture.options.args[0].slice('--config='.length)).locale, 'en')
    assert.equal(service.getState().status.uiLocale, 'en')
    service.reportLocale({ locale: 'zh' })
    assert.equal(workers.capture.sent.at(-1).settings.locale, 'zh')
    assert.equal(workers.selection.sent.at(-1).config.locale, 'zh')
    assert.equal(service.getState().status.uiLocale, 'zh')
    assert.throws(() => service.reportLocale({ locale: 'not a tag!' }))
    await service.dispose()
    // A restarted Host starts in the last reported language until the client reports again.
    const again = createSelectionService({
      getLlm: () => null, log: () => {}, dataDir: join(directory, 'locale'), desktop: true, platform: 'darwin',
      startWorker: fakeWorkers().start, openExternal: () => {},
    })
    assert.equal(again.getState().status.uiLocale, 'zh')
    await again.dispose()
  })

  test('turning screenshots off stops the process, and on starts it again', async () => {
    const { service, workers } = createService('toggle')
    const first = workers.capture
    service.saveSettings({ capture: { ...service.getState().settings.capture, enabled: false } })
    await until(() => first.stopped)
    assert.equal(service.getState().status.capture.worker, 'stopped')
    service.saveSettings({ capture: { ...service.getState().settings.capture, enabled: true } })
    assert.notEqual(workers.capture, first, 'a new process')
    assert.equal(service.getState().status.capture.worker, 'running')
    await service.dispose()
  })

  test('the selection toolbar stops reading selections while the capture overlay is up', async () => {
    const { service, workers } = createService('suspend')
    workers.capture.options.onMessage({ type: 'capturing', active: true })
    assert.deepEqual(workers.selection.sent.at(-1), { type: 'suspend', on: true })
    workers.capture.options.onMessage({ type: 'capturing', active: false })
    assert.deepEqual(workers.selection.sent.at(-1), { type: 'suspend', on: false })
    await service.dispose()
  })

  test('granting Accessibility restarts the screenshot process once, so its shortcut listener starts', async () => {
    const { service, workers } = createService('grant')
    workers.selection.options.onMessage({ type: 'permission', trusted: false, prompted: true })
    assert.equal(workers.capture.restarts, 0)
    workers.selection.options.onMessage({ type: 'permission', trusted: true })
    assert.equal(workers.capture.restarts, 1)
    // The toolbar process restarts after the grant and reports it again.
    workers.selection.options.onMessage({ type: 'permission', trusted: true })
    assert.equal(workers.capture.restarts, 1)
    await service.dispose()
  })

  test('the shortcut\'s registration reaches the status the settings page reads', async () => {
    const { service, workers } = createService('hotkey')
    workers.capture.options.onMessage({ type: 'hotkey', spec: 'Alt+D', registered: false, reason: 'taken', listening: true })
    await until(() => service.getState().status.capture.hotkey !== null)
    assert.deepEqual(
      (({ spec, registered, reason, listening }) => ({ spec, registered, reason, listening }))(service.getState().status.capture.hotkey),
      { spec: 'Alt+D', registered: false, reason: 'taken', listening: true },
    )
    await service.dispose()
  })

  test('an AI action streams only the reply to its panel, through the image-capable route, counted as a screenshot action', async () => {
    const { service, workers, services } = createService('answer')
    workers.capture.options.onMessage({ type: 'ask', id: 'f1', action: 'ocr', question: '', history: [], png: PNG.toString('base64') })
    await until(() => workers.capture.sent.some((message) => message.type === 'answer-end'))
    const text = workers.capture.sent.filter((message) => message.type === 'answer-chunk').map((message) => message.text).join('')
    assert.equal(text, '图里是一张表', 'reasoning deltas never reach the panel')
    assert.equal(services.calls[0].model, 'deepseek-vision')
    assert.equal(services.calls[0].messages[0].content[0].type, 'image')
    assert.match(services.calls[0].messages[0].content[1].text, /^Extract all the text in this screenshot\./)
    await until(() => service.getUsage().periods.today.skills.length > 0)
    assert.deepEqual(service.getUsage().periods.today.skills.map((row) => row.skill), ['capture:ocr'])
    await service.dispose()
  })

  test('a follow-up carries the earlier turns, the image staying with the first one', async () => {
    const { service, workers, services } = createService('follow-up')
    workers.capture.options.onMessage({
      type: 'ask', id: 'f2', action: 'explain', question: '', png: PNG.toString('base64'),
      history: [{ question: null, answer: '这是一张图表' }], followUp: '最高的是哪个？',
    })
    await until(() => services.calls.length === 1)
    const { messages } = services.calls[0]
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user'])
    assert.equal(messages[0].content[0].type, 'image')
    assert.equal(messages[1].content[0].text, '这是一张图表')
    assert.equal(messages[2].content[0].text, '最高的是哪个？')
    await service.dispose()
  })

  test('a Host that is not on the user\'s desktop starts neither process', async () => {
    const { service, workers } = createService('remote', { desktop: false })
    assert.equal(workers.capture, null)
    assert.equal(service.getState().status.capture.supported, false)
    await service.dispose()
  })
})

describe('capture process', () => {
  /** selection-hook as far as the shortcut uses it, reporting a fixed Accessibility state. */
  function fakeHook(trusted) {
    const made = { started: 0 }
    class Hook {
      on() {}
      off() {}
      start() { made.started += 1; return true }
      stop() {}
      macIsProcessTrusted() { return trusted }
    }
    return { load: () => Hook, made }
  }

  test('on macOS the shortcut listener starts only once DSH has the Accessibility grant', () => {
    const quiet = { onTrigger() {}, log() {}, spec: 'Alt+D', platform: 'darwin' }
    const untrusted = fakeHook(false)
    const before = createHotkey({ ...quiet, load: untrusted.load })
    assert.deepEqual([before.status().listening, untrusted.made.started], [false, 0])
    before.dispose()
    const trusted = fakeHook(true)
    const after = createHotkey({ ...quiet, load: trusted.load })
    assert.deepEqual([after.status().listening, trusted.made.started], [true, 1])
    after.dispose()
  })

  test('a page\'s shortcut runs only when the keyboard holds the modifier it carries', () => {
    const holding = (meta, ctrl) => ({ heldModifiers: () => ({ meta, ctrl }) })
    assert.equal(personHolds(holding(true, false), { meta: true }), true)
    assert.equal(personHolds(holding(false, false), { meta: true }), false, 'a copy another app posts')
    assert.equal(personHolds(holding(true, false), { ctrl: true }), false)
    assert.equal(personHolds({}, { meta: true }), false, 'a platform that cannot tell says no')
    assert.deepEqual(shortcutArgs({ key: 'c', shift: 1 }), ['c', true])
    assert.deepEqual(shortcutArgs({ key: 'x'.repeat(40) }), ['x'.repeat(8), false])
  })
})
