import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { JSDOM, VirtualConsole } from 'jsdom'
import { pageHtml } from '../src/worker/page.mjs'

const HTML = pageHtml()
const RENDER_MS = 16
const FLASH_MS = 1200
const SVG_NS = 'http://www.w3.org/2000/svg'

const SKILL = {
  translate: { id: 'translate', kind: 'prompt', icon: 'translate', name: { zh: '翻译', en: 'Translate' } },
  summarize: { id: 'summarize', kind: 'prompt', icon: 'summarize', name: { zh: '总结', en: 'Summarize' } },
  ask: { id: 'ask', kind: 'ask', icon: 'ask', name: { zh: '问问 DSH', en: 'Ask DSH' } },
  speak: { id: 'speak', kind: 'speak', icon: 'speak', name: { zh: '朗读', en: 'Read aloud' } },
  copy: { id: 'copy', kind: 'copy', icon: 'copy', name: { zh: '复制', en: 'Copy' } },
  polish: { id: 'polish', kind: 'prompt', icon: 'polish', name: { zh: '润色', en: 'Polish' } },
  search: { id: 'search', kind: 'search', icon: 'search', name: { zh: '搜索', en: 'Search' } },
}
const TOOLBAR = { bar: [SKILL.translate, SKILL.ask, SKILL.speak, SKILL.copy], more: [SKILL.polish, SKILL.search] }
const LANGUAGES = [{ code: 'zh-CN', name: '简体中文' }, { code: 'en', name: 'English' }, { code: 'ja', name: '日本語' }]

const pages = []

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
})

afterEach(() => {
  const loaded = pages.splice(0)
  try {
    for (const page of loaded) assert.deepEqual(page.errors, [], 'the page reported errors')
  } finally {
    for (const page of loaded) page.window.close()
    mock.timers.reset()
  }
})

/** The exact page the web view loads, with everything it posts to the worker recorded. */
function loadPage({ language = 'en-US' } = {}) {
  const messages = []
  const errors = []
  const resizeObservers = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error.message))
  const { window } = new JSDOM(HTML, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.ipc = {
        postMessage(body) {
          const message = JSON.parse(body)
          messages.push(message)
          if (message.type === 'page-error') errors.push(`page-error: ${message.message}`)
        },
      }
      Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => language })
      // jsdom has neither of these. The ask answers copied below are single paragraphs, whose
      // innerText equals their textContent.
      window.ResizeObserver = class {
        constructor(callback) {
          this.callback = callback
          resizeObservers.push(this)
        }

        observe(target) {
          this.target = target
        }

        disconnect() {}
      }
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent } })
    },
  })
  const page = {
    window,
    document: window.document,
    body: window.document.body,
    bar: window.bar,
    messages,
    errors,
    resizeObservers,
    $: (selector) => element(page, selector),
    $$: (selector) => [...window.document.querySelectorAll(selector)],
    take: () => messages.splice(0),
  }
  pages.push(page)
  return page
}

function element(page, target) {
  if (typeof target !== 'string') return target
  const node = page.document.querySelector(target)
  assert.ok(node, `nothing matches ${target}`)
  return node
}

// What reaches the worker's handlePage: the overlay consumes `size` itself. `menu` and `close` hide
// the window, so a control or plain area that posts a stray message makes the panel vanish.
function sent(page) {
  return page.take().filter((message) => message.type !== 'size')
}

function sizeReports(page) {
  return page.take().filter((message) => message.type === 'size')
}

/** Size reports are batched in a microtask; this lets them run. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await null
}

const tick = (ms) => mock.timers.tick(ms)

function click(page, target) {
  const event = new page.window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: page.window })
  element(page, target).dispatchEvent(event)
  return event
}

async function clickEach(page, selectors) {
  const posted = {}
  for (const selector of selectors) {
    page.take()
    click(page, selector)
    await settle()
    posted[selector] = sent(page)
  }
  return posted
}

const nothingFrom = (selectors) => Object.fromEntries(selectors.map((selector) => [selector, []]))

function pointer(page, type, target, { x = 0, y = 0, button = 0, id = 1 } = {}) {
  const event = new page.window.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button, screenX: x, screenY: y })
  // jsdom has no PointerEvent; the page reads only pointerId on top of the mouse fields.
  Object.defineProperty(event, 'pointerId', { value: id })
  element(page, target).dispatchEvent(event)
  return event
}

/** Press, moves and release on one element, then the click a browser fires after the release. */
function dragAcross(page, target, [from, ...path]) {
  pointer(page, 'pointerdown', target, from)
  for (const point of path) pointer(page, 'pointermove', target, point)
  pointer(page, 'pointerup', target, path.at(-1) ?? from)
  return click(page, target)
}

const drag = (phase, x, y) => ({ type: 'drag', phase, x, y })

function keydown(page, init) {
  const event = new page.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  page.$('.composer textarea').dispatchEvent(event)
  return event
}

function typeQuestion(page, text) {
  const input = page.$('.composer textarea')
  input.value = text
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
}

function iconOf(page, node) {
  const drawn = node.querySelector('svg')?.innerHTML
  const probe = page.document.createElementNS(SVG_NS, 'svg')
  return Object.keys(page.window.DSH_ICONS).find((name) => {
    probe.innerHTML = page.window.DSH_ICONS[name]
    return probe.innerHTML === drawn
  })
}

/** Gives a card a layout box, which jsdom leaves at zero. */
function placeCard(page, selector, { x, y, width, height }) {
  page.$(selector).getBoundingClientRect = () => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height })
  return { x, y, width, height }
}

async function openToolbar(page, toolbar = TOOLBAR) {
  page.bar.configure(toolbar)
  page.bar.showBar({ app: 'Notes' })
  await settle()
  page.take()
}

async function openPanel(page, skill, payload = {}) {
  page.bar.showPanel({ skill, text: 'Selected text', app: 'Notes', languages: LANGUAGES, translateTarget: 'auto', ...payload })
  tick(1)
  await settle()
  page.take()
}

function streamAnswer(page, requestId, chunks, info = {}) {
  page.bar.begin(requestId, info)
  for (const chunk of [chunks].flat()) page.bar.append(requestId, chunk)
  page.bar.done(requestId)
  tick(RENDER_MS)
}

describe('loading', () => {
  test('posts page-ready once when loaded and starts hidden', async () => {
    const page = loadPage()
    await settle()
    assert.deepEqual(page.take(), [{ type: 'page-ready' }])
    assert.equal(page.body.dataset.mode, 'hidden')
  })

  test('reports uncaught errors in page code as page-error', () => {
    const page = loadPage()
    page.take()
    page.window.eval("setTimeout(() => { throw new Error('boom') })")
    tick(1)
    assert.deepEqual(page.take(), [{ type: 'page-error', message: 'boom' }])
    page.errors.length = 0
  })

  test('draws an icon on every fixed control', () => {
    const page = loadPage()
    const controls = {
      '.more-button': 'more',
      '[data-menu-action="disable-app"]': 'ban',
      '[data-menu-action="settings"]': 'settings',
      '[data-tool="pin"]': 'pin',
      '[data-tool="copy"]': 'copy',
      '[data-tool="retry"]': 'retry',
      '[data-tool="close"]': 'close',
      '.composer .send': 'send',
    }
    const drawn = Object.fromEntries(Object.keys(controls).map((selector) => [selector, iconOf(page, page.$(selector))]))
    assert.deepEqual(drawn, controls)
  })
})

describe('language', () => {
  const LABELS = {
    en: {
      controls: ['More', 'Translate to', 'Keep open', 'Copy result', 'Regenerate', 'Close', 'Send'],
      menu: ['Disable in this app', 'More settings…'],
      placeholder: 'Ask something about this text…',
    },
    zh: {
      controls: ['更多', '译为', '固定窗口', '复制结果', '重新生成', '关闭', '发送'],
      menu: ['在此应用中禁用', '更多设置…'],
      placeholder: '就这段内容问点什么…',
    },
  }
  const labelsOf = (page) => ({
    controls: page.$$('[data-i18n-label]').map((node) => {
      assert.equal(node.title, node.getAttribute('aria-label'), 'the tooltip matches the accessible name')
      return node.getAttribute('aria-label')
    }),
    menu: page.$$('[data-menu-action]').map((node) => node.textContent),
    placeholder: page.$('.composer textarea').placeholder,
  })

  for (const [language, strings] of [['en-US', 'en'], ['zh-CN', 'zh'], ['zh-TW', 'zh'], ['ja-JP', 'en'], ['', 'en']]) {
    test(`labels the controls in ${strings === 'zh' ? 'Chinese' : 'English'} when the system language is ${language || 'empty'}`, () => {
      assert.deepEqual(labelsOf(loadPage({ language })), LABELS[strings])
    })
  }

  test('a Chinese page shows Chinese skill names, status text and failures', async () => {
    const page = loadPage({ language: 'zh-CN' })
    await openToolbar(page)
    assert.deepEqual(page.$$('.bar-skills [data-skill] span').map((span) => span.textContent), ['翻译', '问问 DSH', '朗读', '复制'])
    page.bar.setSpeaking(true)
    assert.equal(page.$('[data-skill="speak"] span').textContent, '停止')
    page.bar.flash('copy')
    assert.equal(page.$('[data-skill="copy"] span').textContent, '已复制')

    await openPanel(page, SKILL.translate)
    assert.equal(page.$('.panel-title').textContent, '翻译')
    assert.equal(page.$('.panel-app').textContent, '来自 Notes')
    assert.equal(page.$('.panel-language').options[0].textContent, '自动')
    page.bar.begin('r1', {})
    tick(RENDER_MS)
    assert.equal(page.$('.result').dataset.pending, '正在生成')
    page.bar.fail('r1', { code: 'NO_MODEL' })
    assert.equal(page.$('.failure').firstChild.textContent, 'DSH 里还没有可用的模型，请先在 DSH 设置中登录或填写 API Key')
    assert.equal(page.$('.failure button').textContent, '重试')
  })
})

describe('toolbar', () => {
  const skillButtons = (page, selector) => page.$$(selector).map((button) => ({
    id: button.dataset.skill,
    className: button.className,
    type: button.type,
    name: button.querySelector('span').textContent,
    icon: iconOf(page, button),
  }))
  const expectedButtons = (skills, className) => skills.map((skill) => ({ id: skill.id, className, type: 'button', name: skill.name.en, icon: skill.icon }))

  test('configure renders the toolbar skills and the ⋯ menu skills in order', () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    assert.deepEqual(skillButtons(page, '.bar-skills > button'), expectedButtons(TOOLBAR.bar, 'skill'))
    assert.deepEqual(skillButtons(page, '.menu-skills > button'), expectedButtons(TOOLBAR.more, 'menu-item'))
  })

  test('configuring again replaces the previous skills', () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    page.bar.configure({ bar: [SKILL.summarize], more: [] })
    assert.deepEqual(skillButtons(page, '.bar-skills > button'), expectedButtons([SKILL.summarize], 'skill'))
    assert.deepEqual(page.$$('.menu-skills > button'), [])
  })

  test('skill names are shown as text, never parsed as HTML', () => {
    const page = loadPage()
    const name = '<img src=x onerror="alert(1)">'
    page.bar.configure({ bar: [{ id: 'custom-1', kind: 'prompt', icon: 'sparkles', name }], more: [] })
    const button = page.$('[data-skill="custom-1"]')
    assert.equal(button.querySelector('span').textContent, name)
    assert.equal(button.querySelector('img'), null)
  })

  test('a custom name given as one string is used as is, and a missing translation falls back to English', () => {
    const page = loadPage({ language: 'zh-CN' })
    page.bar.configure({
      bar: [{ id: 'custom-1', kind: 'prompt', icon: 'list', name: '表格化' }, { id: 'custom-2', kind: 'prompt', icon: 'code', name: { en: 'Refactor' } }],
      more: [],
    })
    assert.deepEqual(page.$$('.bar-skills span').map((span) => span.textContent), ['表格化', 'Refactor'])
  })

  test('showBar shows the toolbar with the ⋯ menu closed', () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    page.bar.showBar({ app: 'Notes' })
    assert.equal(page.body.dataset.mode, 'bar')
    assert.equal(page.body.dataset.menu, 'closed')
    assert.equal(page.$('.more-button').getAttribute('aria-expanded'), 'false')
  })

  test('the ⋯ button opens and closes the menu without messaging the worker', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '.more-button')
    assert.equal(page.body.dataset.menu, 'open')
    assert.equal(page.$('.more-button').getAttribute('aria-expanded'), 'true')
    await settle()
    const opened = page.take()
    assert.deepEqual(opened.map((message) => message.type), ['size'])
    assert.equal(opened[0].hits.length, 2, 'the open menu is reported as a second clickable card')

    click(page, '.more-button svg')
    assert.equal(page.body.dataset.menu, 'closed')
    assert.equal(page.$('.more-button').getAttribute('aria-expanded'), 'false')
    await settle()
    const closed = page.take()
    assert.deepEqual(closed.map((message) => message.type), ['size'])
    assert.equal(closed[0].hits.length, 1)
  })

  test('clicking a toolbar skill posts skill and closes the menu', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '.more-button')
    click(page, '.bar-skills [data-skill="translate"]')
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'translate' }])
    assert.equal(page.body.dataset.menu, 'closed')
    assert.equal(page.$('.more-button').getAttribute('aria-expanded'), 'false')
  })

  test('clicking the icon or the name inside a skill button counts as clicking the button', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '[data-skill="ask"] svg')
    click(page, '[data-skill="ask"] span')
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'ask' }, { type: 'skill', id: 'ask' }])
  })

  test('clicking a skill in the ⋯ menu posts skill and closes the menu', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '.more-button')
    click(page, '.menu-skills [data-skill="search"] span')
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'search' }])
    assert.equal(page.body.dataset.menu, 'closed')
  })

  test('menu items post menu with their action', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '.more-button')
    click(page, '[data-menu-action="disable-app"]')
    assert.deepEqual(sent(page), [{ type: 'menu', action: 'disable-app' }])
    click(page, '[data-menu-action="settings"] svg')
    assert.deepEqual(sent(page), [{ type: 'menu', action: 'settings' }])
  })

  test('plain areas of the toolbar and the menu post nothing, whether the menu is open or closed', async () => {
    const page = loadPage()
    await openToolbar(page)
    const areas = ['html', 'body', '.stage', '.bar', '.bar-skills', '.divider', '.menu', '.menu-skills', '.menu-divider']
    for (const state of ['closed', 'open']) {
      page.bar.setMenu(state === 'open')
      assert.deepEqual(await clickEach(page, areas), nothingFrom(areas), `menu ${state}`)
      assert.equal(page.body.dataset.menu, state, 'the menu stays as it was')
    }
  })

  test('the worker can open the menu only while the toolbar shows', () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    page.bar.setMenu(true)
    assert.notEqual(page.body.dataset.menu, 'open', 'ignored while hidden')
    page.bar.showBar({ app: 'Notes' })
    page.bar.setMenu(true)
    assert.equal(page.body.dataset.menu, 'open')
    page.bar.showBar({ app: 'Notes' })
    assert.equal(page.body.dataset.menu, 'closed', 'a new toolbar starts with the menu closed')
    assert.equal(page.$('.more-button').getAttribute('aria-expanded'), 'false')
    page.bar.showPanel({ skill: SKILL.summarize, text: 'x', app: '', languages: [] })
    page.bar.setMenu(true)
    assert.equal(page.body.dataset.menu, 'closed', 'ignored while the panel shows')
  })

  test('bar.click runs a click through the page’s own routing', async () => {
    const page = loadPage()
    await openToolbar(page)
    page.bar.click('[data-menu-action="settings"]')
    assert.deepEqual(sent(page), [{ type: 'menu', action: 'settings' }])
    page.bar.click('.no-such-control')
    assert.deepEqual(sent(page), [])
  })
})

describe('panel clicks', () => {
  const ANSWER = 'Hello **world**\n\nSee [the docs](https://example.com/a?b=1&c=2).'

  async function openAnsweredPanel(page) {
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', ['Hello ', '**world**', '\n\nSee [the docs](https://example.com/a?b=1&c=2).'])
    await settle()
    page.take()
  }

  test('pin toggles and posts the new state each time', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    click(page, '[data-tool="pin"]')
    assert.deepEqual(sent(page), [{ type: 'pin', pinned: true }])
    assert.equal(page.$('[data-tool="pin"]').getAttribute('aria-pressed'), 'true')
    click(page, '[data-tool="pin"] svg')
    assert.deepEqual(sent(page), [{ type: 'pin', pinned: false }])
    assert.equal(page.$('[data-tool="pin"]').getAttribute('aria-pressed'), 'false')
  })

  test('copy posts the result as the Markdown the model wrote', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    click(page, '[data-tool="copy"]')
    assert.deepEqual(sent(page), [{ type: 'copy-result', text: ANSWER }])
  })

  test('copy flashes a check mark, then restores the copy icon', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    const copy = page.$('[data-tool="copy"]')
    click(page, copy)
    assert.equal(copy.classList.contains('done'), true)
    assert.equal(iconOf(page, copy), 'check')
    tick(FLASH_MS)
    assert.equal(copy.classList.contains('done'), false)
    assert.equal(iconOf(page, copy), 'copy')
  })

  test('copy posts nothing while there is no text yet', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    tick(RENDER_MS)
    click(page, '[data-tool="copy"]')
    assert.deepEqual(sent(page), [])
    assert.equal(page.$('[data-tool="copy"]').classList.contains('done'), false)
  })

  test('copy in an ask thread posts every answer as Markdown, joined by a blank line', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    streamAnswer(page, 'a1', 'First answer.', { question: 'What is it?' })
    streamAnswer(page, 'a2', 'Second **answer**.', { question: 'And then?' })
    click(page, '[data-tool="copy"]')
    assert.deepEqual(sent(page), [{ type: 'copy-result', text: 'First answer.\n\nSecond **answer**.' }])
  })

  test('copy in an ask thread leaves failure notices out', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    streamAnswer(page, 'a1', 'First answer.', { question: 'What is it?' })
    page.bar.begin('a2', { question: 'And then?' })
    page.bar.append('a2', 'Partial.')
    page.bar.fail('a2', { code: 'TIMEOUT', detail: 'after 60 s' })
    click(page, '[data-tool="copy"]')
    assert.deepEqual(sent(page), [{ type: 'copy-result', text: 'First answer.\n\nPartial.' }])
  })

  test('retry and close post their own messages', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    click(page, '[data-tool="retry"]')
    assert.deepEqual(sent(page), [{ type: 'retry' }])
    click(page, '[data-tool="close"] svg')
    assert.deepEqual(sent(page), [{ type: 'close' }])
  })

  test('the retry button in a failure notice retries that request', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    page.bar.fail('r1', { code: 'EMPTY' })
    click(page, '.failure button')
    assert.deepEqual(sent(page), [{ type: 'retry', requestId: 'r1' }])
  })

  test('choosing a language posts language with its code', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    const select = page.$('.panel-language')
    select.value = 'ja'
    select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
    assert.deepEqual(sent(page), [{ type: 'language', code: 'ja' }])
  })

  test('clicking the selected text expands and collapses it without messaging the worker', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    click(page, '.source')
    assert.equal(page.$('.source').classList.contains('expanded'), true)
    click(page, '.source')
    assert.equal(page.$('.source').classList.contains('expanded'), false)
    await settle()
    assert.deepEqual(sent(page), [])
  })

  test('plain areas of a result panel post nothing', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    const areas = [
      'html', 'body', '.stage', '.panel', '.panel-head', '.panel-icon', '.panel-icon svg', '.panel-title', '.panel-app', '.spacer',
      '.panel-language', '.panel-language option', '.panel-body', '.source', '.result', '.result p', '.result strong', '.composer',
    ]
    assert.deepEqual(await clickEach(page, areas), nothingFrom(areas))
  })

  test('plain areas of an ask thread post nothing', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    streamAnswer(page, 'a1', 'An **answer**.', { question: 'What is it?' })
    const areas = ['body', '.panel-head', '.thread', '.turn', '.question', '.answer', '.answer p', '.answer strong', '.composer', '.composer textarea']
    assert.deepEqual(await clickEach(page, areas), nothingFrom(areas))
  })

  test('links in an answer post open-url and never navigate', async () => {
    const page = loadPage()
    await openAnsweredPanel(page)
    const link = page.$('.result a')
    assert.equal(link.hasAttribute('href'), false)
    const event = click(page, link)
    assert.deepEqual(sent(page), [{ type: 'open-url', url: 'https://example.com/a?b=1&c=2' }])
    assert.equal(event.defaultPrevented, true)
    assert.equal(page.window.location.href, 'about:blank')
  })

  test('links in an ask answer work the same, also when the click lands on formatted text inside them', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    streamAnswer(page, 'a1', 'Read [**the guide**](https://example.com/guide).', { question: 'Where?' })
    const event = click(page, '.answer a strong')
    assert.deepEqual(sent(page), [{ type: 'open-url', url: 'https://example.com/guide' }])
    assert.equal(event.defaultPrevented, true)
  })
})

describe('showPanel', () => {
  test('sets the panel kind from the skill', () => {
    const page = loadPage()
    const custom = { id: 'custom-1', kind: 'prompt', icon: 'sparkles', name: 'Mine' }
    for (const [skill, kind] of [[SKILL.translate, 'translate'], [SKILL.ask, 'ask'], [SKILL.summarize, 'prompt'], [custom, 'prompt']]) {
      page.bar.showPanel({ skill, text: 'x', app: '', languages: [] })
      assert.equal(page.body.dataset.mode, 'panel')
      assert.equal(page.body.dataset.kind, kind, skill.id)
    }
  })

  test('shows the skill, the app the text came from and the selected text', () => {
    const page = loadPage()
    page.bar.showPanel({ skill: SKILL.translate, text: 'Some <b>selected</b> text', app: 'Notes', languages: [] })
    assert.equal(page.$('.panel-title').textContent, 'Translate')
    assert.equal(iconOf(page, page.$('.panel-icon')), 'translate')
    assert.equal(page.$('.panel-app').textContent, 'from Notes')
    assert.equal(page.$('.source').textContent, 'Some <b>selected</b> text')
    assert.equal(page.document.querySelector('.source b'), null)
    page.bar.showPanel({ skill: SKILL.summarize, text: 'Other text', app: '', languages: [] })
    assert.equal(page.$('.panel-title').textContent, 'Summarize')
    assert.equal(page.$('.panel-app').textContent, '')
  })

  test('lists Auto first, then the languages, and selects the translate target', () => {
    const page = loadPage()
    const options = () => [...page.$('.panel-language').options].map((option) => [option.value, option.textContent])
    page.bar.showPanel({ skill: SKILL.translate, text: 'x', app: '', languages: LANGUAGES, translateTarget: 'ja' })
    assert.deepEqual(options(), [['auto', 'Auto'], ['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語']])
    assert.equal(page.$('.panel-language').value, 'ja')

    page.$('.panel-language').value = 'en'
    page.bar.showPanel({ skill: SKILL.translate, text: 'y', app: '', languages: LANGUAGES })
    assert.equal(options().length, 4, 'the list is replaced, not appended to')
    assert.equal(page.$('.panel-language').value, 'auto')

    page.bar.showPanel({ skill: SKILL.summarize, text: 'z', app: '' })
    assert.deepEqual(options(), [['auto', 'Auto']])
  })

  test('resets the pin, the expanded text and the previous answers', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Old answer')
    await openPanel(page, SKILL.ask)
    streamAnswer(page, 'a1', 'Old reply', { question: 'Old question?' })
    click(page, '[data-tool="pin"]')
    click(page, '.source')

    await openPanel(page, SKILL.summarize, { text: 'New text' })
    assert.equal(page.$('[data-tool="pin"]').getAttribute('aria-pressed'), 'false')
    assert.equal(page.$('.source').classList.contains('expanded'), false)
    assert.equal(page.$('.source').textContent, 'New text')
    assert.equal(page.$('.result').innerHTML, '')
    assert.equal(page.$('.thread').children.length, 0)
    click(page, '[data-tool="pin"]')
    assert.deepEqual(sent(page), [{ type: 'pin', pinned: true }])
  })

  test('ignores chunks still arriving for the previous panel', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Old')
    await openPanel(page, SKILL.summarize)
    page.bar.append('r1', ' and late')
    page.bar.done('r1')
    tick(RENDER_MS)
    assert.equal(page.$('.result').innerHTML, '')
    assert.equal(page.$('.result').classList.contains('pending'), false)
  })

  test('an ask panel focuses the question box on the next task, which asks the worker for the keyboard', () => {
    const page = loadPage()
    page.take()
    page.bar.showPanel({ skill: SKILL.ask, text: 'x', app: '', languages: [] })
    const input = page.$('.composer textarea')
    assert.notEqual(page.document.activeElement, input)
    assert.deepEqual(sent(page), [])
    tick(1)
    assert.equal(page.document.activeElement, input)
    assert.deepEqual(sent(page), [{ type: 'keyboard', needed: true }])
  })

  test('an ask panel starts with an empty question box and a disabled send button', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, 'An unsent draft')
    page.bar.reset()
    await openPanel(page, SKILL.ask)
    assert.equal(page.$('.composer textarea').value, '')
    assert.equal(page.$('.composer .send').disabled, true)
  })

  test('a prompt panel leaves the keyboard alone', () => {
    const page = loadPage()
    page.take()
    page.bar.showPanel({ skill: SKILL.translate, text: 'x', app: '', languages: LANGUAGES })
    tick(1)
    assert.deepEqual(sent(page), [])
    assert.equal(page.document.activeElement, page.body)
  })
})

describe('streaming', () => {
  test('begin shows a pending answer once the render timer fires', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const result = page.$('.result')
    page.bar.begin('r1', {})
    assert.equal(result.classList.contains('pending'), false, 'not drawn synchronously')
    tick(RENDER_MS)
    assert.equal(result.classList.contains('pending'), true)
    assert.equal(result.dataset.pending, 'Generating')
    assert.equal(result.innerHTML, '')
  })

  test('chunks render as Markdown on the next render, and done ends the pending state', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const result = page.$('.result')
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Hello ')
    page.bar.append('r1', '**world**')
    assert.equal(result.innerHTML, '')
    tick(RENDER_MS)
    assert.equal(result.innerHTML, '<p>Hello <strong>world</strong></p>')
    assert.equal(result.classList.contains('pending'), true)
    page.bar.done('r1')
    tick(RENDER_MS)
    assert.equal(result.innerHTML, '<p>Hello <strong>world</strong></p>')
    assert.equal(result.classList.contains('pending'), false)
  })

  test('chunks that arrive within one render interval are drawn once', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const { DshMarkdown } = page.window
    const render = DshMarkdown.render
    const drawn = []
    DshMarkdown.render = (text) => {
      drawn.push(text)
      return render(text)
    }
    page.bar.begin('r1', {})
    for (const chunk of ['a', 'b', 'c']) page.bar.append('r1', chunk)
    tick(RENDER_MS)
    page.bar.append('r1', 'd')
    tick(RENDER_MS)
    assert.deepEqual(drawn, ['abc', 'abcd'])
  })

  test('chunks, done and fail for any other request are ignored', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const result = page.$('.result')
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Old')
    tick(RENDER_MS)
    page.bar.begin('r2', {})
    page.bar.append('r1', 'stale')
    page.bar.done('r1')
    page.bar.fail('r1', { code: 'TIMEOUT' })
    tick(RENDER_MS)
    assert.equal(result.innerHTML, '')
    assert.equal(result.classList.contains('pending'), true, 'r2 is still running')
    page.bar.append('r2', 'New')
    tick(RENDER_MS)
    assert.equal(result.innerHTML, '<p>New</p>')
  })

  test('fail shows the failure at once, after the partial answer', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const result = page.$('.result')
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Partial')
    page.bar.fail('r1', { code: 'TIMEOUT', detail: 'after 60 s' })
    assert.equal(result.classList.contains('pending'), false)
    assert.equal(result.querySelector('p').textContent, 'Partial')
    const failure = result.lastElementChild
    assert.equal(failure.className, 'failure')
    assert.equal(failure.firstChild.textContent, 'The model took too long to answer')
    assert.equal(failure.querySelector('small').textContent, 'after 60 s')
    assert.equal(failure.querySelector('button[data-tool="retry"]').textContent, 'Retry')
  })

  test('a render scheduled before a failure, or a late chunk, never erases it', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Partial')
    page.bar.fail('r1', { code: 'TIMEOUT' })
    tick(RENDER_MS)
    assert.equal(page.$('.result .failure').firstChild.textContent, 'The model took too long to answer')
    page.bar.append('r1', ' late')
    page.bar.done('r1')
    tick(RENDER_MS)
    assert.equal(page.$('.result .failure').firstChild.textContent, 'The model took too long to answer')
  })

  test('unknown failure codes get the generic message, and details are shown as text', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const detail = '<img src=x onerror="alert(1)">'
    page.bar.begin('r1', {})
    page.bar.fail('r1', { code: 'SOMETHING_NEW', detail })
    assert.equal(page.$('.failure').firstChild.textContent, 'The model request failed')
    assert.equal(page.$('.failure small').textContent, detail)
    assert.equal(page.document.querySelector('.result img'), null)
    page.bar.begin('r2', {})
    page.bar.fail('r2', { code: 'EMPTY' })
    assert.equal(page.$('.failure').firstChild.textContent, 'The model returned nothing')
    assert.equal(page.document.querySelector('.failure small'), null)
  })

  test('the next request clears the previous failure', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    page.bar.fail('r1', { code: 'TIMEOUT' })
    page.bar.begin('r2', {})
    tick(RENDER_MS)
    assert.equal(page.document.querySelector('.result .failure'), null)
    assert.equal(page.$('.result').classList.contains('pending'), true)
  })

  test('each ask goes into its own turn under its question', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    page.bar.begin('a1', { question: '<b>What</b> is it?' })
    tick(RENDER_MS)
    const [first] = page.$$('.turn')
    assert.equal(first.querySelector('.question').textContent, '<b>What</b> is it?')
    assert.equal(first.querySelector('.question b'), null)
    assert.equal(first.querySelector('.answer').classList.contains('pending'), true)
    page.bar.append('a1', 'It is **E**.')
    page.bar.done('a1')
    tick(RENDER_MS)
    streamAnswer(page, 'a2', 'Einstein.', { question: 'Who?' })

    const turns = () => page.$$('.turn').map((turn) => [turn.querySelector('.question').textContent, turn.querySelector('.answer').innerHTML])
    assert.deepEqual(turns(), [['<b>What</b> is it?', '<p>It is <strong>E</strong>.</p>'], ['Who?', '<p>Einstein.</p>']])
    assert.equal(page.$('.result').innerHTML, '')
    page.bar.append('a1', ' Stale.')
    tick(RENDER_MS)
    assert.deepEqual(turns(), [['<b>What</b> is it?', '<p>It is <strong>E</strong>.</p>'], ['Who?', '<p>Einstein.</p>']])
  })

  test('asking a follow-up while an answer streams stops the pending indicator on the earlier answer', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    page.bar.begin('a1', { question: 'First?' })
    page.bar.append('a1', 'Partial answer')
    tick(RENDER_MS)
    // The worker cancels a1 and starts a2; nothing more arrives for a1.
    page.bar.begin('a2', { question: 'Second?' })
    tick(RENDER_MS)
    const [earlier] = page.$$('.turn .answer')
    assert.equal(earlier.classList.contains('pending'), false)
  })

  test('streaming keeps the panel scrolled to the bottom unless the reader scrolled up', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    let top = 0
    Object.defineProperties(page.$('.panel-body'), {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 300 },
      scrollTop: { configurable: true, get: () => top, set: (value) => { top = value } },
    })
    const scrollTo = (value) => {
      top = value
      page.$('.panel-body').dispatchEvent(new page.window.Event('scroll'))
    }
    page.bar.begin('r1', {})
    scrollTo(700)
    page.bar.append('r1', 'More text')
    tick(RENDER_MS)
    assert.equal(top, 1000, 'follows the answer while at the bottom')
    scrollTo(100)
    page.bar.append('r1', ' and more')
    tick(RENDER_MS)
    assert.equal(top, 100, 'leaves a reader who scrolled up where they are')
    page.bar.done('r1')
    page.bar.begin('r2', { question: 'And then?' })
    assert.equal(top, 1000, 'asking something goes to the end')
    page.bar.append('r2', 'Then this.')
    tick(RENDER_MS)
    assert.equal(top, 1000, 'and follows the new answer')
  })
})

describe('ask composer', () => {
  test('Enter posts the trimmed question and empties the box', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, '  What does it mean?  ')
    const event = keydown(page, { key: 'Enter' })
    assert.deepEqual(sent(page), [{ type: 'ask', question: 'What does it mean?' }])
    assert.equal(event.defaultPrevented, true, 'no newline goes in')
    assert.equal(page.$('.composer textarea').value, '')
    assert.equal(page.$('.composer .send').disabled, true)
  })

  test('Shift+Enter does not submit', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, 'Line one')
    const event = keydown(page, { key: 'Enter', shiftKey: true })
    assert.deepEqual(sent(page), [])
    assert.equal(event.defaultPrevented, false, 'the newline goes in')
    assert.equal(page.$('.composer textarea').value, 'Line one')
  })

  test('Enter while an input method is composing does not submit', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, 'nihao')
    const event = keydown(page, { key: 'Enter', isComposing: true, keyCode: 229 })
    assert.deepEqual(sent(page), [])
    assert.equal(event.defaultPrevented, false)
    assert.equal(page.$('.composer textarea').value, 'nihao')
  })

  test('the Enter that confirms an input method candidate in WebKit does not submit', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    const input = page.$('.composer textarea')
    input.dispatchEvent(new page.window.CompositionEvent('compositionstart', { bubbles: true }))
    typeQuestion(page, '日本語')
    input.dispatchEvent(new page.window.CompositionEvent('compositionend', { bubbles: true, data: '日本語' }))
    keydown(page, { key: 'Enter', keyCode: 229 })
    assert.deepEqual(sent(page), [])
    keydown(page, { key: 'Enter', keyCode: 13 })
    assert.deepEqual(sent(page), [{ type: 'ask', question: '日本語' }])
  })

  test('empty or blank questions are not sent', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    for (const text of ['', '   ', '\n\t ']) {
      typeQuestion(page, text)
      keydown(page, { key: 'Enter' })
      const submit = new page.window.Event('submit', { bubbles: true, cancelable: true })
      page.$('.composer').dispatchEvent(submit)
      assert.equal(submit.defaultPrevented, true)
    }
    assert.deepEqual(sent(page), [])
  })

  test('the send button submits the question without leaving the page', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, 'Why?')
    click(page, '.composer .send svg')
    assert.deepEqual(sent(page), [{ type: 'ask', question: 'Why?' }])
    assert.equal(page.$('.composer textarea').value, '')
    assert.equal(page.window.location.href, 'about:blank')
  })

  test('the send button is enabled only while there is a question', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    const send = page.$('.composer .send')
    assert.equal(send.disabled, true)
    typeQuestion(page, 'x')
    assert.equal(send.disabled, false)
    typeQuestion(page, '   ')
    assert.equal(send.disabled, true)
    send.click()
    assert.deepEqual(sent(page), [])
  })

  test('Escape posts close', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    typeQuestion(page, 'Half a question')
    keydown(page, { key: 'Escape' })
    assert.deepEqual(sent(page), [{ type: 'close' }])
  })

  test('focusing the question box asks the worker for the keyboard', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    const input = page.$('.composer textarea')
    input.blur()
    input.focus()
    assert.deepEqual(sent(page), [{ type: 'keyboard', needed: true }])
  })

  test('pressing in the panel body asks for the keyboard, but only while the panel shows', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Some **answer**')
    for (const target of ['.panel-body', '.source', '.result strong']) {
      pointer(page, 'pointerdown', target)
      pointer(page, 'pointerup', target)
    }
    assert.deepEqual(sent(page), Array(3).fill({ type: 'keyboard', needed: true }))
    pointer(page, 'pointerdown', '.panel-head')
    pointer(page, 'pointerup', '.panel-head')
    assert.deepEqual(sent(page), [], 'the header is for dragging, not typing')
    await openToolbar(page)
    pointer(page, 'pointerdown', '.panel-body')
    assert.deepEqual(sent(page), [])
  })
})

describe('dragging', () => {
  test('pressing on the toolbar and moving past the threshold drags the window', async () => {
    const page = loadPage()
    await openToolbar(page)
    pointer(page, 'pointerdown', '.bar', { x: 100, y: 100 })
    assert.deepEqual(sent(page), [])
    pointer(page, 'pointermove', '.bar', { x: 110, y: 105 })
    assert.equal(page.body.dataset.dragging, 'true')
    pointer(page, 'pointermove', '.bar', { x: 130, y: 140 })
    pointer(page, 'pointerup', '.bar', { x: 130, y: 140 })
    assert.deepEqual(sent(page), [drag('start', 100, 100), drag('move', 110, 105), drag('move', 130, 140), drag('end', 130, 140)])
    assert.equal(page.body.dataset.dragging, undefined)
  })

  test('the panel header drags the window too', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    dragAcross(page, '.panel-title', [{ x: 300, y: 200 }, { x: 290, y: 230 }])
    assert.deepEqual(sent(page), [drag('start', 300, 200), drag('move', 290, 230), drag('end', 290, 230)])
  })

  test('movement under the threshold leaves an ordinary click', async () => {
    const page = loadPage()
    await openToolbar(page)
    const event = dragAcross(page, '[data-skill="translate"]', [{ x: 100, y: 100 }, { x: 102, y: 102 }, { x: 103, y: 100 }])
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'translate' }])
    assert.equal(event.defaultPrevented, false)
    assert.equal(page.body.dataset.dragging, undefined)
  })

  test('the click that ends a drag is swallowed', async () => {
    const page = loadPage()
    const phases = () => sent(page).map((message) => message.phase ?? message.type)
    await openToolbar(page)
    for (const target of ['[data-skill="translate"]', '.more-button']) {
      const event = dragAcross(page, target, [{ x: 100, y: 100 }, { x: 140, y: 100 }])
      assert.deepEqual(phases(), ['start', 'move', 'end'], target)
      assert.equal(event.defaultPrevented, true)
    }
    assert.equal(page.body.dataset.menu, 'closed', 'the ⋯ menu did not open')

    await openPanel(page, SKILL.translate)
    for (const target of ['[data-tool="close"]', '[data-tool="pin"] svg']) {
      dragAcross(page, target, [{ x: 100, y: 100 }, { x: 100, y: 130 }])
      assert.deepEqual(phases(), ['start', 'move', 'end'], target)
    }
    assert.equal(page.$('[data-tool="pin"]').getAttribute('aria-pressed'), 'false')
  })

  test('a drag released without a click does not swallow the next click', async () => {
    const page = loadPage()
    await openToolbar(page)
    pointer(page, 'pointerdown', '.bar', { x: 100, y: 100 })
    pointer(page, 'pointermove', '.bar', { x: 150, y: 100 })
    pointer(page, 'pointerup', '.bar', { x: 150, y: 100 })
    assert.equal(sent(page).length, 3)
    tick(1)
    click(page, '[data-skill="translate"]')
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'translate' }])
  })

  test('presses on the language list or the question box never start a drag', async () => {
    const page = loadPage()
    const pressAndMove = (target) => {
      pointer(page, 'pointerdown', target, { x: 100, y: 100 })
      pointer(page, 'pointermove', target, { x: 160, y: 130 })
      pointer(page, 'pointerup', target, { x: 160, y: 130 })
    }
    await openPanel(page, SKILL.translate)
    pressAndMove('.panel-language')
    assert.deepEqual(sent(page), [])
    await openPanel(page, SKILL.ask)
    pressAndMove('.composer textarea')
    assert.deepEqual(sent(page), [])
    assert.equal(page.body.dataset.dragging, undefined)
  })

  test('presses in the menu, in the panel body or with another button never start a drag', async () => {
    const page = loadPage()
    const pressAndMove = (target, button = 0) => {
      pointer(page, 'pointerdown', target, { x: 100, y: 100, button })
      pointer(page, 'pointermove', target, { x: 160, y: 130, button })
      pointer(page, 'pointerup', target, { x: 160, y: 130, button })
    }
    await openToolbar(page)
    click(page, '.more-button')
    pressAndMove('[data-menu-action="settings"]')
    pressAndMove('.bar', 2)
    assert.deepEqual(sent(page), [])
    await openPanel(page, SKILL.translate)
    pressAndMove('.result')
    assert.deepEqual(sent(page), [{ type: 'keyboard', needed: true }])
  })

  test('moves and releases from another pointer are ignored', async () => {
    const page = loadPage()
    await openToolbar(page)
    pointer(page, 'pointerdown', '.bar', { x: 100, y: 100, id: 1 })
    pointer(page, 'pointermove', '.bar', { x: 150, y: 100, id: 2 })
    assert.deepEqual(sent(page), [])
    pointer(page, 'pointermove', '.bar', { x: 110, y: 100, id: 1 })
    pointer(page, 'pointerup', '.bar', { x: 150, y: 100, id: 2 })
    assert.deepEqual(sent(page), [drag('start', 100, 100), drag('move', 110, 100)])
    assert.equal(page.body.dataset.dragging, 'true')
    pointer(page, 'pointerup', '.bar', { x: 112, y: 100, id: 1 })
    assert.deepEqual(sent(page), [drag('end', 112, 100)])
  })

  test('a cancelled pointer ends the drag', async () => {
    const page = loadPage()
    await openToolbar(page)
    pointer(page, 'pointerdown', '.bar', { x: 100, y: 100 })
    pointer(page, 'pointermove', '.bar', { x: 120, y: 100 })
    pointer(page, 'pointercancel', '.bar', { x: 125, y: 100 })
    assert.deepEqual(sent(page), [drag('start', 100, 100), drag('move', 120, 100), drag('end', 125, 100)])
    assert.equal(page.body.dataset.dragging, undefined)
    pointer(page, 'pointermove', '.bar', { x: 200, y: 100 })
    assert.deepEqual(sent(page), [])
  })
})

describe('speaking, flash and reset', () => {
  test('setSpeaking turns the read-aloud button into a stop button and back', async () => {
    const page = loadPage()
    await openToolbar(page)
    const button = page.$('.bar-skills [data-skill="speak"]')
    page.bar.setSpeaking(true)
    assert.deepEqual([iconOf(page, button), button.textContent], ['stop', 'Stop'])
    click(page, button)
    assert.deepEqual(sent(page), [{ type: 'skill', id: 'speak' }])
    page.bar.setSpeaking(false)
    assert.deepEqual([iconOf(page, button), button.textContent], ['speak', 'Read aloud'])
  })

  test('setSpeaking also updates a read-aloud item in the ⋯ menu', async () => {
    const page = loadPage()
    await openToolbar(page, { bar: [SKILL.translate], more: [SKILL.speak] })
    const item = page.$('.menu-skills [data-skill="speak"]')
    page.bar.setSpeaking(true)
    assert.deepEqual([iconOf(page, item), item.textContent, item.className], ['stop', 'Stop', 'menu-item'])
    page.bar.setSpeaking(false)
    assert.deepEqual([iconOf(page, item), item.textContent], ['speak', 'Read aloud'])
  })

  test('setSpeaking does nothing when read-aloud is not configured', async () => {
    const page = loadPage()
    await openToolbar(page, { bar: [SKILL.translate], more: [] })
    page.bar.setSpeaking(true)
    assert.equal(page.$('[data-skill="translate"]').textContent, 'Translate')
  })

  test('flash shows Copied on a toolbar skill, then restores it', async () => {
    const page = loadPage()
    await openToolbar(page)
    const button = page.$('.bar-skills [data-skill="copy"]')
    page.bar.flash('copy')
    assert.deepEqual([iconOf(page, button), button.textContent, button.classList.contains('done')], ['check', 'Copied', true])
    tick(FLASH_MS - 1)
    assert.equal(button.textContent, 'Copied')
    tick(1)
    assert.deepEqual([iconOf(page, button), button.textContent, button.classList.contains('done')], ['copy', 'Copy', false])
  })

  test('flash ignores skills that are not on the toolbar', async () => {
    const page = loadPage()
    await openToolbar(page, { bar: [SKILL.translate], more: [SKILL.copy] })
    page.bar.flash('copy')
    page.bar.flash('no-such-skill')
    const item = page.$('.menu-skills [data-skill="copy"]')
    assert.deepEqual([iconOf(page, item), item.textContent, item.classList.contains('done')], ['copy', 'Copy', false])
  })

  test('a second flash before the first one ends still restores the button', async () => {
    const page = loadPage()
    await openToolbar(page)
    const skill = page.$('.bar-skills [data-skill="copy"]')
    page.bar.flash('copy')
    tick(500)
    page.bar.flash('copy')
    tick(FLASH_MS * 2)
    assert.deepEqual([iconOf(page, skill), skill.textContent], ['copy', 'Copy'])

    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Text')
    click(page, '[data-tool="copy"]')
    tick(300)
    click(page, '[data-tool="copy"]')
    tick(FLASH_MS * 2)
    assert.equal(iconOf(page, page.$('[data-tool="copy"]')), 'copy')
  })

  test('reset hides the page, closes the menu and drops focus without posting anything', async () => {
    const page = loadPage()
    await openToolbar(page)
    click(page, '.more-button')
    page.bar.reset()
    assert.equal(page.body.dataset.mode, 'hidden')
    assert.equal(page.body.dataset.menu, 'closed')

    await openPanel(page, SKILL.ask)
    assert.equal(page.document.activeElement, page.$('.composer textarea'))
    page.bar.reset()
    assert.equal(page.body.dataset.mode, 'hidden')
    assert.equal(page.document.activeElement, page.body)
    await settle()
    assert.deepEqual(page.take(), [])
  })
})

describe('size reports', () => {
  const summary = (reports) => reports.map(({ mode, hits }) => ({ mode, hits: hits.length }))

  test('showBar and showPanel are each followed by one size report of their mode', async () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    await settle()
    page.bar.showBar({ app: 'Notes' })
    assert.deepEqual(sizeReports(page), [], 'reported after the current task')
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'bar', hits: 1 }])
    page.bar.showPanel({ skill: SKILL.summarize, text: 'x', app: '', languages: [] })
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'panel', hits: 1 }])
  })

  test('changes within one task produce a single report', async () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    page.bar.showBar({ app: 'Notes' })
    page.bar.setMenu(true)
    page.bar.setSpeaking(true)
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'bar', hits: 2 }])
  })

  test('the toolbar size covers the bar, the open menu and the margin around them', async () => {
    const page = loadPage()
    await openToolbar(page)
    const style = page.window.getComputedStyle(page.body)
    const margin = { right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom) }
    assert.ok(margin.right > 0 && margin.bottom > 0, 'the body keeps a margin for the card shadow')
    const bar = placeCard(page, '.bar', { x: 18, y: 12, width: 300.5, height: 40 })
    const menu = placeCard(page, '.menu', { x: 200, y: 58, width: 190, height: 120 })

    page.bar.setMenu(true)
    await settle()
    assert.deepEqual(sizeReports(page), [{
      type: 'size', mode: 'bar', width: Math.ceil(390 + margin.right), height: Math.ceil(178 + margin.bottom), primary: bar, hits: [bar, menu],
    }])
    page.bar.setMenu(false)
    await settle()
    assert.deepEqual(sizeReports(page), [{
      type: 'size', mode: 'bar', width: Math.ceil(318.5 + margin.right), height: Math.ceil(52 + margin.bottom), primary: bar, hits: [bar],
    }])
  })

  test('the panel size covers the panel and the margin around it', async () => {
    const page = loadPage()
    const style = page.window.getComputedStyle(page.body)
    const panel = placeCard(page, '.panel', { x: 18, y: 12, width: 420, height: 224 })
    page.bar.showPanel({ skill: SKILL.summarize, text: 'x', app: '', languages: [] })
    await settle()
    assert.deepEqual(sizeReports(page), [{
      type: 'size',
      mode: 'panel',
      width: Math.ceil(438 + parseFloat(style.paddingRight)),
      height: Math.ceil(236 + parseFloat(style.paddingBottom)),
      primary: panel,
      hits: [panel],
    }])
  })

  test('renders, text toggles and observed resizes report the size again', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    await settle()
    page.take()
    page.bar.append('r1', 'Growing answer')
    tick(RENDER_MS)
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'panel', hits: 1 }], 'after a render')
    click(page, '.source')
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'panel', hits: 1 }], 'after expanding the text')
    const [observer] = page.resizeObservers
    assert.equal(observer.target, page.$('.stage'))
    observer.callback([])
    await settle()
    assert.deepEqual(summary(sizeReports(page)), [{ mode: 'panel', hits: 1 }], 'after a resize')
  })

  test('nothing is reported while hidden', async () => {
    const page = loadPage()
    page.bar.configure(TOOLBAR)
    page.resizeObservers[0].callback([])
    await settle()
    assert.deepEqual(sizeReports(page), [])
    page.bar.showBar({ app: 'Notes' })
    page.bar.reset()
    page.resizeObservers[0].callback([])
    await settle()
    assert.deepEqual(sizeReports(page), [])
  })
})

describe('drag and drop', () => {
  test('dragging a link or file over the page cannot navigate it', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    for (const type of ['dragover', 'drop']) {
      for (const target of ['body', '.stage', '.result', '.composer textarea']) {
        const event = new page.window.Event(type, { bubbles: true, cancelable: true })
        page.$(target).dispatchEvent(event)
        assert.equal(event.defaultPrevented, true, `${type} on ${target}`)
      }
    }
    assert.deepEqual(sent(page), [])
  })
})

describe('follow-up questions', () => {
  test('the follow-up box grows with its text and scrolls only past its tallest size', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    const input = page.$('.composer textarea')
    let content = 31
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => content })
    typeQuestion(page, 'One line')
    assert.equal(input.style.height, '31px')
    assert.equal(input.style.overflowY, 'hidden', 'no scrollbar while everything fits')
    content = 150
    typeQuestion(page, 'One\ntwo\nthree\nfour\nfive')
    assert.equal(input.style.height, '96px')
    assert.equal(input.style.overflowY, 'auto')
  })

  test('a skill panel offers the follow-up box once its answer is complete', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    assert.equal(page.document.body.dataset.composer, undefined)
    assert.equal(page.$('.composer textarea').placeholder, 'Ask a follow-up…')
    page.bar.begin('r1', {})
    page.bar.append('r1', 'Hello')
    assert.equal(page.document.body.dataset.composer, undefined, 'not while it streams')
    page.bar.done('r1')
    assert.equal(page.document.body.dataset.composer, 'shown')
    await openPanel(page, SKILL.ask)
    assert.equal(page.$('.composer textarea').placeholder, 'Ask something about this text…')
  })

  test('a follow-up gets its own turn under the first answer, and copy takes every answer', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Hello, world')
    typeQuestion(page, 'More formal?')
    keydown(page, { key: 'Enter' })
    assert.deepEqual(sent(page), [{ type: 'ask', question: 'More formal?' }])
    streamAnswer(page, 'r2', 'Greetings, world.', { question: 'More formal?' })
    assert.equal(page.$('.result').textContent.trim(), 'Hello, world')
    assert.deepEqual(page.$$('.thread .question').map((node) => node.textContent), ['More formal?'])
    click(page, '[data-tool="copy"]')
    assert.deepEqual(sent(page), [{ type: 'copy-result', text: 'Hello, world\n\nGreetings, world.' }])
  })

  test('running the panel skill again starts the conversation over', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Hello')
    streamAnswer(page, 'r2', 'Hi there', { question: 'Shorter?' })
    page.bar.begin('r3', {})
    assert.equal(page.$$('.thread .turn').length, 0)
    assert.equal(page.document.body.dataset.composer, undefined)
  })

  test('a failed follow-up is asked again in place of its turn, and older retry buttons go away', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    streamAnswer(page, 'r1', 'Hello')
    page.bar.begin('r2', { question: 'Why?' })
    page.bar.fail('r2', { code: 'TIMEOUT' })
    click(page, '.thread .failure button')
    assert.deepEqual(sent(page), [{ type: 'retry', requestId: 'r2' }])
    assert.equal(page.$$('.thread .turn').length, 0)
    page.bar.begin('r3', { question: 'Why?' })
    page.bar.fail('r3', { code: 'TIMEOUT' })
    page.bar.begin('r4', { question: 'And?' })
    assert.equal(page.$$('.failure').length, 1, 'the earlier failure keeps its message')
    assert.equal(page.$$('.failure [data-tool="retry"]').length, 0, 'but not its button')
  })
})

describe('keys and confirmations', () => {
  test('Escape closes the panel from anywhere, unless an input method is using it', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.ask)
    keydown(page, { key: 'Escape', isComposing: true })
    keydown(page, { key: 'Escape', keyCode: 229 })
    assert.deepEqual(sent(page), [])
    keydown(page, { key: 'Escape' })
    assert.deepEqual(sent(page), [{ type: 'close' }])
    page.$('.panel-body').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.deepEqual(sent(page), [{ type: 'close' }])
  })

  test('a skill run from the ⋯ menu confirms on the ⋯ button', async () => {
    const page = loadPage()
    await openToolbar(page, { bar: [SKILL.translate], more: [SKILL.copy] })
    page.bar.flash('copy')
    assert.equal(iconOf(page, page.$('.more-button')), 'check')
    tick(1200)
    assert.notEqual(iconOf(page, page.$('.more-button')), 'check')
  })
})

describe('room from the worker', () => {
  test('the panel is held to its room, and fills it when it sits above the selection', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    const body = page.document.body
    page.bar.setRoom(280, true)
    assert.equal(body.style.getPropertyValue('--room'), '280px')
    assert.equal(body.dataset.fill, 'true')
    page.bar.setRoom(500, false)
    assert.equal(body.style.getPropertyValue('--room'), '500px')
    assert.equal(body.dataset.fill, undefined, 'below the selection it grows as it fills')
    page.bar.setRoom(null, true)
    assert.equal(body.style.getPropertyValue('--room'), 'none')
    assert.equal(body.dataset.fill, undefined, 'nothing to fill without a room')
    await settle()
    assert.ok(sizeReports(page).length > 0, 'the window follows the new size')
  })
})

describe('panels are separate', () => {
  test('a follow-up typed but not sent does not follow into the next panel', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.summarize)
    streamAnswer(page, 'r1', 'A summary.')
    typeQuestion(page, 'Is the second claim true?')
    page.bar.reset()
    await openPanel(page, SKILL.translate, { text: 'Another selection' })
    streamAnswer(page, 'r2', 'Hello')
    assert.equal(page.$('.composer textarea').value, '')
    keydown(page, { key: 'Enter' })
    assert.deepEqual(sent(page), [], 'Enter sends nothing')
  })
})

describe('hover', () => {
  test('hover styles wait for the pointer to move over the page after each show', async () => {
    const page = loadPage()
    const moved = () => 'pointer' in page.document.body.dataset
    await openToolbar(page)
    assert.equal(moved(), false, 'a button left hovered when the window hid does not light up')
    pointer(page, 'pointermove', '.bar')
    assert.equal(moved(), true)
    page.bar.showBar()
    assert.equal(moved(), false)
    pointer(page, 'pointermove', '.bar')
    await openPanel(page, SKILL.translate)
    assert.equal(moved(), false)
    pointer(page, 'pointermove', '.panel-head')
    page.bar.reset()
    assert.equal(moved(), false)
  })

  test('every hover rule in the stylesheet waits for that movement', () => {
    const css = readFileSync(new URL('../ui/toolbar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((match) => match[1].split(',')).map((selector) => selector.trim())
    const hovering = selectors.filter((selector) => selector.includes(':hover'))
    assert.ok(hovering.length >= 5)
    assert.deepEqual(hovering.filter((selector) => !selector.startsWith('[data-pointer]')), [])
  })
})

describe('quick successions', () => {
  test('an answer finished just before the next request begins is still drawn', async () => {
    const page = loadPage()
    await openPanel(page, SKILL.translate)
    page.bar.begin('r1', {})
    page.bar.append('r1', 'First answer.')
    page.bar.done('r1')
    page.bar.begin('r2', { question: 'And then?' })
    assert.equal(page.$('.result').textContent.trim(), 'First answer.', 'drawn without waiting for the render timer')
    tick(RENDER_MS)
    assert.equal(page.$('.result').textContent.trim(), 'First answer.')
    assert.deepEqual(page.$$('.thread .question').map((node) => node.textContent), ['And then?'])
  })
})
