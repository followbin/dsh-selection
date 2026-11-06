// The settings page from client.js, rendered with React in jsdom. Requests go through the real
// HTTP handler and selection service in-process; only the worker, the LLM and the clock are fakes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import vm from 'node:vm'
import { JSDOM, VirtualConsole } from 'jsdom'
import React from 'react'
import { createHttpHandler } from '../src/host/http.mjs'
import { createSelectionService } from '../src/host/service.mjs'
import { LANGUAGES, LIMITS, defaultSettings } from '../src/host/settings.mjs'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const ORIGIN = 'http://127.0.0.1:4100'
const API = '/dsh-selection/api'
const NS = 'dshSelection'
const PANEL = 'dsh-selection'

// ---------- Browser environment ----------

const jsdomErrors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => {
  // jsdom's CSS parser cannot read every rule of the page's stylesheet; that is not a page error.
  if (!/Could not parse CSS stylesheet/.test(error.message)) jsdomErrors.push(error)
})
const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}/`, virtualConsole })
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act } = React
// react-dom decides at import time whether it runs in a browser, so it loads after the globals exist.
const { createRoot } = await import('react-dom/client')

const consoleErrors = []
console.error = (...args) => consoleErrors.push(format(...args))
const unhandledRejections = []
process.on('unhandledRejection', (reason) => unhandledRejections.push(reason))

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
const DEFAULT_LAYOUT = ['翻译', '总结', '解释', '问问 DSH', '朗读', '|', '复制', '润色', '搜索']
const TABLE_SKILL = Object.freeze({ id: 'custom-table01', custom: true, enabled: true, name: '整理成表格', icon: 'list', prompt: '把这段内容整理成 Markdown 表格。' })

// ---------- Client side: clock, DSH context, module loader ----------

/** Timers seen by client.js only: debounces and reconnect delays run when a test advances time. */
function createClock() {
  const timers = new Map()
  let now = 0
  let nextId = 1
  return {
    setTimeout(callback, ms = 0, ...args) {
      const id = nextId++
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), callback, args })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer }
        if (!next) break
        timers.delete(next.id)
        now = next.timer.at
        next.timer.callback(...next.timer.args)
        await settle()
      }
      now = end
    },
  }
}

/** The parts of DSH's client context that client.js uses, recording what it registers. */
function createContext(language) {
  const ctx = {
    language,
    effects: [],
    injected: [],
    registrations: [],
    dictionaries: new Map(),
    layout: { selected: [], selectPanel: (id) => ctx.layout.selected.push(id) },
    effect(execute, label) {
      const dispose = execute()
      ctx.effects.push({ label, dispose })
      return dispose
    },
    slots: {
      inject(name, callback) {
        ctx.injected.push(name)
        return callback()
      },
      register(options, component) {
        const entry = { options, component }
        ctx.registrations.push(entry)
        return () => {
          const index = ctx.registrations.indexOf(entry)
          if (index !== -1) ctx.registrations.splice(index, 1)
        }
      },
    },
    locale: {
      register(namespace, dictionaries) {
        ctx.dictionaries.set(namespace, dictionaries)
        return () => ctx.dictionaries.delete(namespace)
      },
      bind: (namespace) => (key) => ctx.dictionaries.get(namespace)?.[ctx.language]?.[key] ?? key,
    },
    get(name) {
      if (name === 'layout') return ctx.layout
      throw new Error(`no ${name} service`)
    },
    dispose() {
      for (const { dispose } of ctx.effects.splice(0).reverse()) dispose?.()
    },
  }
  return ctx
}

const clientSource = readFileSync(CLIENT, 'utf8')
const runClient = vm.compileFunction(clientSource, ['window', 'fetch', 'setTimeout', 'clearTimeout'], { filename: CLIENT })

/** Runs client.js the way DSH's renderer does and builds the plugin from the factory it registered. */
function loadClient(clock) {
  const loaded = []
  window.__ModuleLoader__ = { load: (module) => loaded.push(module) }
  try {
    runClient(window, (...args) => window.fetch(...args), clock.setTimeout, clock.clearTimeout)
  } finally {
    delete window.__ModuleLoader__
  }
  assert.equal(loaded.length, 1, 'client.js registers one module')
  const [{ id, factory }] = loaded
  const required = []
  const plugin = factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`client.js required an unexpected module: ${name}`)
  })
  return { id, plugin, required }
}

// ---------- Host side: real service and HTTP handler behind a fetch ----------

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
  worker.setState = (state) => worker.options.onState({ state, pid: state === 'running' ? 1 : null })
  return worker
}

/** DSH's `llm` service as the model client sees it, with answers a test can delay or fail. */
function fakeLlm() {
  const llm = {
    available: true,
    providers: [
      { id: 'deepseek-account', displayName: 'DeepSeek 账号', models: [{ id: 'deepseek-flash', displayName: 'DeepSeek Flash' }, { id: 'deepseek-pro', displayName: 'DeepSeek Pro' }] },
      { id: 'openai', displayName: 'OpenAI', models: [{ id: 'gpt-x', displayName: 'GPT-X' }] },
    ],
    reply: ['Hello', ', world'],
    usage: { inputTokens: 1200, outputTokens: 34 },
    failure: null,
    calls: [],
    gate: null,
  }
  llm.service = {
    listProviders: () => llm.providers.map(({ id, displayName }) => ({ id, displayName })),
    listModels: async (id) => llm.providers.find((provider) => provider.id === id)?.models ?? [],
    prepareCall: async (options) => ({
      config: options,
      async *stream(request) {
        llm.calls.push({ provider: options.provider, model: options.model, system: request.system, user: request.messages[0].content[0].text })
        await llm.gate?.promise
        if (llm.failure) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: llm.failure } } }
          return
        }
        for (const text of llm.reply) yield { type: 'text-delta', text }
        if (llm.usage) yield { type: 'usage', usage: llm.usage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  llm.hold = () => {
    let release
    llm.gate = { promise: new Promise((resolve) => { release = resolve }) }
    llm.release = () => {
      llm.gate = null
      release()
    }
    return llm.release
  }
  return llm
}

function createHost({ dataDir, llm, desktop, platform, connection }) {
  const worker = fakeWorker()
  const opened = []
  const logs = []
  const log = (level, message, fields) => logs.push({ level, message, fields })
  const service = createSelectionService({
    getLlm: () => (llm.available ? llm.service : undefined),
    log,
    dataDir,
    desktop,
    platform,
    startWorker: worker.start,
    openExternal: (url) => opened.push(url),
  })
  let subscriptions = 0
  const handler = createHttpHandler({
    ...service,
    subscribe(listener) {
      const unsubscribe = service.subscribe(listener)
      let active = true
      subscriptions += 1
      return () => {
        if (active) subscriptions -= 1
        active = false
        return unsubscribe()
      }
    },
  }, { log, connection })

  const requests = []
  const rules = []
  const streams = new Set()
  const releases = new Set()
  const encoder = new TextEncoder()

  function takeRule(method, path) {
    const index = rules.findIndex((rule) => rule.method === method && rule.path === path)
    if (index === -1) return null
    const rule = rules[index]
    rule.times -= 1
    if (rule.times <= 0) rules.splice(index, 1)
    return rule
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input), ORIGIN)
    const method = init.method ?? 'GET'
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname
    const body = typeof init.body === 'string' ? init.body : undefined
    requests.push({ method, path, body: body === undefined ? undefined : JSON.parse(body) })
    const rule = takeRule(method, path)
    if (rule?.hold) await rule.hold
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
    if (rule?.unreachable) throw new TypeError('Failed to fetch')
    if (rule?.status) return new Response(JSON.stringify(rule.body), { status: rule.status, headers: { 'content-type': 'application/json' } })
    return serve(url, method, init, body)
  }

  // Like a browser fetch: resolves once headers arrive, streams the body, and errors it on abort.
  function serve(url, method, init, body) {
    return new Promise((resolve, reject) => {
      let controller
      let open = true
      const stream = new ReadableStream({ start: (c) => { controller = c } })
      const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
      Object.assign(req, {
        method,
        url: url.pathname + url.search,
        headers: { host: url.host, 'sec-fetch-site': 'same-origin', ...(method === 'GET' ? {} : { origin: ORIGIN }), ...headers },
      })
      const connection = {
        write(chunk) {
          if (open) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
          return true
        },
        end(chunk) {
          if (!open) return
          if (chunk) connection.write(chunk)
          open = false
          streams.delete(connection)
          controller.close()
        },
        drop() {
          req.emit('close')
          connection.end()
        },
      }
      const res = {
        writeHead: (status, head) => resolve(new Response(stream, { status, headers: head })),
        write: connection.write,
        end: connection.end,
        on: () => res,
      }
      if (url.pathname.endsWith('/events')) streams.add(connection)
      init.signal?.addEventListener('abort', () => {
        const error = new DOMException('This operation was aborted', 'AbortError')
        req.emit('close')
        if (open) {
          open = false
          streams.delete(connection)
          controller.error(error)
        }
        reject(error)
      }, { once: true })
      handler(req, res).catch(reject)
    })
  }

  return {
    service,
    worker,
    opened,
    logs,
    requests,
    fetch,
    subscriptions: () => subscriptions,
    openStreams: () => streams.size,
    /** The next `times` requests fail like a browser fetch that cannot connect. */
    unreachable: (method, path, times = 1) => rules.push({ method, path, times, unreachable: true }),
    respond: (method, path, status, body) => rules.push({ method, path, times: 1, status, body }),
    /** Keeps the next matching request waiting until the returned function is called. */
    hold(method, path) {
      let release
      const hold = new Promise((resolve) => { release = resolve })
      rules.push({ method, path, times: 1, hold })
      releases.add(release)
      return release
    },
    write: (chunk) => { for (const stream of streams) stream.write(chunk) },
    drop: () => { for (const stream of [...streams]) stream.drop() },
    async close() {
      for (const release of releases) release()
      for (const stream of [...streams]) stream.drop()
      await service.dispose()
    },
  }
}

// ---------- The page ----------

const pages = []

async function openPage({ language = 'zh', desktop = true, platform = 'darwin', settings, connection, before, props } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-selection-page-'))
  const llm = fakeLlm()
  const host = createHost({ dataDir, llm, desktop, platform, connection })
  if (settings) host.service.saveSettings(settings)
  before?.(host, llm)
  const clock = createClock()
  const ctx = createContext(language)
  const container = document.createElement('div')
  document.body.append(container)
  const $ = (selector, scope = container) => scope.querySelector(selector)
  const $$ = (selector, scope = container) => [...scope.querySelectorAll(selector)]
  const skillName = (row) => $('.dss-skill-name', row).firstChild.textContent
  let putsSeen = 0

  const page = {
    dataDir, llm, host, clock, ctx, container, $, $$,
    t: ctx.locale.bind(NS),
    confirms: [],
    confirmReply: true,
    caughtErrors: [],
    otherErrors: [],

    registration: (name) => ctx.registrations.find((entry) => entry.options.name === name),
    section: (title) => $$('.dss-section').find((section) => $('.dss-section-title', section).textContent === title),
    row: (label) => $$('.dss-row').find((row) => $('.dss-label', row)?.textContent === label),
    control: (label) => $('select, input, [role="switch"]', page.row(label)),
    switchFor: (label) => $(`[role="switch"][aria-label="${label}"]`),
    checked: (label) => page.switchFor(label).getAttribute('aria-checked') === 'true',
    button: (text, scope = container) => $$('button', scope).find((button) => button.textContent.trim() === text || button.getAttribute('aria-label') === text),
    statusText: () => $('.dss-state').textContent,
    dotState: () => $('.dss-dot').dataset.state,
    skillRow: (name) => $$('.dss-skill').find((row) => skillName(row) === name),
    grip: (name) => $('.dss-grip', page.skillRow(name)),
    skillLayout: () => [...$('.dss-card', page.section(page.t('skills.title'))).children]
      .map((child) => (child.classList.contains('dss-overflow') ? '|' : skillName(child))),
    disabledApps: () => $$('.dss-chip:not(.suggest)').map((chip) => chip.firstChild.textContent),
    suggestedApps: () => $$('.dss-chip.suggest').map((chip) => chip.textContent),
    appInput: () => $(`input[placeholder="${page.t('apps.placeholder')}"]`),
    modelHint: () => $('.dss-hint', page.row(page.t('model.route')))?.textContent ?? null,
    modelOutput: () => $('.dss-output', page.section(page.t('model.title'))),
    hostSettings: () => host.service.getState().settings,
    editor() {
      const root = $('.dss-editor')
      if (!root) return null
      const [prompt, sample] = $$('textarea', root)
      return {
        root,
        name: $('input', root),
        prompt,
        sample,
        title: $('h3', root).textContent,
        icon: (key) => $(`.dss-icon-choice[aria-label="${key}"]`, root),
        pressedIcons: () => $$('.dss-icon-choice[aria-pressed="true"]', root).map((button) => button.getAttribute('aria-label')),
        output: () => $('.dss-output', root),
      }
    },

    requests: (method, path) => host.requests.filter((request) => request.method === method && request.path === path),
    /** Bodies of PUT /api/settings sent since the last call. */
    takePuts() {
      const puts = page.requests('PUT', '/settings').map((request) => request.body)
      const fresh = puts.slice(putsSeen)
      putsSeen = puts.length
      return fresh
    },
    /** Waits out the debounce, checking nothing leaves early, and returns the patches sent. */
    async save() {
      await page.advance(349)
      assert.deepEqual(page.takePuts(), [], 'nothing is sent before the debounce ends')
      await page.advance(1)
      return page.takePuts()
    },
    async expectSave(patch) {
      assert.deepEqual(await page.save(), [patch])
    },

    step: (action) => act(async () => {
      await action?.()
      await settle()
    }),
    advance: (ms) => act(async () => { await clock.advance(ms) }),
    click(element) {
      assert.ok(element, 'the element to click exists')
      return page.step(() => element.click())
    },
    type: (element, value) => page.step(() => {
      // React tracks the value it last set; the prototype setter makes the change look like typing.
      const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new window.Event('input', { bubbles: true }))
    }),
    choose: (select, value) => page.step(() => {
      select.value = value
      assert.equal(select.value, value, `the select offers ${JSON.stringify(value)}`)
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    }),
    blur: (element) => page.step(() => element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))),
    press: (element, key) => page.step(() => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))),
    async drag(type, element, dataTransfer) {
      const event = new window.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      await page.step(() => element.dispatchEvent(event))
      return event
    },

    async unmount() {
      page.unmounted = true
      await act(async () => page.root.unmount())
      await act(settle)
    },
    async dispose() {
      page.disposed = true
      await act(async () => {
        ctx.dispose()
        await settle()
      })
    },
    async close() {
      llm.release?.()
      if (!page.unmounted) await page.unmount()
      if (!page.disposed) await page.dispose()
      await act(async () => {
        await host.close()
        await settle()
      })
      container.remove()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  pages.push(page)

  window.fetch = host.fetch
  window.confirm = (message) => {
    page.confirms.push(message)
    return page.confirmReply
  }
  page.client = loadClient(clock)
  await act(async () => {
    page.client.plugin.apply(ctx)
    await settle()
  })
  page.root = createRoot(container, {
    onCaughtError: (error) => page.caughtErrors.push(error),
    onUncaughtError: (error) => page.otherErrors.push(error),
    onRecoverableError: (error) => page.otherErrors.push(error),
  })
  const main = page.registration('main').component
  await act(async () => page.root.render(React.createElement(main, props ?? { t: page.t })))
  await act(settle)
  return page
}

const optionsOf = (select) => [...select.options].map((option) => [option.value, option.textContent])
const languageOptions = LANGUAGES.map(({ code, name }) => [code, name])
const withSkill = (id, change) => defaultSettings().skills.map((skill) => (skill.id === id ? { ...skill, ...change } : skill))
const moved = (ids) => ids.map((id) => ({ id, enabled: true }))

afterEach(async () => {
  const problems = []
  for (const page of pages.splice(0)) {
    await page.close()
    problems.push(...page.caughtErrors.map((error) => `render error: ${error.message}`), ...page.otherErrors.map((error) => `React error: ${error.message}`))
  }
  problems.push(
    ...consoleErrors.splice(0).map((message) => `console.error: ${message}`),
    ...jsdomErrors.splice(0).map((error) => `jsdom: ${error.message}`),
    ...unhandledRejections.splice(0).map((reason) => `unhandled rejection: ${reason?.stack ?? reason}`),
  )
  assert.deepEqual(problems, [], 'the test left no errors behind')
})

// ---------- Tests ----------

describe('registration', () => {
  test('client.js registers one module that needs only React and asks DSH for slots and locale', async () => {
    const page = await openPage()
    assert.equal(page.client.id, 'dsh-selection')
    assert.deepEqual(page.client.required, ['react'])
    assert.deepEqual(page.client.plugin.inject, ['slots', 'locale'])
    assert.deepEqual(page.ctx.effects.map((effect) => effect.label), [
      'dsh-selection: dictionaries',
      'dsh-selection: sidebar entry',
      'dsh-selection: settings page',
      'dsh-selection: event stream',
      'dsh-selection: navigation',
    ])
  })

  test('the sidebar entry and the main panel share one id, and the entry is labelled in the current language', async () => {
    const page = await openPage()
    assert.deepEqual(page.ctx.injected, ['sidebar.panellist', 'main'])
    const { label, ...sidebar } = page.registration('sidebar.panellist').options
    assert.deepEqual(sidebar, { name: 'sidebar.panellist', id: PANEL, order: 30 })
    assert.deepEqual(page.registration('main').options, { name: 'main', key: PANEL, locale: NS })
    assert.equal(label(), '划词助手')
    page.ctx.language = 'en'
    assert.equal(label(), 'Selection assistant', 'the label is looked up each time it is drawn')
  })

  test('the sidebar icon is drawn at the requested size and in the brand color while active', async () => {
    const page = await openPage()
    const Icon = page.registration('sidebar.panellist').component
    const holder = document.createElement('div')
    document.body.append(holder)
    const root = createRoot(holder)
    try {
      await act(async () => root.render(React.createElement(Icon, { size: 22, active: true })))
      const svg = holder.querySelector('svg')
      assert.equal(svg.getAttribute('width'), '22')
      assert.equal(svg.getAttribute('aria-hidden'), 'true')
      assert.equal(svg.style.color, 'var(--dsw-alias-brand-primary)')
      await act(async () => root.render(React.createElement(Icon, {})))
      assert.equal(svg.getAttribute('width'), '18')
      assert.equal(svg.style.color, 'currentcolor')
    } finally {
      await act(async () => root.unmount())
      holder.remove()
    }
  })

  test('both dictionaries have the same keys, covering every key the page looks up', async () => {
    const page = await openPage()
    const { zh, en } = page.ctx.dictionaries.get(NS)
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
    const used = new Set([...clientSource.matchAll(/\bt\('([\w.]+)'\)/g)].map(([, key]) => key))
    for (const state of ['starting', 'running', 'restarting', 'stopped']) used.add(`status.${state}`)
    assert.ok(used.size > 50)
    assert.deepEqual([...used].filter((key) => !(key in zh)), [])
  })

  test('disposing the plugin removes the sidebar entry, the panel and the dictionaries', async () => {
    const page = await openPage()
    await page.unmount()
    await page.dispose()
    assert.deepEqual(page.ctx.registrations, [])
    assert.equal(page.ctx.dictionaries.size, 0)
  })
})

describe('loading', () => {
  test('shows only the title until /api/state answers, then every section under its tab', async () => {
    let release
    const page = await openPage({ before: (host) => { release = host.hold('GET', '/state') } })
    assert.equal(page.$('.dss-title').textContent, page.t('title'))
    assert.equal(page.$$('.dss-section').length, 0)
    await page.step(release)
    assert.deepEqual(page.$$('[role="tab"]').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]), [
      ['tab.general', 'true'], ['tab.skills', 'false'], ['tab.model', 'false'], ['tab.capture', 'false'], ['tab.apps', 'false'], ['tab.usage', 'false'],
    ].map(([key, selected]) => [page.t(key), selected]))
    const sections = (id) => page.$$('.dss-section-title', page.$(`#dss-panel-${id}`)).map((title) => title.textContent)
    assert.deepEqual(sections('general'), ['toolbar.title', 'language.title'].map(page.t))
    assert.deepEqual(sections('skills'), [page.t('skills.title')])
    assert.deepEqual(sections('model'), [page.t('model.title')])
    assert.deepEqual(sections('capture'), ['capture.title', 'search.title'].map(page.t))
    assert.deepEqual(sections('apps'), [page.t('apps.title')])
    assert.deepEqual(sections('usage'), ['usage.byModel', 'usage.bySkill'].map(page.t))
    assert.deepEqual(page.$$('[role="tabpanel"]').filter((panel) => !panel.hidden).map((panel) => panel.id), ['dss-panel-general'])
  })

  test('tabs show one group at a time, by click or by arrow keys', async () => {
    const page = await openPage()
    const tab = (id) => page.$(`#dss-tab-${id}`)
    const visible = () => page.$$('[role="tabpanel"]').filter((panel) => !panel.hidden).map((panel) => panel.id)
    await page.click(tab('usage'))
    assert.deepEqual(visible(), ['dss-panel-usage'])
    assert.equal(tab('usage').getAttribute('aria-selected'), 'true')
    assert.equal(tab('usage').tabIndex, 0)
    assert.equal(tab('general').tabIndex, -1, 'only the selected tab is in the tab order')
    await page.press(tab('usage'), 'ArrowRight')
    assert.deepEqual(visible(), ['dss-panel-general'], 'the last tab wraps to the first')
    assert.equal(tab('general').ownerDocument.activeElement, tab('general'))
    await page.press(tab('general'), 'ArrowLeft')
    assert.deepEqual(visible(), ['dss-panel-usage'])
  })

  test('renders the default settings the Host reports', async () => {
    const { t, ...page } = await openPage()
    assert.equal(page.$('.dss-sub').textContent, t('subtitle'))
    assert.equal(page.statusText(), t('status.running'))
    assert.equal(page.dotState(), 'running')
    assert.equal(page.checked(t('enabled.label')), true)
    assert.equal(page.$('.dss-section-hint', page.section(t('skills.title'))).textContent, fill(t('skills.hint'), { count: 5 }))
    assert.deepEqual(page.skillLayout(), DEFAULT_LAYOUT)
    assert.equal(page.button(t('skills.edit')), undefined, 'built-in skills cannot be edited')

    const trigger = page.control(t('toolbar.trigger'))
    assert.equal(trigger.value, 'auto')
    assert.deepEqual(optionsOf(trigger), [['auto', t('toolbar.trigger.auto')], ['modifier', t('toolbar.trigger.modifier')]])
    const size = page.control(t('toolbar.size'))
    assert.deepEqual([size.value, size.min, size.max], ['5', String(LIMITS.toolbarSize.min), String(LIMITS.toolbarSize.max)])

    const native = page.control(t('language.native'))
    assert.equal(native.value, 'zh-CN')
    assert.deepEqual(optionsOf(native), languageOptions)
    const target = page.control(t('language.translate'))
    assert.equal(target.value, 'auto')
    assert.deepEqual(optionsOf(target), [['auto', t('language.translate.auto')], ...languageOptions])
    const answer = page.control(t('language.answer'))
    assert.equal(answer.value, 'native')
    assert.deepEqual(optionsOf(answer), [['native', t('language.answer.native')], ['source', t('language.answer.source')], ...languageOptions])

    assert.equal(page.control(t('model.route')).value, '')
    assert.equal(page.$('.dss-section-hint', page.section(t('model.title'))).textContent, t('model.hint'))

    assert.equal(page.checked(t('capture.clipboard')), true)
    const max = page.control(t('capture.max'))
    assert.deepEqual([max.value, max.min, max.max], ['4000', String(LIMITS.maxTextLength.min), String(LIMITS.maxTextLength.max)])

    const engine = page.control(t('search.engine'))
    assert.equal(engine.value, 'google')
    assert.deepEqual(optionsOf(engine), [['google', 'Google'], ['bing', 'Bing'], ['baidu', '百度 Baidu'], ['duckduckgo', 'DuckDuckGo'], ['custom', t('search.custom')]])
    assert.equal(engine.options[4].disabled, true, 'custom needs a URL first')
    assert.equal(page.control(t('search.customUrl')).value, '')

    assert.equal(page.$('.dss-empty').textContent, t('apps.empty'))
    assert.deepEqual(page.suggestedApps(), [])
    assert.ok(page.button(t('footer.reset')))
    assert.ok(page.button(t('footer.restart')))
    assert.equal(page.$('.dss-footer .dss-hint').textContent, t('footer.data'))
    assert.equal(page.$('.dss-banner'), null)
  })

  test('renders saved settings rather than the defaults', async () => {
    const skills = [{ id: 'copy', enabled: true }, { id: 'translate', enabled: false }, TABLE_SKILL, ...defaultSettings().skills.filter((skill) => !['copy', 'translate'].includes(skill.id))]
    const { t, ...page } = await openPage({
      settings: {
        enabled: false, trigger: 'modifier', toolbarSize: 3, skills, disabledApps: ['Slack', 'Notes'],
        nativeLanguage: 'en', translateTarget: 'ja', answerLanguage: 'source', model: { provider: 'openai', model: 'gpt-x' },
        maxTextLength: 8000, clipboardFallback: false, searchEngine: 'custom', customSearchUrl: 'https://example.com/?q=%s',
      },
    })
    assert.equal(page.checked(t('enabled.label')), false)
    assert.equal(page.control(t('toolbar.trigger')).value, 'modifier')
    assert.equal(page.control(t('toolbar.size')).value, '3')
    assert.deepEqual(page.skillLayout(), ['复制', '翻译', '整理成表格', '总结', '|', '解释', '问问 DSH', '朗读', '润色', '搜索'])
    assert.equal(page.skillRow('翻译').dataset.enabled, 'false')
    assert.equal(page.$('.dss-tag', page.skillRow('整理成表格')).textContent, t('skills.custom'))
    assert.equal(page.control(t('language.native')).value, 'en')
    assert.equal(page.control(t('language.translate')).value, 'ja')
    assert.equal(page.control(t('language.answer')).value, 'source')
    assert.equal(page.control(t('model.route')).value, 'openai\u0000gpt-x')
    assert.equal(page.checked(t('capture.clipboard')), false)
    assert.equal(page.control(t('capture.max')).value, '8000')
    assert.equal(page.control(t('search.engine')).value, 'custom')
    assert.equal(page.control(t('search.customUrl')).value, 'https://example.com/?q=%s')
    assert.deepEqual(page.disabledApps(), ['Slack', 'Notes'])
  })

  test('follows DSH in English, built-in skill names included', async () => {
    const page = await openPage({ language: 'en' })
    assert.equal(page.$('.dss-title').textContent, 'Selection assistant')
    assert.equal(page.statusText(), 'Running')
    assert.deepEqual(page.skillLayout(), ['Translate', 'Summarize', 'Explain', 'Ask DSH', 'Read aloud', '|', 'Copy', 'Polish', 'Search'])
  })

  test('falls back to the Chinese text when DSH passes no translator', async () => {
    const page = await openPage({ props: {} })
    assert.equal(page.$('.dss-title').textContent, '划词助手')
    assert.equal(page.skillLayout()[0], '翻译')
  })

  test('says it cannot reach the Host when /api/state fails', async () => {
    const offline = await openPage({ before: (host) => host.unreachable('GET', '/state') })
    assert.equal(offline.$('.dss-error').textContent, offline.t('status.offline') + 'Failed to fetch')
    assert.equal(offline.$$('.dss-section').length, 0)

    const signedOut = await openPage({ connection: { requestRejection: () => 401 } })
    assert.equal(signedOut.$('.dss-error').textContent, signedOut.t('status.offline') + 'unauthorized')
  })

  test('a page that could not reach the Host loads as soon as the Host sends an event', async () => {
    const page = await openPage({ before: (host) => host.unreachable('GET', '/state') })
    assert.equal(page.$$('.dss-section').length, 0)
    await page.step(() => page.host.worker.setState('running'))
    await page.step()
    assert.equal(page.$('.dss-error'), null)
    assert.ok(page.$$('.dss-section').length > 0)
  })

  test('shows the render error instead of a blank panel when the state cannot be drawn', async () => {
    const page = await openPage({
      before(host) {
        const state = host.service.getState()
        host.respond('GET', '/state', 200, { ...state, catalog: { ...state.catalog, builtins: state.catalog.builtins.filter((skill) => skill.id !== 'search') } })
      },
    })
    assert.equal(page.caughtErrors.length, 1)
    assert.equal(page.$('.dss-error').textContent, page.t('error.render') + page.caughtErrors[0].message)
    page.caughtErrors.length = 0
  })
})

describe('status and permission', () => {
  test('the status line follows the toolbar process as the Host reports it', async () => {
    const page = await openPage()
    const expect = [['starting', 'idle'], ['restarting', 'error'], ['stopped', 'idle'], ['running', 'running']]
    for (const [state, dot] of expect) {
      await page.step(() => page.host.worker.setState(state))
      assert.equal(page.statusText(), page.t(`status.${state}`))
      assert.equal(page.dotState(), dot)
    }
  })

  test('a Host that cannot run the toolbar says so and offers no restart', async () => {
    const page = await openPage({ desktop: false })
    assert.equal(page.statusText(), page.t('status.unsupported'))
    assert.equal(page.dotState(), 'idle')
    assert.equal(page.button(page.t('footer.restart')), undefined)
    assert.ok(page.section(page.t('skills.title')), 'the settings stay editable')
  })

  test('on macOS a denied permission shows a banner whose button opens System Settings', async () => {
    const page = await openPage({ before: (host) => host.worker.emit({ type: 'permission', trusted: false }) })
    const banner = page.$('.dss-banner')
    assert.equal(banner.querySelector('strong').textContent, page.t('permission.title'))
    assert.equal(banner.querySelector('p').textContent, page.t('permission.body'))
    await page.click(page.button(page.t('permission.open'), banner))
    assert.deepEqual(page.requests('POST', '/permission/open').map((request) => request.body), [{}])
    assert.equal(page.host.opened.length, 1)
    assert.match(page.host.opened[0], /^x-apple\.systempreferences:.*Privacy_Accessibility$/)
    await page.step(() => page.host.worker.emit({ type: 'permission', trusted: true }))
    assert.equal(page.$('.dss-banner'), null, 'granting the permission removes the banner')
  })

  test('the banner appears when the permission is denied while the page is open', async () => {
    const page = await openPage()
    assert.equal(page.$('.dss-banner'), null, 'no banner while the permission is unknown')
    await page.step(() => page.host.worker.emit({ type: 'permission', trusted: false }))
    assert.ok(page.$('.dss-banner'))
  })

  test('Windows and Hosts without the toolbar never show the banner', async () => {
    const windows = await openPage({ platform: 'win32' })
    assert.equal(windows.$('.dss-banner'), null)
    assert.equal(windows.statusText(), windows.t('status.running'))
    const remote = await openPage({ desktop: false })
    assert.equal(remote.$('.dss-banner'), null)
  })
})

describe('saving settings', () => {
  test('changes wait for a quiet 350 ms and go out as one merged patch', async () => {
    const { t, ...page } = await openPage()
    await page.click(page.switchFor(t('enabled.label')))
    assert.equal(page.checked(t('enabled.label')), false, 'the page shows the change at once')
    await page.advance(300)
    await page.choose(page.control(t('toolbar.trigger')), 'modifier')
    await page.advance(349)
    assert.deepEqual(page.takePuts(), [], 'every change restarts the wait')
    const release = page.host.hold('PUT', '/settings')
    await page.advance(1)
    assert.deepEqual(page.takePuts(), [{ enabled: false, trigger: 'modifier' }])
    assert.equal(page.statusText(), t('status.saving'))
    await page.step(release)
    assert.equal(page.statusText(), t('status.saved'))
    assert.equal(page.hostSettings().enabled, false)
    assert.equal(page.hostSettings().trigger, 'modifier')
    await page.advance(2000)
    assert.deepEqual(page.takePuts(), [], 'nothing is sent twice')
  })

  const controls = [
    {
      name: 'the toolbar switch saves only enabled',
      change: (page) => page.click(page.switchFor(page.t('enabled.label'))),
      patch: { enabled: false },
      shown: (page) => page.checked(page.t('enabled.label')),
    },
    {
      name: 'the trigger select saves only trigger',
      change: (page) => page.choose(page.control(page.t('toolbar.trigger')), 'modifier'),
      patch: { trigger: 'modifier' },
      shown: (page) => page.control(page.t('toolbar.trigger')).value,
    },
    {
      name: 'the toolbar size field saves only toolbarSize when Enter is pressed',
      async change(page) {
        const input = page.control(page.t('toolbar.size'))
        await page.type(input, '3')
        await page.press(input, 'Enter')
      },
      patch: { toolbarSize: 3 },
      shown: (page) => Number(page.control(page.t('toolbar.size')).value),
    },
    {
      name: 'the native language select saves only nativeLanguage',
      change: (page) => page.choose(page.control(page.t('language.native')), 'ja'),
      patch: { nativeLanguage: 'ja' },
      shown: (page) => page.control(page.t('language.native')).value,
    },
    {
      name: 'the translate select saves only translateTarget',
      change: (page) => page.choose(page.control(page.t('language.translate')), 'en'),
      patch: { translateTarget: 'en' },
      shown: (page) => page.control(page.t('language.translate')).value,
    },
    {
      name: 'the answer language select saves only answerLanguage',
      change: (page) => page.choose(page.control(page.t('language.answer')), 'source'),
      patch: { answerLanguage: 'source' },
      shown: (page) => page.control(page.t('language.answer')).value,
    },
    {
      name: 'the answer language can also be a fixed language',
      change: (page) => page.choose(page.control(page.t('language.answer')), 'fr'),
      patch: { answerLanguage: 'fr' },
      shown: (page) => page.control(page.t('language.answer')).value,
    },
    {
      name: 'the clipboard switch saves only clipboardFallback',
      change: (page) => page.click(page.switchFor(page.t('capture.clipboard'))),
      patch: { clipboardFallback: false },
      shown: (page) => page.checked(page.t('capture.clipboard')),
    },
    {
      name: 'the maximum length field saves only maxTextLength when it loses focus',
      async change(page) {
        const input = page.control(page.t('capture.max'))
        await page.type(input, '8000')
        await page.blur(input)
      },
      patch: { maxTextLength: 8000 },
      shown: (page) => Number(page.control(page.t('capture.max')).value),
    },
    {
      name: 'the search engine select saves only searchEngine',
      change: (page) => page.choose(page.control(page.t('search.engine')), 'bing'),
      patch: { searchEngine: 'bing' },
      shown: (page) => page.control(page.t('search.engine')).value,
    },
  ]
  for (const control of controls) {
    test(control.name, async () => {
      const page = await openPage()
      await control.change(page)
      await page.expectSave(control.patch)
      const [[key, value]] = Object.entries(control.patch)
      assert.deepEqual(page.hostSettings()[key], value, 'the Host saved it')
      assert.deepEqual(control.shown(page), value, 'the page shows the saved value')
      assert.equal(page.statusText(), page.t('status.saved'))
    })
  }

  test('number fields round and clamp to the limits the Host reports', async () => {
    const page = await openPage()
    const size = () => page.control(page.t('toolbar.size'))
    const max = () => page.control(page.t('capture.max'))
    const commit = async (input, text) => {
      await page.type(input(), text)
      await page.blur(input())
      return page.save()
    }
    assert.deepEqual(await commit(size, '12'), [{ toolbarSize: LIMITS.toolbarSize.max }])
    assert.equal(size().value, String(LIMITS.toolbarSize.max))
    assert.deepEqual(await commit(size, '0'), [{ toolbarSize: LIMITS.toolbarSize.min }])
    assert.deepEqual(await commit(size, '2.6'), [{ toolbarSize: 3 }])
    assert.equal(size().value, '3')
    assert.deepEqual(await commit(max, '50'), [{ maxTextLength: LIMITS.maxTextLength.min }])
    assert.deepEqual(await commit(max, '99999'), [{ maxTextLength: LIMITS.maxTextLength.max }])
    assert.equal(max().value, String(LIMITS.maxTextLength.max))
    assert.equal(page.hostSettings().maxTextLength, LIMITS.maxTextLength.max)
  })

  test('a cleared number field goes back to the saved value instead of saving the minimum', async () => {
    const page = await openPage()
    const max = page.control(page.t('capture.max'))
    await page.type(max, '')
    await page.blur(max)
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.equal(page.control(page.t('capture.max')).value, '4000')
  })

  test('a number above the maximum shows the maximum even when the maximum is already saved', async () => {
    const page = await openPage({ settings: { toolbarSize: LIMITS.toolbarSize.max } })
    const size = page.control(page.t('toolbar.size'))
    await page.type(size, '12')
    await page.press(size, 'Enter')
    await page.advance(350)
    assert.equal(page.hostSettings().toolbarSize, LIMITS.toolbarSize.max)
    assert.equal(page.control(page.t('toolbar.size')).value, String(LIMITS.toolbarSize.max))
  })

  test('closing the page sends a change that was still waiting', async () => {
    const page = await openPage()
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.unmount()
    assert.deepEqual(page.takePuts(), [{ enabled: false }], 'sent right away, without waiting for the debounce')
    assert.equal(page.hostSettings().enabled, false)
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
  })

  test('the saved status hides the toolbar state only until the toolbar state changes', async () => {
    const page = await openPage()
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.advance(350)
    assert.equal(page.statusText(), page.t('status.saved'))
    await page.step(() => page.host.worker.setState('restarting'))
    assert.equal(page.statusText(), page.t('status.restarting'))
  })
})

describe('save failures', () => {
  test('a save the Host cannot write shows the error and puts back what the Host has', async () => {
    const page = await openPage()
    // A directory where settings.json goes makes the Host's atomic rename fail, like a read-only disk.
    mkdirSync(join(page.dataDir, 'settings.json', 'blocked'), { recursive: true })
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.advance(350)
    assert.deepEqual(page.takePuts(), [{ enabled: false }])
    assert.equal(page.statusText(), page.t('status.saveFailed') + 'internal error')
    assert.equal(page.checked(page.t('enabled.label')), true, 'the page reloads the settings the Host kept')
    assert.equal(page.requests('GET', '/state').length, 2)
    assert.ok(page.host.logs.some((entry) => entry.level === 'error' && entry.message === 'request failed'))
  })

  test('a save that cannot reach the Host shows the error and leaves no unhandled rejection', async () => {
    const page = await openPage()
    page.host.unreachable('PUT', '/settings')
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.advance(350)
    assert.deepEqual(page.takePuts(), [{ enabled: false }])
    assert.equal(page.statusText(), page.t('status.saveFailed') + 'Failed to fetch')
    assert.equal(page.checked(page.t('enabled.label')), true, 'the page reloads the settings the Host kept')
    await page.step()
    assert.deepEqual(unhandledRejections, [])
    assert.deepEqual(page.otherErrors, [])

    await page.click(page.switchFor(page.t('enabled.label')))
    await page.expectSave({ enabled: false })
    assert.equal(page.statusText(), page.t('status.saved'), 'the next change saves normally')
  })
})

describe('skills', () => {
  test('the menu divider comes after as many enabled skills as the toolbar holds', async () => {
    const page = await openPage({ settings: { toolbarSize: 3, skills: withSkill('summarize', { enabled: false }) } })
    assert.deepEqual(page.skillLayout(), ['翻译', '总结', '解释', '问问 DSH', '|', '朗读', '复制', '润色', '搜索'])
    assert.equal(page.skillRow('总结').dataset.enabled, 'false')
    const size = page.control(page.t('toolbar.size'))
    await page.type(size, '7')
    await page.press(size, 'Enter')
    assert.deepEqual(page.skillLayout(), ['翻译', '总结', '解释', '问问 DSH', '朗读', '复制', '润色', '搜索'], 'no divider once every enabled skill fits')
    assert.equal(page.$('.dss-section-hint', page.section(page.t('skills.title'))).textContent, fill(page.t('skills.hint'), { count: 7 }))
  })

  test('a skill switch saves the skills list and moves the divider', async () => {
    const page = await openPage()
    await page.click(page.switchFor('总结'))
    assert.deepEqual(page.skillLayout(), ['翻译', '总结', '解释', '问问 DSH', '朗读', '复制', '|', '润色', '搜索'])
    await page.expectSave({ skills: withSkill('summarize', { enabled: false }) })
    assert.deepEqual(page.hostSettings().skills, withSkill('summarize', { enabled: false }))
  })

  test('arrow keys on a skill handle move it and keep focus on it', async () => {
    const page = await openPage()
    assert.equal(page.grip('翻译').getAttribute('aria-label'), page.t('skills.move'))
    page.grip('翻译').focus()
    await page.press(page.grip('翻译'), 'ArrowUp')
    assert.deepEqual(page.skillLayout(), DEFAULT_LAYOUT, 'the first skill cannot move up')
    await page.press(page.grip('翻译'), 'ArrowDown')
    await page.press(page.grip('翻译'), 'ArrowDown')
    assert.equal(document.activeElement, page.grip('翻译'))
    assert.deepEqual(page.skillLayout(), ['总结', '解释', '翻译', '问问 DSH', '朗读', '|', '复制', '润色', '搜索'])
    await page.expectSave({ skills: moved(['summarize', 'explain', 'translate', 'ask', 'speak', 'copy', 'polish', 'search']) })
    await page.press(page.grip('搜索'), 'ArrowDown')
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [], 'the last skill cannot move down')
    await page.press(page.grip('搜索'), 'ArrowUp')
    await page.expectSave({ skills: moved(['summarize', 'explain', 'translate', 'ask', 'speak', 'copy', 'search', 'polish']) })
  })

  test('dragging a skill onto a lower row moves it below that row', async () => {
    const page = await openPage()
    const transfer = { effectAllowed: 'uninitialized', data: {}, setData(type, value) { this.data[type] = value } }
    await page.drag('dragstart', page.skillRow('翻译'), transfer)
    assert.equal(transfer.effectAllowed, 'move')
    assert.deepEqual(transfer.data, { 'text/plain': 'translate' })
    assert.equal(page.skillRow('翻译').dataset.dragging, 'true')
    const over = await page.drag('dragover', page.skillRow('问问 DSH'), transfer)
    assert.equal(over.defaultPrevented, true, 'the row accepts the drop')
    assert.equal(page.skillRow('问问 DSH').dataset.drop, 'after')
    await page.drag('drop', page.skillRow('问问 DSH'), transfer)
    await page.drag('dragend', page.skillRow('翻译'), transfer)
    assert.deepEqual(page.skillLayout(), ['总结', '解释', '问问 DSH', '翻译', '朗读', '|', '复制', '润色', '搜索'])
    assert.deepEqual(page.$$('.dss-skill[data-drop], .dss-skill[data-dragging="true"]'), [], 'drag markers are cleared')
    await page.expectSave({ skills: moved(['summarize', 'explain', 'ask', 'translate', 'speak', 'copy', 'polish', 'search']) })
  })

  test('dragging upward marks the drop above the target, and dropping a skill on itself saves nothing', async () => {
    const page = await openPage()
    const transfer = { effectAllowed: 'uninitialized', setData() {} }
    await page.drag('dragstart', page.skillRow('搜索'), transfer)
    await page.drag('dragover', page.skillRow('解释'), transfer)
    assert.equal(page.skillRow('解释').dataset.drop, 'before')
    await page.drag('dragover', page.skillRow('搜索'), transfer)
    assert.deepEqual(page.$$('.dss-skill[data-drop]'), [], 'hovering its own row marks nothing')
    await page.drag('drop', page.skillRow('搜索'), transfer)
    await page.drag('dragend', page.skillRow('搜索'), transfer)
    assert.deepEqual(page.skillLayout(), DEFAULT_LAYOUT)
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
  })

  test('a new custom skill needs a name and instructions and is saved, trimmed, at the end', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('skills.add')))
    const editor = page.editor()
    assert.equal(editor.title, page.t('editor.titleNew'))
    assert.equal(page.button(page.t('skills.add')), undefined, 'the add button makes room for the editor')
    assert.equal(editor.name.maxLength, LIMITS.customName)
    assert.equal(editor.prompt.maxLength, LIMITS.customPrompt)
    assert.deepEqual(editor.pressedIcons(), ['sparkles'])
    assert.deepEqual(page.$$('.dss-icon-choice', editor.root).map((button) => button.getAttribute('aria-label')), page.host.service.getState().catalog.customIcons)
    const save = page.button(page.t('editor.save'), editor.root)
    assert.equal(save.disabled, true)
    await page.type(editor.name, '   ')
    await page.type(editor.prompt, '  把这段内容整理成 Markdown 表格。 ')
    assert.equal(save.disabled, true, 'a blank name is not a name')
    await page.type(editor.name, ' 整理成表格 ')
    assert.equal(save.disabled, false)
    await page.click(editor.icon('list'))
    assert.deepEqual(editor.pressedIcons(), ['list'])
    await page.click(save)
    assert.equal(page.editor(), null, 'saving closes the editor')

    const [patch] = await page.save()
    assert.deepEqual(Object.keys(patch), ['skills'])
    const { id, ...created } = patch.skills.at(-1)
    assert.match(id, /^custom-[a-z0-9]{4,24}$/, 'an id the Host accepts')
    assert.deepEqual(created, { custom: true, enabled: true, name: '整理成表格', icon: 'list', prompt: '把这段内容整理成 Markdown 表格。' })
    assert.deepEqual(patch.skills.slice(0, -1), defaultSettings().skills)
    assert.deepEqual(page.hostSettings().skills.at(-1), patch.skills.at(-1), 'the Host kept it')
    assert.deepEqual(page.skillLayout(), [...DEFAULT_LAYOUT, '整理成表格'])
    const row = page.skillRow('整理成表格')
    assert.equal(page.$('.dss-tag', row).textContent, page.t('skills.custom'))
    assert.ok(page.button(page.t('skills.edit'), row))
    assert.ok(page.button(page.t('skills.delete'), row))
  })

  test('cancelling the editor saves nothing', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('skills.add')))
    await page.type(page.editor().name, '草稿')
    await page.type(page.editor().prompt, '随便写写')
    await page.click(page.button(page.t('editor.cancel'), page.editor().root))
    assert.equal(page.editor(), null)
    assert.ok(page.button(page.t('skills.add')))
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.deepEqual(page.skillLayout(), DEFAULT_LAYOUT)
  })

  test('editing a custom skill changes it in place and keeps its switch state', async () => {
    const skills = [...defaultSettings().skills.slice(0, 3), { ...TABLE_SKILL, enabled: false }, ...defaultSettings().skills.slice(3)]
    const page = await openPage({ settings: { skills } })
    await page.click(page.button(page.t('skills.edit'), page.skillRow('整理成表格')))
    const editor = page.editor()
    assert.equal(editor.title, page.t('editor.titleEdit'))
    assert.equal(editor.name.value, TABLE_SKILL.name)
    assert.equal(editor.prompt.value, TABLE_SKILL.prompt)
    assert.deepEqual(editor.pressedIcons(), ['list'])
    await page.type(editor.name, '做成表格')
    await page.click(editor.icon('quote'))
    await page.click(page.button(page.t('editor.save'), editor.root))
    const expected = skills.map((skill) => (skill.id === TABLE_SKILL.id ? { ...skill, name: '做成表格', icon: 'quote' } : skill))
    await page.expectSave({ skills: expected })
    assert.deepEqual(page.hostSettings().skills, expected)
    assert.equal(page.skillRow('做成表格').dataset.enabled, 'false')
  })

  test('deleting a custom skill asks first', async () => {
    const page = await openPage({ settings: { skills: [...defaultSettings().skills, TABLE_SKILL] } })
    const remove = () => page.button(page.t('skills.delete'), page.skillRow('整理成表格'))
    page.confirmReply = false
    await page.click(remove())
    assert.deepEqual(page.confirms, [fill(page.t('skills.deleteConfirm'), { name: '整理成表格' })])
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [], 'declining keeps the skill')
    assert.ok(page.skillRow('整理成表格'))
    page.confirmReply = true
    await page.click(remove())
    assert.equal(page.skillRow('整理成表格'), undefined)
    await page.expectSave({ skills: defaultSettings().skills })
  })

  test('Try it runs the draft against the sample text and shows the answer without saving', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('skills.add')))
    const editor = page.editor()
    const run = page.button(page.t('editor.run'), editor.root)
    assert.equal(run.disabled, true)
    await page.type(editor.prompt, '把它改写成一句口号')
    assert.equal(run.disabled, true, 'a sample is needed too')
    await page.type(editor.sample, '我们周五发布新版本')
    assert.equal(run.disabled, false)
    const release = page.llm.hold()
    await page.click(run)
    assert.equal(run.textContent, page.t('editor.running'))
    assert.equal(run.disabled, true)
    assert.deepEqual(page.requests('POST', '/skills/test').map((request) => request.body), [{ prompt: '把它改写成一句口号', text: '我们周五发布新版本' }])
    await page.step(release)
    assert.equal(run.textContent, page.t('editor.run'))
    assert.equal(editor.output().textContent, 'Hello, world')
    assert.equal(editor.output().classList.contains('error'), false)
    const [call] = page.llm.calls
    assert.match(call.system, /Instructions from the user: 把它改写成一句口号/)
    assert.equal(call.user, '<selection>\n我们周五发布新版本\n</selection>')
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [], 'trying a draft does not save it')
    assert.deepEqual(page.hostSettings().skills, defaultSettings().skills)
  })

  test('Try it shows the error when the model or the Host fails', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('skills.add')))
    const editor = page.editor()
    await page.type(editor.prompt, '总结一下')
    await page.type(editor.sample, '一段文字')
    page.llm.failure = 'rate limited'
    await page.click(page.button(page.t('editor.run'), editor.root))
    const failed = (detail) => fill(page.t('failure.detail'), { message: page.t('failure.MODEL_FAILED'), detail })
    assert.equal(editor.output().textContent, failed('rate limited'))
    assert.equal(editor.output().classList.contains('error'), true)
    page.host.unreachable('POST', '/skills/test')
    await page.click(page.button(page.t('editor.run'), editor.root))
    assert.equal(editor.output().textContent, failed('Failed to fetch'))
  })
})

describe('models', () => {
  test('lists every route DSH can call and names the one in use', async () => {
    const page = await openPage()
    const select = page.control(page.t('model.route'))
    assert.deepEqual(optionsOf(select), [
      ['', page.t('model.auto')],
      ['deepseek-account\u0000deepseek-flash', 'DeepSeek 账号 · DeepSeek Flash'],
      ['deepseek-account\u0000deepseek-pro', 'DeepSeek 账号 · DeepSeek Pro'],
      ['openai\u0000gpt-x', 'OpenAI · GPT-X'],
    ])
    assert.equal(select.value, '')
    assert.equal(page.modelHint(), fill(page.t('model.current'), { route: 'DeepSeek 账号 · DeepSeek Flash' }))
  })

  test('choosing a route saves it and then reloads the current-route hint', async () => {
    const page = await openPage()
    await page.choose(page.control(page.t('model.route')), 'openai\u0000gpt-x')
    await page.expectSave({ model: { provider: 'openai', model: 'gpt-x' } })
    const listed = page.requests('GET', '/models').length
    await page.advance(199)
    assert.equal(page.requests('GET', '/models').length, listed)
    await page.advance(1)
    assert.equal(page.requests('GET', '/models').length, listed + 1)
    assert.equal(page.modelHint(), fill(page.t('model.current'), { route: 'OpenAI · GPT-X' }))

    await page.choose(page.control(page.t('model.route')), '')
    await page.expectSave({ model: { provider: '', model: '' } })
    await page.advance(200)
    assert.equal(page.modelHint(), fill(page.t('model.current'), { route: 'DeepSeek 账号 · DeepSeek Flash' }))
  })

  test('says so when DSH has no model to call, and why the list could not be read', async () => {
    const empty = await openPage({ before: (host, llm) => { llm.providers = [] } })
    assert.equal(empty.modelHint(), empty.t('model.none'))
    assert.deepEqual(optionsOf(empty.control(empty.t('model.route'))), [['', empty.t('model.auto')]])
    const missing = await openPage({ before: (host, llm) => { llm.available = false } })
    assert.equal(missing.modelHint(), fill(missing.t('model.error'), { error: missing.t('failure.NO_LLM') }))
    const failing = await openPage({ before: (host) => host.unreachable('GET', '/models') })
    const failed = fill(failing.t('failure.detail'), { message: failing.t('failure.MODEL_FAILED'), detail: 'Failed to fetch' })
    assert.equal(failing.modelHint(), fill(failing.t('model.error'), { error: failed }))
  })

  test('the Test button shows how long the route in use took and what it answered', async () => {
    const page = await openPage({ settings: { model: { provider: 'deepseek-account', model: 'deepseek-pro' } } })
    page.llm.reply = ['  Hello', ', world\n']
    const release = page.llm.hold()
    const button = page.button(page.t('model.test'))
    await page.click(button)
    assert.equal(button.textContent, page.t('model.testing'))
    assert.equal(button.disabled, true)
    assert.deepEqual(page.requests('POST', '/models/test').map((request) => request.body), [{}])
    await page.step(release)
    assert.equal(button.disabled, false)
    assert.equal(page.modelOutput().textContent.replace(/\d+ /, 'N '), fill(page.t('model.testOk'), { route: 'DeepSeek 账号 · DeepSeek Pro', ms: 'N', output: 'Hello, world' }))
    assert.equal(page.modelOutput().classList.contains('error'), false)
    assert.deepEqual(page.llm.calls.map((call) => [call.provider, call.model]), [['deepseek-account', 'deepseek-pro']])
    assert.match(page.llm.calls[0].user, /你好，世界/)
  })

  test('the Test button explains a failure and keeps the provider detail', async () => {
    const page = await openPage()
    const failed = (detail) => fill(page.t('failure.detail'), { message: page.t('failure.MODEL_FAILED'), detail })
    page.llm.failure = 'quota exceeded'
    await page.click(page.button(page.t('model.test')))
    assert.equal(page.modelOutput().textContent, failed('quota exceeded'))
    assert.equal(page.modelOutput().classList.contains('error'), true)
    page.host.unreachable('POST', '/models/test')
    await page.click(page.button(page.t('model.test')))
    assert.equal(page.modelOutput().textContent, failed('Failed to fetch'))

    const empty = await openPage({ before: (host, llm) => { llm.providers = [] } })
    await empty.click(empty.button(empty.t('model.test')))
    assert.equal(empty.modelOutput().textContent, empty.t('failure.NO_MODEL'), 'no detail, no separator')
  })

  test('the Test button saves a model change still waiting to be saved, and tests that model', async () => {
    const page = await openPage()
    await page.choose(page.control(page.t('model.route')), 'openai\u0000gpt-x')
    await page.click(page.button(page.t('model.test')))
    assert.equal(page.hostSettings().model.model, 'gpt-x', 'saved before the test, without waiting for the debounce')
    assert.deepEqual(page.llm.calls.map((call) => call.model), ['gpt-x'])
  })

  test('choosing another route clears the last test result', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('model.test')))
    assert.ok(page.modelOutput())
    await page.choose(page.control(page.t('model.route')), 'openai\u0000gpt-x')
    assert.equal(page.modelOutput(), null)
  })
})

describe('usage', () => {
  const tiles = (page) => page.$$('.dss-tile', page.$('#dss-panel-usage')).map((tile) => [
    tile.querySelector('.dss-tile-label').textContent, tile.querySelector('.dss-tile-value').textContent,
  ])
  const rows = (page, title) => page.$$('tbody tr', page.section(title)).map((row) => [...row.cells].map((cell) => cell.textContent))

  test('starts empty, then counts every model call as it happens', async () => {
    const page = await openPage()
    await page.click(page.$('#dss-tab-usage'))
    assert.deepEqual(tiles(page), [[page.t('usage.requests'), '0'], [page.t('usage.input'), '0'], [page.t('usage.output'), '0']])
    assert.deepEqual(rows(page, page.t('usage.byModel')), [[page.t('usage.none')]])
    assert.equal(page.$('.dss-actions .dss-hint', page.$('#dss-panel-usage')).textContent, page.t('usage.privacy'))

    await page.click(page.$('#dss-tab-model'))
    await page.click(page.button(page.t('model.test')))
    await page.click(page.$('#dss-tab-usage'))
    assert.deepEqual(tiles(page), [[page.t('usage.requests'), '1'], [page.t('usage.input'), '1,200'], [page.t('usage.output'), '34']])
    assert.deepEqual(rows(page, page.t('usage.byModel')), [['DeepSeek 账号 · DeepSeek Flash', '1', '1,200', '34']])
    assert.deepEqual(rows(page, page.t('usage.bySkill')), [[page.t('usage.modelTest'), '1', '1,200', '34']])
    assert.match(page.$('.dss-actions .dss-hint', page.$('#dss-panel-usage')).textContent, /\d{4}-\d{2}-\d{2}/)
  })

  test('shows cached and reasoning tokens only when there are any, per period', async () => {
    const page = await openPage()
    page.llm.usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, reasoningTokens: 7 }
    await page.click(page.button(page.t('model.test')))
    await page.click(page.$('#dss-tab-usage'))
    assert.deepEqual(tiles(page).map(([label]) => label), ['usage.requests', 'usage.input', 'usage.output', 'usage.cacheRead', 'usage.reasoning'].map(page.t))
    const period = (id) => page.$$('.dss-segmented button').find((button) => button.textContent === page.t(`usage.period.${id}`))
    assert.equal(period('week').getAttribute('aria-pressed'), 'true')
    await page.click(period('today'))
    assert.equal(period('today').getAttribute('aria-pressed'), 'true')
    assert.equal(tiles(page)[0][1], '1')
  })

  test('names skills, including custom ones and deleted ones', async () => {
    const page = await openPage({ settings: { skills: [...defaultSettings().skills, TABLE_SKILL] } })
    await page.step(() => page.host.worker.emit({ type: 'run', requestId: 'r1', skillId: 'translate', text: 'x' }))
    await page.step(() => page.host.worker.emit({ type: 'run', requestId: 'r2', skillId: TABLE_SKILL.id, text: 'x' }))
    await page.step()
    await page.click(page.$('#dss-tab-usage'))
    const names = () => rows(page, page.t('usage.bySkill')).map((row) => row[0]).sort()
    assert.deepEqual(names(), ['整理成表格', '翻译'].sort())
    await page.step(() => page.host.service.saveSettings({ skills: defaultSettings().skills }))
    assert.deepEqual(names(), [page.t('usage.removedSkill'), '翻译'].sort())
  })

  test('clearing asks first, then empties the numbers', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('model.test')))
    await page.click(page.$('#dss-tab-usage'))
    page.confirmReply = false
    await page.click(page.button(page.t('usage.reset')))
    assert.deepEqual(page.confirms, [page.t('usage.resetConfirm')])
    assert.equal(tiles(page)[0][1], '1')
    page.confirmReply = true
    await page.click(page.button(page.t('usage.reset')))
    assert.equal(tiles(page)[0][1], '0')
  })
})

describe('search', () => {
  test('a custom search URL turns on the custom engine', async () => {
    const page = await openPage()
    const url = page.control(page.t('search.customUrl'))
    await page.type(url, '  https://search.example.com/?q=%s  ')
    await page.blur(url)
    await page.expectSave({ customSearchUrl: 'https://search.example.com/?q=%s', searchEngine: 'custom' })
    const engine = page.control(page.t('search.engine'))
    assert.equal(engine.value, 'custom')
    assert.equal(engine.options[4].disabled, false)
    assert.equal(page.hostSettings().searchEngine, 'custom')
    assert.equal(page.host.worker.sent.at(-1).config.searchTemplate, 'https://search.example.com/?q=%s', 'the toolbar searches there')
  })

  test('clearing the custom URL falls back to Google, or keeps the built-in engine in use', async () => {
    const custom = await openPage({ settings: { searchEngine: 'custom', customSearchUrl: 'https://search.example.com/?q=%s' } })
    await custom.type(custom.control(custom.t('search.customUrl')), '')
    await custom.blur(custom.control(custom.t('search.customUrl')))
    await custom.expectSave({ customSearchUrl: '', searchEngine: 'google' })
    assert.equal(custom.control(custom.t('search.engine')).value, 'google')
    assert.equal(custom.control(custom.t('search.engine')).options[4].disabled, true)

    const bing = await openPage({ settings: { searchEngine: 'bing', customSearchUrl: 'https://search.example.com/?q=%s' } })
    await bing.type(bing.control(bing.t('search.customUrl')), '')
    await bing.blur(bing.control(bing.t('search.customUrl')))
    await bing.expectSave({ customSearchUrl: '', searchEngine: 'bing' })
    assert.equal(bing.hostSettings().searchEngine, 'bing')
  })

  test('a URL the Host would refuse is not sent, and the field says what is wrong', async () => {
    const page = await openPage()
    const url = page.control(page.t('search.customUrl'))
    await page.type(url, 'https://search.example.com/')
    await page.blur(url)
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.equal(page.hostSettings().searchEngine, 'google')
    assert.equal(url.getAttribute('aria-invalid'), 'true')
    assert.equal(page.$('[role="alert"]').textContent, page.t('search.invalid'))
    assert.equal(url.value, 'https://search.example.com/', 'the text stays for fixing')
  })

  test('a refused custom URL leaves the chosen engine alone', async () => {
    const page = await openPage({ settings: { searchEngine: 'bing' } })
    const url = page.control(page.t('search.customUrl'))
    await page.type(url, 'search.example.com')
    await page.blur(url)
    await page.advance(350)
    assert.equal(page.hostSettings().searchEngine, 'bing')
    assert.equal(page.control(page.t('search.engine')).value, 'bing')
  })

  test('leaving the custom URL field without editing it changes nothing', async () => {
    const page = await openPage({ settings: { searchEngine: 'bing', customSearchUrl: 'https://search.example.com/?q=%s' } })
    await page.blur(page.control(page.t('search.customUrl')))
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.equal(page.control(page.t('search.engine')).value, 'bing')
  })
})

describe('disabled apps', () => {
  test('typing an app name and pressing Add saves the list and clears the field', async () => {
    const page = await openPage()
    const add = () => page.button(page.t('apps.add'), page.$('.dss-inline'))
    assert.equal(add().disabled, true)
    await page.type(page.appInput(), '   ')
    assert.equal(add().disabled, true, 'blank names cannot be added')
    await page.type(page.appInput(), ' Slack ')
    await page.click(add())
    assert.deepEqual(page.disabledApps(), ['Slack'])
    assert.equal(page.appInput().value, '')
    assert.equal(page.$('.dss-empty'), null)
    await page.expectSave({ disabledApps: ['Slack'] })
    assert.deepEqual(page.host.worker.sent.at(-1).config.disabledApps, ['Slack'], 'the toolbar stops showing there')
  })

  test('Enter adds an app, and a name already in the list is not added twice', async () => {
    const page = await openPage({ settings: { disabledApps: ['Slack'] } })
    await page.type(page.appInput(), 'Notes')
    await page.press(page.appInput(), 'Enter')
    await page.expectSave({ disabledApps: ['Slack', 'Notes'] })
    await page.type(page.appInput(), 'Slack')
    await page.press(page.appInput(), 'Enter')
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.deepEqual(page.disabledApps(), ['Slack', 'Notes'])
  })

  test('removing an app saves the rest of the list', async () => {
    const page = await openPage({ settings: { disabledApps: ['Slack', 'Notes'] } })
    await page.click(page.button(`${page.t('apps.remove')} Slack`))
    assert.deepEqual(page.disabledApps(), ['Notes'])
    await page.expectSave({ disabledApps: ['Notes'] })
    await page.click(page.button(`${page.t('apps.remove')} Notes`))
    await page.expectSave({ disabledApps: [] })
    assert.equal(page.$('.dss-empty').textContent, page.t('apps.empty'))
  })

  test('apps recently used with the toolbar can be disabled with one click', async () => {
    const page = await openPage({
      settings: { disabledApps: ['Terminal'] },
      before(host) {
        for (const app of ['Terminal', 'Finder', 'Safari']) host.worker.emit({ type: 'selection', app })
      },
    })
    assert.equal(page.$('.dss-recent').firstChild.textContent, page.t('apps.recent'))
    assert.deepEqual(page.suggestedApps(), ['+ Safari', '+ Finder'], 'newest first, without apps already disabled')
    await page.click(page.button('+ Finder'))
    assert.deepEqual(page.disabledApps(), ['Terminal', 'Finder'])
    assert.deepEqual(page.suggestedApps(), ['+ Safari'])
    await page.expectSave({ disabledApps: ['Terminal', 'Finder'] })
    await page.click(page.button('+ Safari'))
    assert.equal(page.$('.dss-recent'), null, 'the row goes away once every recent app is disabled')
  })
})

describe('footer', () => {
  test('restoring defaults asks first, then shows the settings the Host restored', async () => {
    const page = await openPage({ settings: { enabled: false, toolbarSize: 3, disabledApps: ['Slack'], skills: [...defaultSettings().skills, TABLE_SKILL] } })
    page.confirmReply = false
    await page.click(page.button(page.t('footer.reset')))
    assert.deepEqual(page.confirms, [page.t('footer.resetConfirm')])
    assert.deepEqual(page.requests('POST', '/settings/reset'), [])
    page.confirmReply = true
    await page.click(page.button(page.t('footer.reset')))
    assert.deepEqual(page.requests('POST', '/settings/reset').map((request) => request.body), [{}])
    assert.deepEqual(page.hostSettings(), defaultSettings())
    assert.equal(page.checked(page.t('enabled.label')), true)
    assert.equal(page.control(page.t('toolbar.size')).value, '5')
    assert.deepEqual(page.disabledApps(), [])
    assert.deepEqual(page.skillLayout(), DEFAULT_LAYOUT)
  })

  test('restoring defaults drops a change that was still waiting to be saved', async () => {
    const page = await openPage()
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.click(page.button(page.t('footer.reset')))
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [])
    assert.equal(page.checked(page.t('enabled.label')), true)
    assert.equal(page.hostSettings().enabled, true)
  })

  test('restart asks the Host to restart the toolbar process and shows it restarting', async () => {
    const page = await openPage()
    await page.click(page.button(page.t('footer.restart')))
    assert.deepEqual(page.requests('POST', '/worker/restart').map((request) => request.body), [{}])
    assert.equal(page.host.worker.restarts, 1)
    assert.equal(page.statusText(), page.t('status.restarting'))
    await page.step(() => page.host.worker.setState('running'))
    assert.equal(page.statusText(), page.t('status.running'))
  })

  test('a button request that fails shows the error by the status', async () => {
    const page = await openPage()
    page.host.unreachable('POST', '/worker/restart')
    await page.click(page.button(page.t('footer.restart')))
    assert.match(page.statusText(), /Failed to fetch$/)
    assert.equal(page.host.worker.restarts, 0)
  })

  test('a failed restart is not reported as a failed save', async () => {
    const page = await openPage()
    page.host.unreachable('POST', '/worker/restart')
    await page.click(page.button(page.t('footer.restart')))
    assert.ok(!page.statusText().startsWith(page.t('status.saveFailed')), page.statusText())
  })
})

describe('event stream', () => {
  test('an app disabled from the toolbar appears on the open page', async () => {
    const page = await openPage({ before: (host) => host.worker.emit({ type: 'selection', app: 'Slack' }) })
    assert.deepEqual(page.suggestedApps(), ['+ Slack'])
    await page.step(() => page.host.worker.emit({ type: 'disable-app', app: 'Slack' }))
    assert.deepEqual(page.disabledApps(), ['Slack'])
    assert.deepEqual(page.suggestedApps(), [])
    await page.advance(1000)
    assert.deepEqual(page.takePuts(), [], 'the page does not send the change back')
  })

  test('a change still waiting to be saved wins over a settings event, and both are kept', async () => {
    const page = await openPage()
    await page.click(page.switchFor(page.t('enabled.label')))
    await page.step(() => page.host.worker.emit({ type: 'disable-app', app: 'Slack' }))
    assert.equal(page.checked(page.t('enabled.label')), false, 'the event carried enabled: true from before the edit')
    assert.deepEqual(page.disabledApps(), ['Slack'])
    await page.expectSave({ enabled: false })
    assert.equal(page.hostSettings().enabled, false)
    assert.deepEqual(page.hostSettings().disabledApps, ['Slack'], 'the patch did not overwrite the toolbar change')
  })

  test('a navigate event selects the settings panel, also while the page is closed', async () => {
    const page = await openPage()
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    assert.deepEqual(page.ctx.layout.selected, [PANEL])
    assert.deepEqual(page.host.opened, ['dsh://open'])
    await page.unmount()
    assert.equal(page.host.subscriptions(), 1, 'closing the page keeps the connection for navigation')
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    assert.deepEqual(page.ctx.layout.selected, [PANEL, PANEL])
  })

  test('navigation survives a layout service that is missing or not ready', async () => {
    const page = await openPage()
    page.ctx.get = () => {
      throw new Error('layout is not ready')
    }
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    page.ctx.get = () => ({})
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    delete page.ctx.get
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    assert.deepEqual(page.ctx.layout.selected, [PANEL], 'without get() it uses ctx.layout')
    await page.step(() => page.host.worker.emit({ type: 'disable-app', app: 'Slack' }))
    assert.deepEqual(page.disabledApps(), ['Slack'], 'the stream kept working')
  })

  test('the stream handles split chunks, keepalive comments and frames it cannot parse', async () => {
    const page = await openPage()
    const frame = new TextEncoder().encode(`event: settings\ndata: ${JSON.stringify({ ...page.hostSettings(), disabledApps: ['微信'] })}\n\n`)
    const split = frame.indexOf(0xe5) + 1
    await page.step(() => {
      page.host.write(': keepalive\n\n')
      page.host.write('event: settings\ndata: {not json\n\n')
      page.host.write('event: settings\n\n')
      page.host.write(frame.slice(0, split))
    })
    assert.deepEqual(page.disabledApps(), [])
    await page.step(() => page.host.write(frame.slice(split)))
    assert.deepEqual(page.disabledApps(), ['微信'], 'a character split across chunks survives')
    assert.equal(page.requests('GET', '/events').length, 1, 'none of it dropped the connection')
  })

  test('after the Host drops the stream the client reconnects in a second and catches up', async () => {
    const page = await openPage()
    await page.step(() => page.host.drop())
    assert.equal(page.host.subscriptions(), 0)
    await page.step(() => page.host.worker.emit({ type: 'disable-app', app: 'Slack' }))
    assert.deepEqual(page.disabledApps(), [], 'nothing arrives while disconnected')
    await page.advance(999)
    assert.equal(page.requests('GET', '/events').length, 1)
    await page.advance(1)
    assert.equal(page.requests('GET', '/events').length, 2)
    assert.equal(page.host.subscriptions(), 1)
    assert.deepEqual(page.disabledApps(), ['Slack'], 'a new connection starts with the current settings')
  })

  test('reconnecting backs off up to 30 s while the Host is unreachable and starts over after a success', async () => {
    const page = await openPage()
    page.host.unreachable('GET', '/events', 7)
    await page.step(() => page.host.drop())
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
      const before = page.requests('GET', '/events').length
      await page.advance(wait - 1)
      assert.equal(page.requests('GET', '/events').length, before, `no attempt before ${wait} ms`)
      await page.advance(1)
      assert.equal(page.requests('GET', '/events').length, before + 1, `an attempt after ${wait} ms`)
    }
    assert.equal(page.host.subscriptions(), 1, 'the eighth attempt connected')
    await page.step(() => page.host.drop())
    await page.advance(1000)
    assert.equal(page.host.subscriptions(), 1, 'the delay is back to one second')
  })

  test('disposing the plugin closes the stream and never reconnects', async () => {
    const page = await openPage()
    await page.unmount()
    await page.dispose()
    assert.equal(page.host.subscriptions(), 0, 'the Host dropped its subscriber')
    assert.equal(page.host.openStreams(), 0)
    await page.advance(60_000)
    assert.equal(page.requests('GET', '/events').length, 1)
    await page.step(() => page.host.worker.emit({ type: 'open-settings' }))
    assert.deepEqual(page.ctx.layout.selected, [])
  })

  test('disposing the plugin while it waits to reconnect cancels the reconnect', async () => {
    const page = await openPage()
    await page.step(() => page.host.drop())
    await page.dispose()
    await page.advance(60_000)
    assert.equal(page.requests('GET', '/events').length, 1)
    assert.equal(page.host.subscriptions(), 0)
  })
})
