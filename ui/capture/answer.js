// The answer panel: a short conversation about one captured image. The first turn is the
// AI action (or the typed question); later turns are follow-ups. The worker owns the
// conversation and the window; this page renders it and reports what the user did.
//
// Model output is untrusted text. Markdown goes through DshMarkdown, which escapes all of
// it before adding its own tags; plain replies (extracted text) are set as textContent.
'use strict'

const post = (o) => window.ipc.postMessage(JSON.stringify(o))
const $ = (id) => document.getElementById(id)
const body = document.body
const bodyEl = $('body'), thread = $('thread'), input = $('input'), sendEl = $('send')

const STRINGS = {
  en: {
    close: 'Close (Esc)', pin: 'Keep open when clicking elsewhere', unpin: 'Close when clicking elsewhere',
    copy: 'Copy', copied: 'Copied', again: 'Regenerate', retry: 'Try again', settings: 'Open settings',
    placeholder: 'Ask a follow-up…', send: 'Send', waiting: 'Thinking',
    ocr: 'Extract text', translate: 'Translate', explain: 'Explain', ask: 'Ask',
    NO_LLM: 'DSH’s model service is not ready yet.',
    NO_VISION_MODEL: 'No model in DSH can read images yet.',
    NO_ATTACHMENTS: 'DSH’s attachment store is not available.',
    TIMEOUT: 'The model took too long to answer.',
    EMPTY: 'The model returned nothing.',
    MODEL_FAILED: 'The model call failed.',
  },
  zh: {
    close: '关闭 (Esc)', pin: '固定：点击别处时不关闭', unpin: '取消固定：点击别处时关闭',
    copy: '复制', copied: '已复制', again: '重新生成', retry: '重试', settings: '打开设置',
    placeholder: '继续问…', send: '发送', waiting: '正在看图',
    ocr: '提取文字', translate: '翻译', explain: '解释', ask: '问一问',
    NO_LLM: 'DSH 的模型服务还没就绪。',
    NO_VISION_MODEL: 'DSH 里还没有能看图的模型。',
    NO_ATTACHMENTS: 'DSH 的附件存储不可用。',
    TIMEOUT: '模型太久没有回应。',
    EMPTY: '模型没有返回内容。',
    MODEL_FAILED: '模型调用失败。',
  },
}
let t = STRINGS.zh
let action = 'ask'
/** A custom action's own name; built-ins are named from the strings above. */
let title = null
let pinned = false
let plain = false
/** @type {{ el: HTMLElement, answer: HTMLElement, text: string, state: string }[]} */
let turns = []

function applyStrings() {
  $('close').title = t.close
  $('pin').title = pinned ? t.unpin : t.pin
  input.placeholder = t.placeholder
  sendEl.title = t.send
  $('title').textContent = title ?? t[action] ?? t.ask
  for (const turn of turns) {
    turn.answer.dataset.waiting = t.waiting
    turn.el.querySelector('[data-act="copy"]').title = t.copy
    turn.el.querySelector('[data-act="again"]').title = t.again
  }
}

// --- rendering -----------------------------------------------------------------
let frame = 0
const dirty = new Set()
function scheduleRender(turn) {
  dirty.add(turn)
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const atBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 48
    for (const item of dirty) paint(item)
    dirty.clear()
    if (atBottom) bodyEl.scrollTop = bodyEl.scrollHeight
    reportSize()
  })
}

function paint(turn) {
  if (turn.state === 'failed') return
  if (plain && turn.index === 0) turn.answer.textContent = turn.text
  else turn.answer.innerHTML = window.DshMarkdown.render(turn.text)
}

/** Ask the worker for a window that fits the conversation; it caps the height. */
let lastHeight = 0
function reportSize() {
  const panel = $('panel')
  const chrome = panel.offsetHeight - bodyEl.clientHeight
  const want = Math.ceil(chrome + thread.scrollHeight + 6)
  if (Math.abs(want - lastHeight) < 2) return
  lastHeight = want
  post({ type: 'size', height: want })
}

function markLast() {
  turns.forEach((turn, i) => turn.el.classList.toggle('last', i === turns.length - 1))
}

function syncComposer() {
  const busy = turns.some((turn) => turn.state === 'streaming' || turn.state === 'pending')
  sendEl.disabled = busy || input.value.trim() === ''
}

function createTurn(index, question) {
  const el = $('turnTemplate').content.firstElementChild.cloneNode(true)
  renderIcons(el)
  el.querySelector('.question').textContent = question ?? ''
  const answer = el.querySelector('.answer')
  if (plain && index === 0) answer.classList.add('plain')
  const turn = { el, answer, text: '', state: 'pending', index }
  el.querySelector('[data-act="copy"]').addEventListener('click', (e) => copy(turn, e.currentTarget))
  el.querySelector('[data-act="again"]').addEventListener('click', () => post({ type: 'regenerate', index }))
  thread.appendChild(el)
  turns[index] = turn
  applyStrings()
  markLast()
  return turn
}

function copy(turn, button) {
  post({ type: 'copy-text', text: turn.text })
  button.classList.add('copied')
  button.title = t.copied
  button.replaceChildren()
  button.insertAdjacentHTML('beforeend', '<i data-icon="check"></i>')
  renderIcons(button)
  setTimeout(() => {
    button.classList.remove('copied')
    button.title = t.copy
    button.replaceChildren()
    button.insertAdjacentHTML('beforeend', '<i data-icon="copy"></i>')
    renderIcons(button)
  }, 1200)
}

function setState(turn, state) {
  turn.state = state
  turn.el.classList.toggle('pending', state === 'pending')
  turn.el.classList.toggle('streaming', state === 'pending' || state === 'streaming')
  turn.el.classList.toggle('done', state === 'done')
  syncComposer()
}

// --- window gestures ---------------------------------------------------------------
// Dragging by the header: the worker follows the global pointer until release.
$('head').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target?.closest?.('button')) return
  post({ type: 'drag-start' })
  body.classList.add('dragging')
  e.preventDefault()
})
addEventListener('mouseup', () => body.classList.remove('dragging'))
addEventListener('mousedown', () => post({ type: 'focus' }))

$('close').addEventListener('click', () => post({ type: 'close' }))
$('pin').addEventListener('click', () => post({ type: 'pin' }))

// --- composer ------------------------------------------------------------------
function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(92, input.scrollHeight) + 'px'
  input.style.overflowY = input.scrollHeight > 92 ? 'auto' : 'hidden'
  reportSize()
}
function submit() {
  const text = input.value.trim()
  if (!text || turns.some((turn) => turn.state === 'streaming' || turn.state === 'pending')) return
  input.value = ''
  autosize()
  post({ type: 'ask', text })
}
$('composer').addEventListener('submit', (e) => { e.preventDefault(); submit() })
input.addEventListener('input', () => { autosize(); syncComposer() })
input.addEventListener('focus', () => $('composer').classList.add('focused'))
input.addEventListener('blur', () => $('composer').classList.remove('focused'))
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
})
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing) post({ type: 'close' }) })

// --- worker interface ------------------------------------------------------------
window.surface = {
  locale(code) { t = STRINGS[code] ?? STRINGS.en; applyStrings() },
  theme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode
    else delete document.documentElement.dataset.theme
  },
  thumbnail(src) { $('thumb').crossOrigin = 'anonymous'; $('thumb').src = src },
  /** A new conversation in this (reused) window. `plain` renders the first reply as raw text. */
  open(name, options = {}) {
    action = name || 'ask'
    title = options.title || null
    plain = Boolean(options.plain)
    turns = []
    thread.replaceChildren()
    input.value = ''
    lastHeight = 0
    autosize()
    this.pinned(false)
    applyStrings()
    requestAnimationFrame(() => requestAnimationFrame(() => post({ type: 'shown' })))
  },
  pinned(on) {
    pinned = Boolean(on)
    $('pin').setAttribute('aria-pressed', String(pinned))
    $('pin').title = pinned ? t.unpin : t.pin
  },
  /** Turn `index` is (re)starting: a new follow-up, or a regenerate of an existing turn. */
  begin(index, question) {
    const turn = turns[index] ?? createTurn(index, question)
    turn.text = ''
    turn.answer.replaceChildren()
    setState(turn, 'pending')
    scheduleRender(turn)
    if (index > 0) requestAnimationFrame(() => { bodyEl.scrollTop = bodyEl.scrollHeight })
  },
  chunk(index, piece) {
    const turn = turns[index]
    if (!turn || typeof piece !== 'string' || piece === '') return
    if (turn.state === 'pending') setState(turn, 'streaming')
    turn.text += piece
    scheduleRender(turn)
  },
  end(index) {
    const turn = turns[index]
    if (!turn) return
    setState(turn, 'done')
    scheduleRender(turn)
    if (index === turns.length - 1 && document.activeElement !== input) input.focus()
  },
  fail(index, code, detail) {
    const turn = turns[index]
    if (!turn) return
    setState(turn, 'failed')
    const box = document.createElement('div')
    box.className = 'failure'
    box.textContent = t[code] ?? t.MODEL_FAILED
    if (detail && !t[code]) {
      const small = document.createElement('small')
      small.textContent = String(detail).slice(0, 300)
      box.appendChild(small)
    }
    const row = document.createElement('div')
    row.className = 'row'
    const retry = document.createElement('button')
    retry.textContent = t.retry
    retry.addEventListener('click', () => post({ type: 'regenerate', index }))
    row.appendChild(retry)
    if (code === 'NO_VISION_MODEL' || code === 'NO_LLM') {
      const settings = document.createElement('button')
      settings.textContent = t.settings
      settings.addEventListener('click', () => post({ type: 'open-settings' }))
      row.appendChild(settings)
    }
    box.appendChild(row)
    turn.answer.replaceChildren(box)
    scheduleRender(turn)
  },
}

addEventListener('error', (e) => post({ type: 'page-error', message: String(e.message).slice(0, 200) }))
applyStrings()
post({ type: 'page-ready' })
