import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { BadRequest, createSelectionService } from '../src/host/service.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-selection-service-'))
after(() => rmSync(directory, { recursive: true, force: true }))

const llm = {
  listProviders: () => [{ id: 'deepseek-account' }],
  listModels: async () => [{ id: 'deepseek-flash' }],
  prepareCall: async (options) => ({ config: options, async *stream() { yield { type: 'text-delta', index: 0, text: 'ok' } } }),
}

describe('selection service (no toolbar process)', () => {
  test('settings patches merge into the current settings', async () => {
    const service = createSelectionService({ getLlm: () => llm, log: () => {}, dataDir: join(directory, 'a'), desktop: false })
    service.saveSettings({ disabledApps: ['Terminal'] })
    const saved = service.saveSettings({ toolbarSize: 3 })
    assert.deepEqual(saved.disabledApps, ['Terminal'], 'a patch without disabledApps keeps them')
    assert.equal(saved.toolbarSize, 3)
    assert.throws(() => service.saveSettings([]), BadRequest)
    await service.dispose()
  })

  test('reports an unsupported Host instead of starting the toolbar', async () => {
    const service = createSelectionService({ getLlm: () => llm, log: () => {}, dataDir: join(directory, 'b'), desktop: false })
    const { status } = service.getState()
    assert.equal(status.supported, false)
    assert.equal(status.worker, 'stopped')
    assert.throws(() => service.restartWorker(), BadRequest)
    await service.dispose()
  })

  test('model and custom-skill tests go through the model client', async () => {
    const service = createSelectionService({ getLlm: () => llm, log: () => {}, dataDir: join(directory, 'c'), desktop: false })
    const model = await service.testModel()
    assert.equal(model.ok, true)
    assert.equal(model.route.model, 'deepseek-flash')
    assert.equal((await service.testSkill({ prompt: 'Shout it', text: 'hi' })).output, 'ok')
    await assert.rejects(async () => service.testSkill({ prompt: '', text: 'hi' }), BadRequest)
    const broken = createSelectionService({ getLlm: () => undefined, log: () => {}, dataDir: join(directory, 'd'), desktop: false })
    assert.deepEqual((await broken.testModel()).error, { code: 'NO_LLM', detail: '' })
    await service.dispose()
    await broken.dispose()
  })

  test('disposing tells event subscribers to close', async () => {
    const service = createSelectionService({ getLlm: () => llm, log: () => {}, dataDir: join(directory, 'e'), desktop: false })
    const events = []
    service.subscribe((event) => events.push(event))
    await service.dispose()
    assert.deepEqual(events, ['closing'])
  })
})

/** A stand-in for the supervisor: records what the Host sends and lets a test speak as the worker. */
function fakeWorker() {
  const worker = { sent: [], restarts: 0, options: null }
  worker.start = (options) => {
    worker.options = options
    options.onState({ state: 'running', pid: 1 })
    return {
      send: (message) => worker.sent.push(message),
      restart: () => {
        worker.restarts += 1
        options.onState({ state: 'restarting', pid: null })
      },
      stop: async () => options.onState({ state: 'stopped', pid: null }),
    }
  }
  worker.emit = (message) => worker.options.onMessage(message)
  return worker
}

async function until(check, ms = 2000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('selection service with a toolbar process', () => {
  const start = (name, { getLlm = () => llm, platform = 'darwin' } = {}) => {
    const worker = fakeWorker()
    const logs = []
    const opened = []
    const service = createSelectionService({
      getLlm,
      log: (level, message, fields) => logs.push({ level, message, fields }),
      dataDir: join(directory, name),
      desktop: true,
      platform,
      startWorker: worker.start,
      openExternal: (url) => opened.push(url),
    })
    return { service, worker, logs, opened }
  }

  test('the worker gets only what it draws and how it behaves, again after every change', async () => {
    const { service, worker } = start('w-config')
    service.saveSettings({ skills: [...service.getState().settings.skills, { id: 'custom-x', custom: true, enabled: true, name: 'X', icon: 'sparkles', prompt: 'Secret prompt' }] })
    worker.sent.length = 0
    worker.emit({ type: 'hello' })
    const [{ type, config }] = worker.sent
    assert.equal(type, 'config')
    assert.deepEqual(Object.keys(config).sort(), [
      'clipboardFallback', 'disabledApps', 'enabled', 'languages', 'maxTextLength',
      'searchTemplate', 'skills', 'toolbarSize', 'toolbarStyle', 'translateTarget', 'trigger',
    ])
    assert.ok(!JSON.stringify(config).includes('Secret prompt'), 'custom prompts stay in the Host')
    assert.match(config.searchTemplate, /%s/)
    service.saveSettings({ toolbarSize: 3 })
    assert.equal(worker.sent.at(-1).config.toolbarSize, 3)
    await service.dispose()
  })

  test('a skill run streams back to the worker and the log names the route, never the text', async () => {
    const { service, worker, logs } = start('w-run')
    worker.emit({ type: 'run', requestId: 'r1', skillId: 'translate', text: 'PRIVATE-SELECTION-42' })
    await until(() => worker.sent.some((message) => message.done))
    assert.deepEqual(worker.sent.filter((message) => message.type === 'result'), [
      { type: 'result', requestId: 'r1', chunk: 'ok' },
      { type: 'result', requestId: 'r1', done: true },
    ])
    const finished = logs.find((entry) => entry.message === 'skill finished')
    assert.equal(finished.fields.provider, 'deepseek-account')
    assert.equal(finished.fields.model, 'deepseek-flash')
    assert.ok(!JSON.stringify(logs).includes('PRIVATE-SELECTION-42'))
    await service.dispose()
  })

  test('an unknown skill comes back as a coded failure', async () => {
    const { service, worker } = start('w-unknown')
    worker.emit({ type: 'run', requestId: 'r2', skillId: 'no-such-skill', text: 'x' })
    await until(() => worker.sent.some((message) => message.requestId === 'r2'))
    assert.deepEqual(worker.sent.find((message) => message.requestId === 'r2'), {
      type: 'result', requestId: 'r2', error: { code: 'MODEL_FAILED', detail: 'unknown skill: no-such-skill' }, done: true,
    })
    await service.dispose()
  })

  test('cancelling a run, or restarting the worker, stops answers in flight without reporting them', async () => {
    const started = []
    const hanging = {
      ...llm,
      prepareCall: async (options) => ({
        config: options,
        async *stream({ signal }) {
          started.push(signal)
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        },
      }),
    }
    const { service, worker, logs } = start('w-cancel', { getLlm: () => hanging })
    worker.emit({ type: 'run', requestId: 'a', skillId: 'translate', text: 'x' })
    worker.emit({ type: 'run', requestId: 'b', skillId: 'explain', text: 'x' })
    await until(() => started.length === 2)
    worker.emit({ type: 'cancel', requestId: 'a' })
    service.restartWorker()
    await until(() => logs.filter((entry) => entry.message === 'skill cancelled').length === 2)
    assert.equal(worker.restarts, 1)
    assert.deepEqual(worker.sent.filter((message) => message.type === 'result'), [])
    await service.dispose()
  })

  test('recent apps are newest first, without duplicates, and capped', async () => {
    const { service, worker } = start('w-recent')
    for (const app of ['Safari', 'Notes', 'Safari', '', 7]) worker.emit({ type: 'selection', app })
    assert.deepEqual(service.getState().recentApps, ['Safari', 'Notes'])
    for (let i = 0; i < 20; i++) worker.emit({ type: 'selection', app: `App ${i}` })
    assert.equal(service.getState().recentApps.length, 12)
    assert.equal(service.getState().recentApps[0], 'App 19')
    await service.dispose()
  })

  test('a style switched on the toolbar is saved, ignoring unknown styles, and sent back to the worker', async () => {
    const { service, worker } = start('w-style')
    const events = []
    service.subscribe((event, data) => events.push([event, data]))
    for (const style of ['tiny', 7, 'mini']) worker.emit({ type: 'toolbar-style', style })
    assert.equal(service.getState().settings.toolbarStyle, 'mini')
    assert.equal(worker.sent.at(-1).config.toolbarStyle, 'mini')
    assert.ok(events.some(([event, data]) => event === 'settings' && data.toolbarStyle === 'mini'), 'the settings page follows')
    await service.dispose()
  })

  test('disabling an app from the toolbar saves it once and tells the settings page', async () => {
    const { service, worker } = start('w-disable')
    const events = []
    service.subscribe((event, data) => events.push([event, data]))
    for (const app of ['Terminal', 'Terminal', '', 42]) worker.emit({ type: 'disable-app', app })
    assert.deepEqual(service.getState().settings.disabledApps, ['Terminal'])
    assert.ok(events.some(([event, data]) => event === 'settings' && data.disabledApps.includes('Terminal')))
    await service.dispose()
  })

  test('status follows the worker process, the permission and the hook', async () => {
    const { service, worker } = start('w-status')
    assert.equal(service.getState().status.worker, 'running')
    assert.equal(service.getState().status.permission, 'unknown')
    worker.emit({ type: 'permission', trusted: false })
    assert.equal(service.getState().status.permission, 'denied')
    worker.emit({ type: 'permission', trusted: true })
    worker.emit({ type: 'ready', hookStarted: true })
    assert.equal(service.getState().status.permission, 'granted')
    assert.equal(service.getState().status.hook, true)
    await service.dispose()
    assert.equal(service.getState().status.worker, 'stopped')
  })

  test('"More settings" opens the page inside DSH; the permission button opens System Settings', async () => {
    const { service, worker, opened } = start('w-open')
    const events = []
    service.subscribe((event, data) => events.push([event, data]))
    worker.emit({ type: 'open-settings' })
    assert.deepEqual(events, [['navigate', { panel: 'dsh-selection' }]])
    assert.deepEqual(opened, ['dsh://open'])
    service.openPermissionSettings()
    assert.match(opened.at(-1), /^x-apple\.systempreferences:.*Privacy_Accessibility$/)
    await service.dispose()
  })

  test('worker log lines are forwarded with their level and fields', async () => {
    const { service, worker, logs } = start('w-log')
    worker.emit({ type: 'log', level: 'debug', message: 'overlay dismissed', fields: { reason: 'escape' } })
    assert.deepEqual(logs.at(-1), { level: 'debug', message: 'worker: overlay dismissed', fields: { reason: 'escape' } })
    await service.dispose()
  })

  test('Windows needs no permission; other desktops do not start the toolbar', async () => {
    const windows = start('w-win32', { platform: 'win32' })
    assert.equal(windows.service.getState().status.permission, 'granted')
    assert.throws(() => windows.service.openPermissionSettings(), BadRequest)
    await windows.service.dispose()
    const linux = start('w-linux', { platform: 'linux' })
    assert.equal(linux.service.getState().status.supported, false)
    assert.equal(linux.worker.options, null, 'no worker was started')
    await linux.service.dispose()
  })

  test('custom-skill tests tell the model who is answering', async () => {
    const requests = []
    const named = {
      ...llm,
      listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
      prepareCall: async (options) => ({
        config: options,
        async *stream(request) {
          requests.push(request)
          yield { type: 'text-delta', index: 0, text: 'ok' }
        },
      }),
    }
    const { service } = start('w-identity', { getLlm: () => named })
    const result = await service.testSkill({ prompt: 'Who are you?', text: 'hi' })
    assert.equal(result.route.modelName, 'DeepSeek-V4.1-Flash')
    assert.match(requests[0].system, /generated by the model DeepSeek-V4\.1-Flash\./)
    await service.dispose()
  })
})
