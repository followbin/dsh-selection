// Renders the README images in docs/images/<lang>/: the real toolbar page placed over a sample
// document, the real settings page with sample data, an animated walk-through, and the real
// capture overlay and answer panel over a sample desktop (capture.png, capture.gif).
// Needs Google Chrome (headless), ffmpeg, and DSH installed: run `pnpm screenshots`, which uses DSH's
// Electron in Node mode so the settings page can be drawn with DSH's own theme. Arguments narrow
// the run: a language (zh, en) and/or a part (selection, capture).
import { execFile, execFileSync } from 'node:child_process'
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
function chrome(html, file, { width = 1100, height = 640, scale = 2, budget = 1200 } = {}) {
  const page = join(work, `${Math.random().toString(36).slice(2)}.html`)
  writeFileSync(page, html)
  queue.push({ page, file, width, height, scale, budget })
}

async function shoot() {
  const jobs = queue.splice(0)
  await Promise.all(Array.from({ length: PARALLEL }, async (_, slot) => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      await run(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${join(work, `chrome-${slot}`)}`, `--force-device-scale-factor=${job.scale}`,
        `--window-size=${job.width},${job.height}`, `--virtual-time-budget=${job.budget}`, `--screenshot=${job.file}`,
        pathToFileURL(job.page).href,
      ])
    }
  }))
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
      [flash]: { translate: counts(14 - back, 5200 - back * 300, 1900 - back * 90, 2400), explain: counts(6, 4100, 3600), ask: counts(3, 2900, 1700, 1200) },
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


// ---------- Screenshots: the shipped overlay and answer pages over a sample desktop ----------

const DESK = { width: 1280, height: 720 }
/** The region the scene drags out, and the annotations drawn in it (page coordinates). */
const PICK = [176, 104, 742, 520]
const BOX = [196, 418, 724, 456]
const ARROW = [704, 318, 640, 424]

// Sample content written for these images.
const CAPTURE_STORY = {
  zh: {
    action: 'translate',
    answer: '**季度更新**\n\n今年每个季度的营收都在增长。第四季度表现最好：亚洲的新客户数量翻了一倍多，而成本基本持平。\n\n| 季度 | 营收（百万美元） | 增长 |\n|---|---|---|\n| Q1 | 4.2 | 6% |\n| Q2 | 4.9 | 17% |\n| Q3 | 5.6 | 14% |\n| Q4 | 6.6 | 18% |',
  },
  en: {
    action: 'explain',
    answer: 'Revenue rose every quarter, from **$4.2M** in Q1 to **$6.6M** in Q4.\n\n- **Q4 grew fastest (18%)**, with new customers in Asia more than doubling.\n- Growth eased to 14% in Q3 before that jump.\n- Costs stayed flat, so most of the extra revenue is margin.',
  },
}

/** The desktop the capture freezes: one document window. */
function desktopHtml() {
  const rows = [['Q1', '4.2', '6%'], ['Q2', '4.9', '17%'], ['Q3', '5.6', '14%'], ['Q4', '6.6', '18%']]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    :root { color-scheme: light; }
    html, body { margin: 0; height: 100%; }
    body { background: linear-gradient(135deg, #dbe4f0, #e8e1ef); font: 15.5px/1.7 -apple-system, "Helvetica Neue", sans-serif; }
    .window { position: absolute; left: 150px; top: 56px; width: 620px; height: 600px; background: #fff; border-radius: 12px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.06); }
    .titlebar { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-bottom: 1px solid #eef0f3; color: #6b7280; font-size: 13px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .title { margin-left: 10px; }
    article { padding: 26px 46px; color: #1f2937; }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; }
    th { color: #6b7280; font-size: 13px; font-weight: 600; }
  </style></head><body>
    <div class="window">
      <div class="titlebar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">quarterly-update.pdf</span></div>
      <article>
        <h1>Quarterly update</h1>
        <p>Revenue grew in every quarter this year. The fourth quarter was the strongest: new customers in Asia more than doubled, while costs stayed flat.</p>
        <table><tr><th>Quarter</th><th>Revenue ($M)</th><th>Growth</th></tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>
      </article>
    </div>
  </body></html>`
}

/**
 * The overlay page as the worker loads it, over the frozen desktop, with the answer page in a
 * frame where its window would open. `steps` runs once the frame is on screen.
 */
function captureScene(lang, frameUrl, steps) {
  const story = CAPTURE_STORY[lang]
  const actions = ['ocr', 'translate', 'explain', 'ask'].map((id) => ({ id, name: null, icon: BUILTIN_ACTION_ICONS[id] }))
  // The capture pages have no head or body tags: additions go after the charset and at the end.
  const answerPage = capturePage('answer').replace('<meta charset="utf-8">', `<meta charset="utf-8"><script>
    window.ipc = { postMessage(raw) { const m = JSON.parse(raw); if (m.type === 'size') parent.answerHeight(m.height) } }
  </script>`)
  // Its own scope: the overlay's script already declares names such as `tool` at the top level.
  const script = `(() => {
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
    const panel = document.getElementById('answer')
    window.answerHeight = (height) => { panel.style.height = Math.min(560, height) + 'px' }
    /** The capture ends and the answer panel opens beside the region, part of the reply in. */
    async function answer(upTo) {
      // The overlay is gone; only the desktop and the panel stay.
      document.documentElement.classList.add('ended')
      const image = new Image()
      image.src = ${JSON.stringify(frameUrl)}
      await image.decode()
      const thumb = document.createElement('canvas')
      const [x1, y1, x2, y2] = ${JSON.stringify(PICK)}
      thumb.width = (x2 - x1) * 2; thumb.height = (y2 - y1) * 2
      thumb.getContext('2d').drawImage(image, x1 * 2, y1 * 2, thumb.width, thumb.height, 0, 0, thumb.width, thumb.height)
      await new Promise((resolve) => { panel.onload = resolve; panel.srcdoc = ${JSON.stringify(answerPage)} })
      const surface = panel.contentWindow.surface
      surface.locale(${JSON.stringify(lang)})
      surface.theme('light')
      surface.thumbnail(thumb.toDataURL('image/png'))
      surface.open(${JSON.stringify(story.action)})
      surface.begin(0, null)
      const text = ${JSON.stringify(story.answer)}
      if (upTo > 0) surface.chunk(0, text.slice(0, Math.ceil(text.length * upTo)))
      if (upTo >= 1) surface.end(0)
      panel.style.left = (x2 + 12) + 'px'
      panel.style.top = y1 + 'px'
      await sleep(80)
      panel.style.visibility = 'visible'
    }
    addEventListener('load', async () => {
      window.shot.locale(${JSON.stringify(lang)})
      window.shot.theme('light')
      window.shot.actions(${JSON.stringify(actions)})
      await new Promise((resolve) => { window.frameReady = resolve; window.shot.frame(${JSON.stringify(frameUrl)}, 1, 2) })
      window.shot.shown(1, 2)
      await sleep(60)
      ${steps}
    })
  })()`
  return capturePage('overlay')
    .replace('<meta charset="utf-8">', () => `<meta charset="utf-8"><script>
      window.ipc = { postMessage(raw) { const m = JSON.parse(raw); if (m.type === 'frame-ready') window.frameReady?.() } }
    </script><style>
      html { background: url(${frameUrl}) 0 0 / 100% 100% no-repeat !important; }
      #answer { position: fixed; z-index: 100; width: 440px; height: 160px; border: 0; border-radius: 12px; visibility: hidden; background: transparent;
        box-shadow: 0 14px 44px rgba(15, 23, 42, 0.24), 0 0 0 0.5px rgba(15, 23, 42, 0.2); }
      html.ended body > :not(#answer) { display: none !important; }
      #cursor { position: fixed; z-index: 101; width: 17px; height: 25px; display: none; pointer-events: none; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35)); }
    </style>`) + `<iframe id="answer"></iframe>
      <svg id="cursor" viewBox="0 0 17 25"><path d="M1 1v19.5l4.6-4.4 3 7.2 3.2-1.4-3-7h6.4z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>
      <script>${script.replace(/<\//g, '<\\/')}</script>`
}

/** The frozen desktop as a data URL, rendered once at 2x. */
async function desktopFrame() {
  const file = join(work, 'desktop.png')
  chrome(desktopHtml(), file, { ...DESK, scale: 2 })
  await shoot()
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`
}

/** The capture still (an annotated region with the toolbar) and the capture walk-through. */
async function captureImages(lang, frameUrl) {
  const frames = []
  const hold = (steps, times) => { for (let i = 0; i < times; i += 1) frames.push(steps) }
  const fractions = (count) => Array.from({ length: count }, (_, i) => (i + 1) / count)
  hold(`fire('mousemove', ${PICK[0] + 40}, ${PICK[1] + 60})`, 5)
  hold(`fire('mousemove', ${PICK[0]}, ${PICK[1]})`, 3)
  for (const f of fractions(6)) hold(`await drag(${JSON.stringify(PICK)}, ${f})`, f < 1 ? 1 : 7)
  const picked = `await drag(${JSON.stringify(PICK)})`
  hold(`${picked}; tool('rect'); point(${BOX[0]}, ${BOX[1]})`, 3)
  for (const f of fractions(5)) hold(`${picked}; tool('rect'); await drag(${JSON.stringify(BOX)}, ${f})`, f < 1 ? 1 : 4)
  const boxed = `${picked}; tool('rect'); await drag(${JSON.stringify(BOX)})`
  hold(`${boxed}; tool('arrow'); point(${ARROW[0]}, ${ARROW[1]})`, 3)
  for (const f of fractions(5)) hold(`${boxed}; tool('arrow'); await drag(${JSON.stringify(ARROW)}, ${f})`, f < 1 ? 1 : 6)
  const annotated = `${boxed}; tool('arrow'); await drag(${JSON.stringify(ARROW)})`
  const button = `[data-ai="${CAPTURE_STORY[lang].action}"]`
  hold(`${annotated}; hover('${button}')`, 8)
  hold(`${annotated}; await answer(0)`, 3)
  for (const f of fractions(10)) hold(`${annotated}; await answer(${f})`, f < 1 ? 1 : 26)

  const dir = join(work, `capture-${lang}`)
  mkdirSync(dir, { recursive: true })
  chrome(captureScene(lang, frameUrl, `${annotated}; cursor.style.display = 'none'`), join(OUT, lang, 'capture.png'), { ...DESK, scale: 2, budget: 4000 })
  const unique = [...new Set(frames)]
  const shotOf = (steps) => join(dir, `unique-${unique.indexOf(steps)}.png`)
  for (const steps of unique) chrome(captureScene(lang, frameUrl, steps), shotOf(steps), { ...DESK, scale: 1, budget: 4000 })
  await shoot()
  frames.forEach((steps, index) => writeFileSync(join(dir, `${String(index).padStart(3, '0')}.png`), readFileSync(shotOf(steps))))
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
const frameUrl = wants('capture') ? await desktopFrame() : null
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
  if (wants('capture')) await captureImages(lang, frameUrl)
  console.log(`${lang}: done`)
}
rmSync(work, { recursive: true, force: true })
process.exit(0)
