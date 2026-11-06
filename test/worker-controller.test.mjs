import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createController, cut } from '../src/worker/controller.mjs'

const INVALID = -99999
const FULL = 3
const SKILLS = [
  { id: 'translate', kind: 'prompt' }, { id: 'explain', kind: 'prompt' }, { id: 'ask', kind: 'ask' },
  { id: 'speak', kind: 'speak' }, { id: 'copy', kind: 'copy' }, { id: 'search', kind: 'search' },
]
const CONFIG = {
  enabled: true, trigger: 'auto', toolbarSize: 4, skills: SKILLS, disabledApps: ['Terminal'], maxTextLength: 20,
  searchTemplate: 'https://search.example/?q=%s', translateTarget: 'auto', languages: [{ code: 'en', name: 'English' }],
}

/** The overlay covers x 0–100, y 0–50 while visible. */
function fakeOverlay() {
  const overlay = {
    mode: 'hidden',
    bounds: null,
    calls: [],
    record: (...call) => overlay.calls.push(call),
    named: (name) => overlay.calls.filter(([call]) => call === name),
    configure: (toolbar) => overlay.record('configure', toolbar),
    showBar(anchor) {
      overlay.mode = 'bar'
      overlay.bounds = { x: 0, y: 0, width: 100, height: 50 }
      overlay.record('showBar', anchor)
    },
    showPanel(payload) {
      overlay.mode = 'panel'
      overlay.record('showPanel', payload)
    },
    begin: (id, info) => overlay.record('begin', id, info),
    append: (id, chunk) => overlay.record('append', id, chunk),
    done: (id) => overlay.record('done', id),
    fail: (id, failure) => overlay.record('fail', id, failure),
    flash: (id) => overlay.record('flash', id),
    setKeyable: (keyable) => overlay.record('setKeyable', keyable),
    drag: (phase, point) => overlay.record('drag', phase, point),
    hide() {
      overlay.mode = 'hidden'
      overlay.bounds = null
      overlay.record('hide')
    },
    contains: (point) => overlay.mode !== 'hidden' && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 50,
    key: false,
    isKey: () => overlay.key,
  }
  return overlay
}

function setup(config = CONFIG) {
  const overlay = fakeOverlay()
  const sent = []
  const logs = []
  const clipboard = []
  const opened = []
  const spoken = []
  const timers = []
  let clock = 1_000
  const controller = createController({
    overlay,
    speech: { stop: () => spoken.push('stop'), toggle: (text) => spoken.push(text) },
    send: (message) => sent.push(message),
    log: (level, message, fields) => logs.push({ level, message, fields }),
    writeClipboard: (text) => clipboard.push(text),
    openUrl: (url) => opened.push(url),
    positions: { invalid: INVALID, fullSelection: FULL },
    idPrefix: 'p1',
    now: () => clock,
    later: (callback, ms) => timers.push({ callback, ms }),
  })
  controller.configure(config)
  return {
    controller, overlay, sent, logs, clipboard, opened, spoken, timers,
    tick: (ms) => { clock += ms },
    select: (overrides = {}) => controller.onSelection({
      text: '  Hello world  ', programName: 'Safari', posLevel: FULL,
      startTop: { x: 300, y: 400 }, endBottom: { x: 500, y: 420 },
      mousePosStart: { x: 300, y: 410 }, mousePosEnd: { x: 500, y: 415 },
      ...overrides,
    }),
    runs: () => sent.filter((message) => message.type === 'run'),
  }
}

describe('worker controller: showing the toolbar', () => {
  test('splits skills between the toolbar and the ⋯ menu', () => {
    const { overlay } = setup()
    const [[, toolbar]] = overlay.named('configure')
    assert.deepEqual(toolbar.bar.map((skill) => skill.id), ['translate', 'explain', 'ask', 'speak'])
    assert.deepEqual(toolbar.more.map((skill) => skill.id), ['copy', 'search'])
  })

  test('a selection shows the toolbar under it and tells the Host only the app', () => {
    const { overlay, sent, select } = setup()
    select()
    assert.deepEqual(overlay.named('showBar'), [['showBar', { x: 500, y: 420, top: 400, precise: true }]])
    assert.deepEqual(sent, [{ type: 'selection', app: 'Safari' }])
  })

  test('without selection bounds the mouse position anchors it; without any position nothing shows', () => {
    const imprecise = setup()
    imprecise.select({ posLevel: 1 })
    assert.deepEqual(imprecise.overlay.named('showBar')[0][1], { x: 500, y: 415, top: 400, precise: false })
    const nowhere = setup()
    nowhere.select({ posLevel: 1, mousePosEnd: { x: INVALID, y: INVALID } })
    assert.equal(nowhere.overlay.mode, 'hidden')
  })

  test('blank text, disabled apps, a disabled toolbar and the modifier trigger keep it hidden', () => {
    const blank = setup()
    blank.select({ text: '   \n ' })
    blank.select({ programName: 'Terminal' })
    assert.equal(blank.overlay.mode, 'hidden')
    const off = setup({ ...CONFIG, enabled: false })
    off.select()
    assert.equal(off.overlay.mode, 'hidden')
    const modifier = setup({ ...CONFIG, trigger: 'modifier' })
    modifier.select()
    assert.equal(modifier.overlay.mode, 'hidden')
    modifier.controller.onKeyDown('Alt')
    modifier.select()
    assert.equal(modifier.overlay.mode, 'bar')
    modifier.controller.onKeyUp('Alt')
    modifier.controller.onKeyDown('Escape')
    modifier.select()
    assert.equal(modifier.overlay.mode, 'hidden', 'releasing Alt ends the modifier trigger')
  })

  test('the text is trimmed and capped before it can be sent', () => {
    const { controller, select, runs } = setup()
    select({ text: `  ${'x'.repeat(50)}  ` })
    controller.onPage({ type: 'skill', id: 'translate' })
    assert.equal(runs()[0].text, 'x'.repeat(20))
  })

  test('turning the toolbar off hides it at once', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.configure({ ...CONFIG, enabled: false })
    assert.equal(overlay.mode, 'hidden')
  })
})

describe('worker controller: dismissing', () => {
  test('a click outside dismisses, a click on the toolbar does not', () => {
    const { controller, overlay, logs, select } = setup()
    select()
    controller.onMouseDown({ x: 10, y: 10 })
    assert.equal(overlay.mode, 'bar')
    controller.onMouseDown({ x: 600, y: 600 })
    assert.equal(overlay.mode, 'hidden')
    assert.deepEqual(logs.at(-1).fields.reason, 'click-outside')
  })

  test('scrolling elsewhere dismisses the toolbar but not a result panel', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onMouseWheel({ x: 600, y: 600 })
    assert.equal(overlay.mode, 'panel')
    select()
    controller.onMouseWheel({ x: 600, y: 600 })
    assert.equal(overlay.mode, 'hidden')
  })

  test('typing dismisses the toolbar, except right after it appears and for modifier keys', () => {
    const { controller, overlay, select, tick } = setup()
    select()
    controller.onKeyDown('c')
    assert.equal(overlay.mode, 'bar', 'the hook may still be simulating a copy')
    tick(400)
    controller.onKeyDown('Shift')
    assert.equal(overlay.mode, 'bar')
    controller.onKeyDown('a')
    assert.equal(overlay.mode, 'hidden')
  })

  test('Escape dismisses everything, even a pinned panel, and stops reading aloud', () => {
    const { controller, overlay, spoken, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'pin', pinned: true })
    controller.onKeyDown('Escape')
    assert.equal(overlay.mode, 'hidden')
    assert.ok(spoken.includes('stop'))
  })

  test('a pinned panel survives clicks elsewhere; a new selection still replaces it', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'pin', pinned: true })
    controller.onMouseDown({ x: 600, y: 600 })
    assert.equal(overlay.mode, 'panel')
    select({ text: 'Another' })
    assert.equal(overlay.mode, 'bar')
    controller.onMouseDown({ x: 600, y: 600 })
    assert.equal(overlay.mode, 'hidden', 'the new toolbar is not pinned')
  })

  test('the close button and the menu dismiss even when pinned', () => {
    const { controller, overlay, sent, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'pin', pinned: true })
    controller.onPage({ type: 'close' })
    assert.equal(overlay.mode, 'hidden')
    select()
    controller.onPage({ type: 'menu', action: 'disable-app' })
    assert.deepEqual(sent.at(-1), { type: 'disable-app', app: 'Safari' })
    assert.equal(overlay.mode, 'hidden')
    select()
    controller.onPage({ type: 'menu', action: 'settings' })
    assert.deepEqual(sent.at(-1), { type: 'open-settings' })
  })

  test('a menu action the worker does not know never hides the window', () => {
    const { controller, overlay, sent, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    const before = sent.length
    for (const action of ['closed', 'open', undefined, '']) controller.onPage({ type: 'menu', action })
    assert.equal(overlay.mode, 'panel')
    assert.equal(sent.length, before)
  })

  test('a gesture that starts on the overlay never lets the app behind replace it', () => {
    const { controller, overlay, logs, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onMouseDown({ x: 10, y: 10 })
    select({ text: 'Still selected in Safari' })
    assert.equal(overlay.mode, 'panel')
    assert.equal(overlay.named('showBar').length, 1)
    assert.ok(!logs.some((entry) => entry.message === 'overlay replaced by a new selection'))
  })

  test('a pinned panel is replaced by a new selection, even one that ends over it', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'pin', pinned: true })
    controller.onMouseDown({ x: 600, y: 600 })
    select({ text: 'Dragged across the app, released over the panel', mousePosEnd: { x: 20, y: 20 } })
    assert.equal(overlay.mode, 'bar')
  })

  test('a shortcut such as ⌘C is not typing, whenever it comes', () => {
    const { controller, overlay, select, tick } = setup()
    select()
    tick(1000)
    for (const modifier of ['Meta', 'Control']) {
      controller.onKeyDown(modifier)
      controller.onKeyDown('c')
      controller.onKeyUp('c')
      controller.onKeyUp(modifier)
      assert.equal(overlay.mode, 'bar', modifier)
    }
    controller.onKeyDown('c')
    assert.equal(overlay.mode, 'hidden', 'plain typing still dismisses')
  })

  test('Escape typed into the panel is left to the page, which knows about input methods', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'ask' })
    overlay.key = true
    controller.onKeyDown('Escape')
    assert.equal(overlay.mode, 'panel')
    overlay.key = false
    controller.onKeyDown('Escape')
    assert.equal(overlay.mode, 'hidden')
  })

  test('the dismissal log carries positions, never the selected text', () => {
    const { controller, logs, select } = setup()
    select({ text: 'PRIVATE-TEXT' })
    controller.onMouseDown({ x: 600, y: 600 })
    assert.ok(!JSON.stringify(logs).includes('PRIVATE-TEXT'))
    assert.deepEqual(logs.at(-1).fields.point, { x: 600, y: 600 })
  })
})

describe('worker controller: skills', () => {
  test('a prompt skill opens a panel and asks the Host to run it', () => {
    const { controller, overlay, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'translate' })
    const [[, panel]] = overlay.named('showPanel')
    assert.equal(panel.skill.id, 'translate')
    assert.equal(panel.text, 'Hello world')
    assert.deepEqual(runs(), [{ type: 'run', requestId: 'p1-1-1', skillId: 'translate', text: 'Hello world', language: undefined, question: undefined, history: [] }])
    assert.deepEqual(overlay.named('begin'), [['begin', 'p1-1-1', { question: undefined }]])
  })

  test('answers stream into the panel; late answers of replaced requests are dropped', () => {
    const { controller, overlay, sent, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'translate' })
    controller.onResult({ requestId: 'p1-1-1', chunk: 'Hel' })
    controller.onPage({ type: 'retry' })
    assert.deepEqual(sent.filter((message) => message.type === 'cancel'), [{ type: 'cancel', requestId: 'p1-1-1' }])
    controller.onResult({ requestId: 'p1-1-1', chunk: 'late' })
    controller.onResult({ requestId: 'p1-1-2', chunk: 'Hello' })
    controller.onResult({ requestId: 'p1-1-2', done: true })
    assert.deepEqual(overlay.named('append'), [['append', 'p1-1-1', 'Hel'], ['append', 'p1-1-2', 'Hello']])
    assert.deepEqual(overlay.named('done'), [['done', 'p1-1-2']])
  })

  test('a failure is shown instead of done', () => {
    const { controller, overlay, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onResult({ requestId: 'p1-1-1', error: { code: 'TIMEOUT' }, done: true })
    assert.deepEqual(overlay.named('fail'), [['fail', 'p1-1-1', { code: 'TIMEOUT' }]])
    assert.deepEqual(overlay.named('done'), [])
  })

  test('the language menu re-translates, and only for translations', () => {
    const { controller, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'language', code: 'ja' })
    assert.equal(runs().length, 1)
    controller.onPage({ type: 'skill', id: 'translate' })
    controller.onPage({ type: 'language', code: 'ja' })
    assert.equal(runs().at(-1).language, 'ja')
    assert.equal(runs().at(-1).skillId, 'translate')
  })

  test('ask opens a keyboard panel first, then follow-ups carry the finished turns', () => {
    const { controller, overlay, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'ask' })
    assert.equal(runs().length, 0, 'nothing is sent before a question')
    assert.deepEqual(overlay.named('setKeyable').at(-1), ['setKeyable', true])
    controller.onPage({ type: 'ask', question: '   ' })
    assert.equal(runs().length, 0)
    controller.onPage({ type: 'ask', question: ' What is it? ' })
    controller.onResult({ requestId: runs()[0].requestId, chunk: 'A greeting.' })
    controller.onResult({ requestId: runs()[0].requestId, done: true })
    controller.onPage({ type: 'ask', question: 'x'.repeat(3000) })
    const [first, second] = runs()
    assert.equal(first.question, 'What is it?')
    assert.deepEqual(first.history, [])
    assert.equal(second.question.length, 2000)
    assert.deepEqual(second.history, [{ question: 'What is it?', answer: 'A greeting.' }])
  })

  test('copy writes the clipboard, flashes, then dismisses the toolbar unless something changed', () => {
    const { controller, overlay, clipboard, timers, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'copy' })
    assert.deepEqual(clipboard, ['Hello world'])
    assert.deepEqual(overlay.named('flash'), [['flash', 'copy']])
    assert.equal(timers[0].ms, 700)
    timers[0].callback()
    assert.equal(overlay.mode, 'hidden')
    select()
    controller.onPage({ type: 'skill', id: 'copy' })
    controller.onPage({ type: 'skill', id: 'explain' })
    timers[1].callback()
    assert.equal(overlay.mode, 'panel', 'a panel opened meanwhile stays')
  })

  test('search opens the engine with the encoded text and dismisses', () => {
    const { controller, overlay, opened, select } = setup()
    select({ text: 'a&b $1 中文' })
    controller.onPage({ type: 'skill', id: 'search' })
    assert.deepEqual(opened, [`https://search.example/?q=${encodeURIComponent('a&b $1 中文')}`])
    assert.equal(overlay.mode, 'hidden')
  })

  test('read aloud toggles speech with the selection', () => {
    const { controller, spoken, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'speak' })
    assert.equal(spoken.at(-1), 'Hello world')
  })

  test('unknown skills, and skills without a selection, do nothing', () => {
    const { controller, overlay, sent } = setup()
    controller.onPage({ type: 'skill', id: 'translate' })
    controller.onPage({ type: 'skill', id: 'nope' })
    assert.equal(overlay.mode, 'hidden')
    assert.deepEqual(sent, [])
  })

  test('dismissing cancels the request in flight', () => {
    const { controller, sent, select } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    controller.onPage({ type: 'close' })
    assert.deepEqual(sent.at(-1), { type: 'cancel', requestId: 'p1-1-1' })
  })
})

describe('worker controller: page messages', () => {
  test('copy-result and open-url pass only strings on', () => {
    const { controller, clipboard, opened } = setup()
    controller.onPage({ type: 'copy-result', text: 'answer' })
    controller.onPage({ type: 'copy-result', text: { evil: true } })
    controller.onPage({ type: 'open-url', url: 'https://example.com' })
    controller.onPage({ type: 'open-url', url: 42 })
    assert.deepEqual(clipboard, ['answer'])
    assert.deepEqual(opened, ['https://example.com'])
  })

  test('drag and keyboard requests go to the window', () => {
    const { controller, overlay } = setup()
    controller.onPage({ type: 'drag', phase: 'move', x: 5, y: 6 })
    controller.onPage({ type: 'keyboard', needed: true })
    assert.deepEqual(overlay.named('drag'), [['drag', 'move', { x: 5, y: 6 }]])
    assert.deepEqual(overlay.named('setKeyable').at(-1), ['setKeyable', true])
  })

  test('malformed messages are ignored', () => {
    const { controller } = setup()
    for (const message of [null, undefined, {}, { type: 'unknown' }]) controller.onPage(message)
  })
})

describe('worker controller: whole text and follow-ups', () => {
  test('copy, read aloud and search use the whole selection; the model gets it cut at a character boundary', () => {
    const { controller, clipboard, spoken, opened, select, runs } = setup()
    const text = `${'a'.repeat(19)}😀 and more`
    select({ text })
    controller.onPage({ type: 'skill', id: 'copy' })
    controller.onPage({ type: 'skill', id: 'speak' })
    assert.deepEqual(clipboard, [text])
    assert.equal(spoken.at(-1), text)
    controller.onPage({ type: 'skill', id: 'translate' })
    assert.equal(runs()[0].text, 'a'.repeat(19), 'no half of the emoji')
    select({ text })
    controller.onPage({ type: 'skill', id: 'search' })
    assert.equal(opened[0], `https://search.example/?q=${encodeURIComponent(text)}`)
  })

  test('cut keeps surrogate pairs whole', () => {
    assert.equal(cut('ab😀', 3), 'ab')
    assert.equal(cut('ab😀', 4), 'ab😀')
    assert.equal(cut('abc', 10), 'abc')
  })

  test('a follow-up after any skill carries that answer as the first turn', () => {
    const { controller, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'translate' })
    controller.onPage({ type: 'language', code: 'ja' })
    controller.onResult({ requestId: runs()[1].requestId, chunk: 'こんにちは' })
    controller.onResult({ requestId: runs()[1].requestId, done: true })
    controller.onPage({ type: 'ask', question: 'More polite?' })
    controller.onResult({ requestId: runs()[2].requestId, chunk: 'こんにちは。' })
    controller.onPage({ type: 'ask', question: 'Explain the difference' })
    const [, , first, second] = runs()
    assert.equal(first.skillId, 'ask')
    assert.deepEqual(first.history, [{ skillId: 'translate', language: 'ja', answer: 'こんにちは' }])
    assert.deepEqual(second.history, [
      { skillId: 'translate', language: 'ja', answer: 'こんにちは' },
      { question: 'More polite?', answer: 'こんにちは。' },
    ])
  })

  test('the header retry and the language menu run the panel skill again, after follow-ups too', () => {
    const { controller, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'translate' })
    controller.onResult({ requestId: runs()[0].requestId, chunk: 'Hi' })
    controller.onPage({ type: 'ask', question: 'Why?' })
    controller.onPage({ type: 'language', code: 'ja' })
    assert.deepEqual([runs()[2].skillId, runs()[2].language, runs()[2].history], ['translate', 'ja', []])
    controller.onPage({ type: 'retry' })
    assert.deepEqual([runs()[3].skillId, runs()[3].language], ['translate', 'ja'], 'the chosen language stays')
  })

  test('a failure retry runs only the request it belongs to', () => {
    const { controller, select, runs } = setup()
    select()
    controller.onPage({ type: 'skill', id: 'explain' })
    const first = runs()[0].requestId
    controller.onPage({ type: 'ask', question: 'More?' })
    controller.onPage({ type: 'retry', requestId: first })
    assert.equal(runs().length, 2, 'a stale failure does nothing')
    controller.onPage({ type: 'retry', requestId: runs()[1].requestId })
    assert.deepEqual([runs()[2].skillId, runs()[2].question], ['ask', 'More?'])
  })

  test('the header retry does nothing in an ask panel, and questions need an open panel', () => {
    const { controller, select, runs } = setup()
    controller.onPage({ type: 'ask', question: 'Anyone?' })
    select()
    controller.onPage({ type: 'ask', question: 'Anyone?' })
    assert.equal(runs().length, 0)
    controller.onPage({ type: 'skill', id: 'ask' })
    controller.onPage({ type: 'retry' })
    assert.equal(runs().length, 0)
  })
})
