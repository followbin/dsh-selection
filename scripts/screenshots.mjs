// Renders the README images in docs/images/<lang>/: the real toolbar page placed over a sample
// document, the real settings page with sample data, an animated walk-through, and the real
// capture overlay and answer panel over sample desktops (capture.gif, capture-explain.png,
// capture-ocr.png).
// Needs Google Chrome (headless), ffmpeg, and DSH installed: run `pnpm screenshots`, which uses DSH's
// Electron in Node mode so the settings page can be drawn with DSH's own theme. Arguments narrow
// the run: a language (zh, en) and/or a part (selection, capture).
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createHttpHandler } from '../src/host/http.mjs'
import { createSelectionService } from '../src/host/service.mjs'
import { defaultSettings } from '../src/host/settings.mjs'
import { pageHtml } from '../src/worker/page.mjs'
import { pageHtml as capturePage } from '../src/capture/worker/page.mjs'
import { BUILTIN_ACTION_ICONS } from '../src/capture/shared/icons.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DSH_THEME = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/lib/welcome/design-platform.css'
const OUT = fileURLToPath(new URL('../docs/images/', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dsh-selection-shots-'))
const only = process.argv.slice(2)

const SKILLS = [
  { id: 'translate', kind: 'prompt', icon: 'translate', name: { zh: '翻译', en: 'Translate' } },
  { id: 'summarize', kind: 'prompt', icon: 'summarize', name: { zh: '总结', en: 'Summarize' } },
  { id: 'explain', kind: 'prompt', icon: 'explain', name: { zh: '解释', en: 'Explain' } },
  { id: 'ask', kind: 'ask', icon: 'ask', name: { zh: '问问 DSH', en: 'Ask DSH' } },
  { id: 'speak', kind: 'speak', icon: 'speak', name: { zh: '朗读', en: 'Read aloud' } },
  { id: 'copy', kind: 'copy', icon: 'copy', name: { zh: '复制', en: 'Copy' } },
  { id: 'polish', kind: 'prompt', icon: 'polish', name: { zh: '润色', en: 'Polish' } },
  { id: 'search', kind: 'search', icon: 'search', name: { zh: '搜索', en: 'Search' } },
]
const TOOLBAR = { bar: SKILLS.slice(0, 5), more: SKILLS.slice(5) }

// Sample text written for these images.
const STORY = {
  zh: {
    locale: 'zh-CN',
    window: 'notes.md — 阅读笔记',
    heading: 'How language models answer',
    before: 'Large language models learn patterns from a great deal of text. ',
    selected: 'Given a prompt, they predict the next word again and again, which is how they translate, summarize and answer questions.',
    after: ' Their answers can still be wrong, so anything important is worth checking against a reliable source.',
    more: 'A model does not look facts up while it writes. It continues the text in the way that seems most likely, one piece at a time.',
    skill: 'translate',
    app: 'Notes',
    answer: '给定一段提示，它们会一遍又一遍地预测下一个词，这就是它们能够翻译、总结和回答问题的方式。',
    question: '说得更口语一点',
    followUp: '你给它开个头，它就一个词一个词地往下猜——翻译、写摘要、回答问题，靠的都是这个本事。',
  },
  en: {
    locale: 'en-US',
    window: 'notes.md — Reading notes',
    heading: 'How language models answer',
    before: 'Large language models learn patterns from a great deal of text. ',
    selected: 'Given a prompt, they predict the next word again and again, which is how they translate, summarize and answer questions.',
    after: ' Their answers can still be wrong, so anything important is worth checking against a reliable source.',
    more: 'A model does not look facts up while it writes. It continues the text in the way that seems most likely, one piece at a time.',
    skill: 'explain',
    app: 'Notes',
    answer: '**In short:** the model writes one word at a time, each time picking the word that most likely comes next.\n\n- **Prompt**: the text you give it to start from.\n- **Predicting the next word**: the one skill behind translating, summarizing and answering.',
    question: 'Give me an everyday example',
    followUp: 'Like your phone suggesting the next word while you type, but trained on far more text and repeated until the whole answer is written.',
  },
}

/** A desktop scene: a document window with the selection highlighted and the toolbar page in a frame. */
function scene(lang, steps) {
  const story = STORY[lang]
  const toolbar = pageHtml().replace('<head>', `<head><script>
    window.ipc = { postMessage() {} }
    Object.defineProperty(navigator, 'language', { value: ${JSON.stringify(story.locale)} })
  </script>`)
  const script = `
      const frame = document.getElementById('overlay')
      frame.srcdoc = ${JSON.stringify(toolbar)}
      frame.addEventListener('load', () => {
        const bar = frame.contentWindow.bar
        const doc = frame.contentDocument
        const end = [...document.getElementById('sel').getClientRects()].at(-1)
        // Where the worker puts the window: the card starts where the selection ends, just below it.
        frame.style.left = (end.right - 18) + 'px'
        frame.style.top = (end.bottom + 8 - 12) + 'px'
        const show = () => { frame.style.visibility = 'visible' }
        const select = () => document.getElementById('sel').classList.add('on')
        const type = (text) => {
          const input = doc.querySelector('.composer textarea')
          input.value = text
          input.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }))
        }
        bar.configure(${JSON.stringify(TOOLBAR)})
        ${steps}
      })`
  return `<!doctype html><html lang="${story.locale}"><head><meta charset="utf-8"><style>
    :root { color-scheme: light; }
    html, body { margin: 0; height: 100%; }
    body { background: linear-gradient(135deg, #e8edf4, #dde4ee); font: 15.5px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
    .window { position: absolute; inset: 28px 36px; background: #fff; border-radius: 12px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.06); }
    .titlebar { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-bottom: 1px solid #eef0f3; color: #6b7280; font-size: 13px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .title { margin-left: 10px; }
    article { max-width: 640px; padding: 26px 48px; color: #1f2937; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { margin: 0 0 14px; }
    mark { background: transparent; color: inherit; }
    mark.on { background: rgba(0, 122, 255, 0.24); }
    iframe { position: absolute; border: 0; background: transparent; visibility: hidden; }
  </style></head><body>
    <div class="window">
      <div class="titlebar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${story.window}</span></div>
      <article><h1>${story.heading}</h1><p>${story.before}<mark id="sel">${story.selected}</mark>${story.after}</p><p>${story.more}</p></article>
    </div>
    <iframe id="overlay" width="680" height="560"></iframe>
    <script>${script.replace(/<\//g, '<\\/')}</script>
  </body></html>`
}

const run = promisify(execFile)
const PARALLEL = 4
const queue = []

/** Queues one headless Chrome screenshot; `shoot()` takes them all, a few at a time. */
function chrome(html, file, { width = 1100, height = 640, scale = 2 } = {}) {
  const page = join(work, `${Math.random().toString(36).slice(2)}.html`)
  writeFileSync(page, html)
  queue.push({ page, file, width, height, scale })
}

async function shoot() {
  const jobs = queue.splice(0)
  await Promise.all(Array.from({ length: PARALLEL }, async (_, slot) => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      await run(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${join(work, `chrome-${slot}`)}`, `--force-device-scale-factor=${job.scale}`,
        `--window-size=${job.width},${job.height}`, '--virtual-time-budget=1200', `--screenshot=${job.file}`,
        pathToFileURL(job.page).href,
      ])
    }
  }))
}

/**
 * One headless Chrome driven over its DevTools protocol, for pages that report when they are
 * ready (`window.__sceneDone`). The command-line screenshot's virtual time skips ahead of image
 * decoding and frame loads, so a scene that waits on those comes out half drawn there.
 * Needs Node's WebSocket (Node 22 or later; DSH's runtime is Node 24).
 */
async function devtools() {
  // A fresh profile per launch: an earlier launch's DevToolsActivePort would name a closed port.
  const dir = mkdtempSync(join(work, 'chrome-devtools-'))
  const browser = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' })
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let port = null
  for (let i = 0; i < 200 && !port; i += 1) {
    try { port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { await pause(50) }
  }
  if (!port) throw new Error('headless Chrome did not open its DevTools port')
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) => entry.type === 'page')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let next = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    if (message.error) call.reject(new Error(message.error.message))
    else call.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    next += 1
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  const evaluate = async (expression, awaitPromise = false) => (await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result?.value
  return {
    /** Load `html`, wait for its scene to finish, and write a PNG of the viewport to `file`. */
    async shot(html, file, { width, height, scale }) {
      const token = Math.random().toString(36).slice(2)
      const page = join(work, `${token}.html`)
      writeFileSync(page, `${html}<script>window.__sceneToken = ${JSON.stringify(token)}</script>`)
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
      await send('Page.navigate', { url: pathToFileURL(page).href })
      for (let i = 0; i < 400 && (await evaluate('window.__sceneToken')) !== token; i += 1) await pause(25)
      await Promise.race([evaluate('window.__sceneDone', true), pause(15000)])
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(data, 'base64'))
    },
    close() {
      socket.close()
      browser.kill()
    },
  }
}

const skillOf = (lang) => SKILLS.find((skill) => skill.id === STORY[lang].skill)
const panelOpen = (lang) => `bar.showPanel(${JSON.stringify({ skill: skillOf(lang), text: STORY[lang].selected, app: STORY[lang].app, languages: [{ code: 'zh-CN', name: '简体中文' }, { code: 'en', name: 'English' }, { code: 'ja', name: '日本語' }], translateTarget: 'auto' })})`
const answer = (id, text, info = {}) => `bar.begin(${JSON.stringify(id)}, ${JSON.stringify(info)}); bar.append(${JSON.stringify(id)}, ${JSON.stringify(text)}); bar.done(${JSON.stringify(id)})`

function stills(lang) {
  const dir = join(OUT, lang)
  mkdirSync(dir, { recursive: true })
  const { answer: first, question, followUp } = STORY[lang]
  chrome(scene(lang, 'select(); bar.showBar(); show()'), join(dir, 'toolbar.png'), { height: 420 })
  chrome(scene(lang, `select(); ${panelOpen(lang)}; ${answer('r1', first)}; ${answer('r2', followUp, { question })}; show()`), join(dir, 'follow-up.png'), { height: 640 })
}

/** The walk-through, as one frame per step; long pauses repeat a frame. */
async function walkthrough(lang) {
  const { answer: first, question, followUp } = STORY[lang]
  const frames = []
  const hold = (steps, times) => { for (let i = 0; i < times; i += 1) frames.push(steps) }
  hold('', 4)
  hold('select()', 5)
  hold('select(); bar.showBar(); show()', 8)
  const opened = `select(); ${panelOpen(lang)}; show()`
  hold(`${opened}; bar.begin('r1', {})`, 3)
  const pieces = (text, count) => Array.from({ length: count }, (_, i) => text.slice(0, Math.ceil(((i + 1) / count) * text.length)))
  for (const part of pieces(first, 10)) hold(`${opened}; bar.begin('r1', {}); bar.append('r1', ${JSON.stringify(part)})`, 1)
  const answered = `${opened}; ${answer('r1', first)}`
  hold(answered, 8)
  for (const part of pieces(question, 6)) hold(`${answered}; type(${JSON.stringify(part)})`, 1)
  hold(`${answered}; type(${JSON.stringify(question)})`, 4)
  hold(`${answered}; bar.begin('r2', ${JSON.stringify({ question })})`, 3)
  for (const part of pieces(followUp, 10)) hold(`${answered}; bar.begin('r2', ${JSON.stringify({ question })}); bar.append('r2', ${JSON.stringify(part)})`, 1)
  hold(`${answered}; ${answer('r2', followUp, { question })}`, 20)

  const dir = join(work, `frames-${lang}`)
  mkdirSync(dir, { recursive: true })
  const unique = [...new Set(frames)]
  const shotOf = (steps) => join(dir, `unique-${unique.indexOf(steps)}.png`)
  for (const steps of unique) chrome(scene(lang, steps ? `${steps}; show()` : ''), shotOf(steps), { height: 640, scale: 1 })
  await shoot()
  frames.forEach((steps, index) => writeFileSync(join(dir, `${String(index).padStart(3, '0')}.png`), readFileSync(shotOf(steps))))
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', '8', '-i', join(dir, '%03d.png'),
    '-vf', 'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    join(OUT, lang, 'walkthrough.gif'),
  ])
}

// ---------- Settings page: client.js in jsdom against the real Host, exported as static HTML ----------

const ORIGIN = 'http://127.0.0.1:4100'

function sampleUsage() {
  const day = (back) => {
    const date = new Date()
    date.setDate(date.getDate() - back)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const flash = 'deepseek-account\u0000deepseek-flash'
  const pro = 'deepseek-account\u0000deepseek-pro'
  const counts = (requests, input, output, cacheRead = 0) => ({ requests, input, output, cacheRead, reasoning: 0 })
  const days = {}
  for (let back = 0; back < 9; back += 1) {
    days[day(back)] = {
      [flash]: {
        translate: counts(14 - back, 5200 - back * 300, 1900 - back * 90, 2400), explain: counts(6, 4100, 3600), ask: counts(3, 2900, 1700, 1200),
        'capture:ocr': counts(4, 6200, 900), 'capture:ask': counts(2, 5100, 1300),
      },
      ...(back % 3 === 0 ? { [pro]: { polish: counts(2, 1300, 1200) } } : {}),
    }
  }
  return {
    version: 1,
    days,
    routes: {
      [flash]: { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash' },
      [pro]: { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-pro', modelName: 'DeepSeek-V4.1-Pro' },
    },
  }
}

async function settingsPage(lang, tab) {
  const dataDir = mkdtempSync(join(work, 'host-'))
  writeFileSync(join(dataDir, 'usage.json'), JSON.stringify(sampleUsage()))
  const llm = {
    listProviders: () => [{ id: 'deepseek-account', displayName: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', displayName: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-pro', displayName: 'DeepSeek-V4.1-Pro' }],
  }
  const service = createSelectionService({
    getLlm: () => llm, log: () => {}, dataDir, desktop: true, platform: 'darwin', openExternal: () => {},
    startWorker: ({ onState, onMessage }) => {
      onState({ state: 'running', pid: 1 })
      queueMicrotask(() => onMessage({ type: 'permission', trusted: true }))
      return { send() {}, restart() {}, stop: async () => {} }
    },
  })
  service.saveSettings({
    skills: [...defaultSettings().skills, { id: 'custom-weekly01', custom: true, enabled: true, name: lang === 'zh' ? '写成周报' : 'Weekly update', icon: 'list', prompt: 'Rewrite it as a short weekly status update.' }],
    disabledApps: ['1Password', 'Terminal'],
  })
  const handler = createHttpHandler(service, { log: () => {} })
  const fetch = (input, init = {}) => {
    const url = new URL(String(input), ORIGIN)
    if (url.pathname.endsWith('/api/events')) return Promise.resolve(new Response(new ReadableStream({ start() {} })))
    return new Promise((resolve) => {
      const body = typeof init.body === 'string' ? init.body : undefined
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
        method: init.method ?? 'GET',
        url: url.pathname,
        headers: { host: url.host, 'sec-fetch-site': 'same-origin', origin: ORIGIN, 'content-type': 'application/json' },
      })
      const res = {
        writeHead(status, headers) { this.status = status; this.headers = headers },
        write: () => true,
        end(chunk) { resolve(new Response(chunk ?? '', { status: this.status, headers: this.headers })) },
        on() { return this },
      }
      void handler(req, res)
    })
  }

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}/`, pretendToBeVisual: true })
  const { window } = dom
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
  const modules = []
  window.__ModuleLoader__ = { load: (module) => modules.push(module) }
  vm.compileFunction(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), ['window', 'fetch', 'setTimeout', 'clearTimeout'])(window, fetch, setTimeout, clearTimeout)
  const plugin = modules[0].factory((name) => (name === 'react' ? React : null))
  const dictionaries = new Map()
  const registrations = []
  const t = (key) => dictionaries.get('dshSelection')?.[lang]?.[key] ?? key
  plugin.apply({
    effect: (execute) => execute(),
    slots: { inject: (name, callback) => callback(), register: (options, component) => registrations.push({ options, component }) },
    locale: { register: (namespace, value) => dictionaries.set(namespace, value), bind: () => t },
    get: () => ({ selectPanel() {} }),
  })
  const container = window.document.createElement('div')
  container.style.height = '100%'
  window.document.body.append(container)
  const root = createRoot(container)
  const Main = registrations.find((entry) => entry.options.name === 'main').component
  await act(async () => root.render(React.createElement(Main, { t })))
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  await act(async () => window.document.getElementById(`dss-tab-${tab}`).click())
  // Form state lives in properties; the static copy needs it in attributes.
  for (const select of container.querySelectorAll('select')) for (const option of select.options) option.toggleAttribute('selected', option.selected)
  for (const input of container.querySelectorAll('input')) input.setAttribute('value', input.value)
  const markup = container.innerHTML
  await act(async () => root.unmount())
  await service.dispose()
  return `<!doctype html><html lang="${STORY[lang].locale}"><head><meta charset="utf-8">
    <style>${readFileSync(DSH_THEME, 'utf8')}</style>
    <style>html, body { margin: 0; height: 100%; background: var(--dsw-alias-bg-base); } body { font: 14px/1.5 -apple-system, "PingFang SC", sans-serif; color: var(--dsw-alias-label-primary); } body > div { display: flex; height: 100%; }</style>
    </head><body><div>${markup}</div></body></html>`
}


// ---------- Screenshots: the shipped overlay and answer pages over sample desktops ----------

const DESK = { width: 1280, height: 760 }

// Sample content written for these images. Each desktop is one window; a scene freezes it,
// picks `region` out of it and shows what the AI answers about that region.
const WINDOW_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; height: 100%; }
  body { background: linear-gradient(135deg, #dbe4f0, #e8e1ef); font: 15.5px/1.6 -apple-system, "Helvetica Neue", sans-serif; }
  .window { position: absolute; background: #fff; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.06); }
  .titlebar { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-bottom: 1px solid #eef0f3; color: #6b7280; font-size: 13px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { margin-left: 10px; }`
const TITLEBAR = (title) => `<div class="titlebar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${title}</span></div>`
const desktop = (css, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${WINDOW_CSS}${css}</style></head><body>${body}</body></html>`

const QUARTERS = [['Q1', 4.2], ['Q2', 4.9], ['Q3', 5.6], ['Q4', 6.6]]

const DESKTOPS = {
  /** A revenue chart with a note under it: what the walk-through asks about. */
  chart: desktop(`
    .window { left: 120px; top: 40px; width: 660px; height: 492px; }
    .content { padding: 22px 40px; color: #1f2937; }
    h1 { margin: 0 0 2px; font-size: 22px; }
    .sub { color: #6b7280; font-size: 13.5px; margin-bottom: 14px; }
    .note { margin-top: 10px; padding: 10px 14px; border-radius: 8px; background: #f3f6fb; color: #374151; font-size: 14px; }`,
  `<div class="window">${TITLEBAR('revenue-dashboard')}<div class="content">
    <h1>Revenue by quarter</h1><div class="sub">Fiscal year 2026, $M</div>
    <svg width="580" height="276" viewBox="0 0 580 276" font-family="-apple-system, Helvetica Neue, sans-serif">
      ${[0, 2, 4, 6, 8].map((v) => `<line x1="44" x2="570" y1="${246 - v * 26}" y2="${246 - v * 26}" stroke="#eef0f3"/><text x="34" y="${250 - v * 26}" font-size="12" fill="#9ca3af" text-anchor="end">${v}</text>`).join('')}
      ${QUARTERS.map(([q, v], i) => {
        const x = 80 + i * 126
        const h = v * 26
        return `<rect x="${x}" y="${246 - h}" width="72" height="${h}" rx="5" fill="${i === 3 ? '#2563eb' : '#93b4f5'}"/>
          <text x="${x + 36}" y="${236 - h}" font-size="14" font-weight="600" fill="#1f2937" text-anchor="middle">${v.toFixed(1)}</text>
          <text x="${x + 36}" y="268" font-size="14" fill="#6b7280" text-anchor="middle">${q}</text>`
      }).join('')}
    </svg>
    <div class="note">Q4: new customers in Asia more than doubled; operating costs stayed flat.</div>
  </div></div>`),

  /** A terminal with a stack trace: what the Explain still answers about. */
  error: desktop(`
    .window { left: 60px; top: 110px; width: 700px; height: 470px; background: #1e1f24; }
    .titlebar { border-bottom-color: #2c2e35; color: #9ca3af; }
    pre { margin: 0; padding: 18px 22px; color: #d1d5db; font: 14px/1.65 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre; }
    .dim { color: #7c8290; } .err { color: #f87171; font-weight: 600; } .ok { color: #86efac; } .hl { color: #fde68a; }`,
  `<div class="window">${TITLEBAR('zsh — shop')}<pre><span class="ok">~/shop</span> $ npm run report

<span class="dim">&gt; shop@1.4.0 report
&gt; node scripts/report.js</span>

/Users/dev/shop/src/orders.js:42
  const total = order.items.reduce((sum, item) =&gt; sum + item.price, 0)
                            <span class="err">^</span>

<span class="err">TypeError: Cannot read properties of undefined (reading 'reduce')</span>
    at orderTotal (<span class="hl">/Users/dev/shop/src/orders.js:42:29</span>)
    at Array.map (&lt;anonymous&gt;)
    at buildReport (/Users/dev/shop/scripts/report.js:18:31)
    at main (/Users/dev/shop/scripts/report.js:31:3)

Node.js v24.4.0</pre></div>`),

  /** A table shown as pixels in a screen share: what the Extract text still reads. */
  table: desktop(`
    .window { left: 60px; top: 110px; width: 700px; height: 470px; background: #26282e; }
    .titlebar { border-bottom-color: #33353c; color: #9ca3af; }
    .slide { margin: 26px auto 0; width: 600px; height: 340px; background: #fff; border-radius: 4px; padding: 26px 34px; box-sizing: border-box; color: #111827; }
    h2 { margin: 0 0 14px; font: 600 22px/1.3 Georgia, serif; }
    table { width: 100%; border-collapse: collapse; font: 16px/1.4 Georgia, serif; font-variant-numeric: tabular-nums; }
    th, td { padding: 7px 10px; border-bottom: 1px solid #d1d5db; text-align: left; }
    th { border-bottom: 2px solid #111827; }
    td:not(:first-child), th:not(:first-child) { text-align: right; }
    .bar { display: flex; justify-content: center; gap: 12px; margin-top: 16px; }
    .bar i { width: 30px; height: 30px; border-radius: 50%; background: #3a3d45; }
    .bar i.end { background: #dc2626; }`,
  `<div class="window">${TITLEBAR('Weekly sync — screen sharing')}<div class="slide">
    <h2>Budget by team (k$)</h2>
    <table><tr><th>Team</th><th>Q1</th><th>Q2</th><th>Q3</th></tr>
      <tr><td>Platform</td><td>120</td><td>135</td><td>150</td></tr>
      <tr><td>Mobile</td><td>80</td><td>95</td><td>90</td></tr>
      <tr><td>Data</td><td>60</td><td>70</td><td>85</td></tr>
      <tr><td>Design</td><td>40</td><td>40</td><td>45</td></tr></table>
  </div><div class="bar"><i></i><i></i><i></i><i class="end"></i></div></div>`),
}

const OCR_TEXT = 'Budget by team (k$)\nTeam\tQ1\tQ2\tQ3\nPlatform\t120\t135\t150\nMobile\t80\t95\t90\nData\t60\t70\t85\nDesign\t40\t40\t45'
const FIX = '```js\nconst total = (order.items ?? [])\n  .reduce((sum, item) => sum + item.price, 0)\n```'

/** What each scene asks and what the answers say, per language. */
const CAPTURE_STORY = {
  zh: {
    walk: {
      question: '为什么这个季度涨得最快？',
      answer: '你圈出的是 **Q4**：营收从 Q3 的 5.6 涨到 **6.6**（百万美元），环比约 **+18%**，是全年最快的一季。\n\n图下的说明给了原因：\n- 亚洲的新客户数量翻了一倍多\n- 运营成本基本持平，多出来的收入大多是利润',
      followUp: '整理成表格',
      table: '| 季度 | 营收（百万美元） | 环比 |\n|---|---|---|\n| Q1 | 4.2 | — |\n| Q2 | 4.9 | +17% |\n| Q3 | 5.6 | +14% |\n| Q4 | 6.6 | +18% |',
    },
    explain: `**\`order.items\` 是 \`undefined\`**，所以对它调用 \`reduce\` 时报错。\n\n- 位置：\`src/orders.js\` 第 42 行，\`orderTotal\` 里\n- 来源：\`buildReport\` 对每个订单调用 \`orderTotal\`，至少有一个订单没有 \`items\`\n\n修复：没有商品时按空列表算\n\n${FIX}`,
  },
  en: {
    walk: {
      question: 'Why did this quarter grow fastest?',
      answer: 'The box marks **Q4**: revenue rose from 5.6 to **6.6** ($M), about **+18%** on Q3, the fastest quarter of the year.\n\nThe note under the chart gives the reasons:\n- New customers in Asia more than doubled\n- Operating costs stayed flat, so most of the extra revenue is margin',
      followUp: 'Make it a table',
      table: '| Quarter | Revenue ($M) | vs. previous |\n|---|---|---|\n| Q1 | 4.2 | — |\n| Q2 | 4.9 | +17% |\n| Q3 | 5.6 | +14% |\n| Q4 | 6.6 | +18% |',
    },
    explain: `**\`order.items\` is \`undefined\`**, so calling \`reduce\` on it throws.\n\n- Where: \`src/orders.js\` line 42, inside \`orderTotal\`\n- Why: \`buildReport\` calls \`orderTotal\` for every order, and at least one order has no \`items\`\n\nFix: treat a missing list as empty\n\n${FIX}`,
  },
}

/** Regions and annotations, in page coordinates. */
const WALK_PICK = [140, 88, 760, 516]
const WALK_BOX = [604, 214, 704, 454]
const STILL_PICK = [72, 150, 748, 568]

/**
 * The overlay page as the worker loads it, over a frozen desktop, with the answer page in a
 * frame where its window would open. `steps` runs once the frozen frame is on screen.
 */
function captureScene(lang, frameUrl, steps) {
  const actions = ['ocr', 'translate', 'explain', 'ask'].map((id) => ({ id, name: null, icon: BUILTIN_ACTION_ICONS[id] }))
  // The capture pages have no head or body tags: additions go after the charset and at the end.
  const answerPage = capturePage('answer').replace('<meta charset="utf-8">', `<meta charset="utf-8"><script>
    window.ipc = { postMessage(raw) { const m = JSON.parse(raw); if (m.type === 'size') parent.answerHeight(m.height) } }
  </script>`)
  // Its own scope: the overlay's script already declares names such as `tool` at the top level.
  const script = `(() => {
    let finish
    window.__sceneDone = new Promise((resolve) => { finish = resolve })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const cursor = document.getElementById('cursor')
    const point = (x, y) => { cursor.style.display = 'block'; cursor.style.left = x + 'px'; cursor.style.top = y + 'px' }
    const fire = (type, x, y) => {
      point(x, y)
      ;(document.elementFromPoint(x, y) || document.body).dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }))
    }
    const tool = (name) => document.querySelector('#bar [data-tool="' + name + '"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    /** A drag from one point to another; a fraction below 1 stops with the button still down. */
    async function drag([x1, y1, x2, y2], upTo = 1) {
      fire('mousemove', x1, y1)
      fire('mousedown', x1, y1)
      const steps = 8
      for (let i = 1; i <= Math.round(steps * upTo); i += 1) { fire('mousemove', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps)); await sleep(4) }
      if (upTo >= 1) { fire('mouseup', x2, y2); await sleep(60) }
    }
    const hover = (selector) => { const b = document.querySelector(selector).getBoundingClientRect(); point(b.x + b.width * 0.42, b.y + b.height * 0.62) }
    /** The ask box under the region, with \`text\` typed into it. */
    function ask(text) {
      document.querySelector('[data-ai="ask"]').click()
      const prompt = document.getElementById('prompt')
      prompt.value = text
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      cursor.style.display = 'none'
    }
    const panel = document.getElementById('answer')
    window.answerHeight = (height) => { panel.style.height = Math.min(600, height) + 'px' }
    /**
     * The capture ends and the answer panel opens beside the region: each turn is
     * { question, text, done }, and \`typing\` is a follow-up still in the input.
     */
    async function answer(action, [x1, y1, x2, y2], turns, typing = '') {
      document.documentElement.classList.add('ended')
      const image = new Image()
      image.src = ${JSON.stringify(frameUrl)}
      await image.decode()
      const thumb = document.createElement('canvas')
      thumb.width = (x2 - x1) * 2; thumb.height = (y2 - y1) * 2
      thumb.getContext('2d').drawImage(image, x1 * 2, y1 * 2, thumb.width, thumb.height, 0, 0, thumb.width, thumb.height)
      await new Promise((resolve) => { panel.onload = resolve; panel.srcdoc = ${JSON.stringify(answerPage)} })
      const surface = panel.contentWindow.surface
      surface.locale(${JSON.stringify(lang)})
      surface.theme('light')
      surface.thumbnail(thumb.toDataURL('image/png'))
      surface.open(action, { plain: action === 'ocr' })
      turns.forEach((turn, index) => {
        surface.begin(index, turn.question ?? null)
        if (turn.text) surface.chunk(index, turn.text)
        if (turn.done) surface.end(index)
      })
      const input = panel.contentDocument.getElementById('input')
      input.value = typing
      input.dispatchEvent(new Event('input', { bubbles: true }))
      panel.contentWindow.document.activeElement?.blur()
      panel.style.left = (x2 + 14) + 'px'
      panel.style.top = y1 + 'px'
      await sleep(120)
      panel.style.visibility = 'visible'
    }
    addEventListener('load', async () => {
      window.shot.locale(${JSON.stringify(lang)})
      window.shot.theme('light')
      window.shot.actions(${JSON.stringify(actions)})
      try {
        await new Promise((resolve) => { window.frameReady = resolve; window.shot.frame(${JSON.stringify(frameUrl)}, 1, 2) })
        window.shot.shown(1, 2)
        await sleep(60)
        ${steps}
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await sleep(40)
      } finally {
        finish()
      }
    })
  })()`
  return capturePage('overlay')
    .replace('<meta charset="utf-8">', () => `<meta charset="utf-8"><script>
      window.ipc = { postMessage(raw) { const m = JSON.parse(raw); if (m.type === 'frame-ready') window.frameReady?.() } }
    </script><style>
      html { background: url(${frameUrl}) 0 0 / 100% 100% no-repeat !important; }
      html.ended body > :not(#answer) { display: none !important; }
      #answer { position: fixed; z-index: 100; width: 440px; height: 160px; border: 0; border-radius: 12px; visibility: hidden; background: transparent;
        box-shadow: 0 14px 44px rgba(15, 23, 42, 0.24), 0 0 0 0.5px rgba(15, 23, 42, 0.2); }
      #cursor { position: fixed; z-index: 101; width: 17px; height: 25px; display: none; pointer-events: none; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35)); }
    </style>`) + `<iframe id="answer"></iframe>
      <svg id="cursor" viewBox="0 0 17 25"><path d="M1 1v19.5l4.6-4.4 3 7.2 3.2-1.4-3-7h6.4z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>
      <script>${script.replace(/<\//g, '<\\/')}</script>`
}

/** Each desktop as a data URL, rendered once at 2x. */
async function desktopFrames() {
  const files = Object.fromEntries(Object.keys(DESKTOPS).map((name) => [name, join(work, `desktop-${name}.png`)]))
  for (const [name, html] of Object.entries(DESKTOPS)) chrome(html, files[name], { ...DESK, scale: 2 })
  await shoot()
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, `data:image/png;base64,${readFileSync(file).toString('base64')}`]))
}

const pieces = (text, count) => Array.from({ length: count }, (_, i) => text.slice(0, Math.ceil(((i + 1) / count) * text.length)))
const fractions = (count) => Array.from({ length: count }, (_, i) => (i + 1) / count)

/**
 * capture.gif: pick a chart, box one bar, ask why it grew, then ask for a table.
 * capture-explain.png and capture-ocr.png: a stack trace explained, a shared table read out.
 */
async function captureImages(lang, frames) {
  const story = CAPTURE_STORY[lang]
  const { question, answer, followUp, table } = story.walk
  const steps = []
  const hold = (code, times) => { for (let i = 0; i < times; i += 1) steps.push(code) }
  hold(`point(${WALK_PICK[0] + 60}, ${WALK_PICK[1] + 80}); fire('mousemove', ${WALK_PICK[0] + 60}, ${WALK_PICK[1] + 80})`, 4)
  for (const f of fractions(6)) hold(`await drag(${JSON.stringify(WALK_PICK)}, ${f})`, f < 1 ? 1 : 5)
  const picked = `await drag(${JSON.stringify(WALK_PICK)}); tool('rect')`
  for (const f of fractions(5)) hold(`${picked}; await drag(${JSON.stringify(WALK_BOX)}, ${f})`, f < 1 ? 1 : 4)
  const boxed = `${picked}; await drag(${JSON.stringify(WALK_BOX)})`
  hold(`${boxed}; hover('[data-ai="ask"]')`, 5)
  for (const part of pieces(question, 6)) hold(`${boxed}; ask(${JSON.stringify(part)})`, part === question ? 6 : 1)
  const turn = (q, text, done) => ({ question: q, text, done })
  const panel = (turns, typing = '') => `${boxed}; await answer('ask', ${JSON.stringify(WALK_PICK)}, ${JSON.stringify(turns)}, ${JSON.stringify(typing)})`
  hold(panel([turn(question, '', false)]), 4)
  for (const part of pieces(answer, 10)) hold(panel([turn(question, part, part === answer)]), part === answer ? 14 : 1)
  const first = turn(question, answer, true)
  for (const part of pieces(followUp, 4)) hold(panel([first], part), part === followUp ? 5 : 1)
  hold(panel([first, turn(followUp, '', false)]), 4)
  for (const part of pieces(table, 8)) hold(panel([first, turn(followUp, part, part === table)]), part === table ? 30 : 1)

  const dir = join(work, `capture-${lang}`)
  mkdirSync(dir, { recursive: true })
  const unique = [...new Set(steps)]
  const shotOf = (code) => join(dir, `unique-${unique.indexOf(code)}.png`)
  const browser = await devtools()
  try {
    for (const code of unique) await browser.shot(captureScene(lang, frames.chart, code), shotOf(code), { ...DESK, scale: 1 })
    const still = (frame, action, turns) => captureScene(lang, frame, `await answer(${JSON.stringify(action)}, ${JSON.stringify(STILL_PICK)}, ${JSON.stringify(turns)})`)
    await browser.shot(still(frames.error, 'explain', [turn(null, story.explain, true)]), join(OUT, lang, 'capture-explain.png'), { ...DESK, scale: 2 })
    await browser.shot(still(frames.table, 'ocr', [turn(null, OCR_TEXT, true)]), join(OUT, lang, 'capture-ocr.png'), { ...DESK, scale: 2 })
  } finally {
    browser.close()
  }
  steps.forEach((code, index) => writeFileSync(join(dir, `${String(index).padStart(3, '0')}.png`), readFileSync(shotOf(code))))
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', '8', '-i', join(dir, '%03d.png'),
    '-vf', 'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    join(OUT, lang, 'capture.gif'),
  ])
}

const LANGS = ['zh', 'en']
const langs = only.filter((arg) => LANGS.includes(arg))
const parts = only.filter((arg) => !LANGS.includes(arg))
const wants = (part) => parts.length === 0 || parts.includes(part)
const frames = wants('capture') ? await desktopFrames() : null
for (const lang of LANGS) {
  if (langs.length && !langs.includes(lang)) continue
  mkdirSync(join(OUT, lang), { recursive: true })
  if (wants('selection')) {
    stills(lang)
    chrome(await settingsPage(lang, 'selection'), join(OUT, lang, 'settings-skills.png'), { width: 900, height: 860 })
    chrome(await settingsPage(lang, 'usage'), join(OUT, lang, 'settings-usage.png'), { width: 900, height: 860 })
    await shoot()
    await walkthrough(lang)
  }
  if (wants('capture')) await captureImages(lang, frames)
  console.log(`${lang}: done`)
}
rmSync(work, { recursive: true, force: true })
process.exit(0)
