// What the toolbar does in response to the mouse, the keyboard, the page and the Host. No native code
// here: main.mjs connects it to selection-hook, the overlay window and the Host channel.

const COPY_FEEDBACK_MS = 700
// Keys pressed right after the toolbar appears may be selection-hook's own simulated copy.
const KEY_DISMISS_GRACE_MS = 300
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])
// Search engines read only the start of a query anyway.
const SEARCH_MAX_LENGTH = 2000

/**
 * @param {{
 *   overlay: Awaited<ReturnType<typeof import('./overlay.mjs').createOverlay>>,
 *   speech: { stop: () => void, toggle: (text: string) => void },
 *   send: (message: object) => void,
 *   log: (level: string, message: string, fields?: object) => void,
 *   writeClipboard: (text: string) => void,
 *   openUrl: (url: string) => void,
 *   positions: { invalid: number, fullSelection: number },
 *   idPrefix: string,
 *   now?: () => number,
 *   later?: (callback: () => void, ms: number) => unknown,
 * }} options `positions` are selection-hook's INVALID_COORDINATE and PositionLevel.SEL_FULL.
 *   `idPrefix` must differ between worker processes, so a late answer never lands in a new panel.
 */
export function createController({
  overlay, speech, send, log, writeClipboard, openUrl, positions, idPrefix,
  now = Date.now, later = setTimeout,
}) {
  let config = null
  /** `text` goes to the model and the panel; `full` is what Copy, Read aloud and Search use. */
  /** @type {{ id: number, text: string, full: string, app: string } | null} */
  let selection = null
  /** The skill the panel was opened with; the header's retry and language menu run it again. */
  /** @type {{ skillId: string, kind: string, language?: string } | null} */
  let panel = null
  /** @type {{ requestId: string, skillId: string, kind: string, language?: string, question?: string, answer: string, history: object[] } | null} */
  let active = null
  let pinned = false
  let shownAt = 0
  const held = new Set()
  // Whether the latest mouse press landed on the overlay. A gesture that starts there (dragging the
  // window, selecting part of an answer) belongs to the overlay, even if it ends somewhere else.
  let pressedOnOverlay = false
  let nextSelection = 0
  let nextRequest = 0

  const valid = (point) => Boolean(point) && point.x !== positions.invalid && point.y !== positions.invalid

  function configure(next) {
    config = next
    overlay.configure({ bar: next.skills.slice(0, next.toolbarSize), more: next.skills.slice(next.toolbarSize) })
    if (!next.enabled) dismiss({ force: true, reason: 'disabled' })
  }

  function onSelection(data) {
    if (!config?.enabled || (config.trigger === 'modifier' && !held.has('Alt'))) return
    const text = (data.text ?? '').trim()
    if (!text || config.disabledApps.includes(data.programName)) return
    // Dragging the overlay looks like a drag-selection to the hook, which then re-reads whatever is still
    // selected in the app behind it. A gesture that began on the overlay never replaces it.
    if (pressedOnOverlay && overlay.mode !== 'hidden') return
    const anchor = anchorOf(data)
    if (!anchor) return
    if (overlay.mode !== 'hidden') log('debug', 'overlay replaced by a new selection', { mode: overlay.mode, bounds: overlay.bounds })
    cancelActive()
    speech.stop()
    pinned = false
    panel = null
    overlay.setKeyable(false)
    selection = { id: ++nextSelection, text: cut(text, config.maxTextLength), full: text, app: data.programName }
    shownAt = now()
    overlay.showBar(anchor)
    // The text stays here until the user picks an action; the Host only learns which app it came from.
    send({ type: 'selection', app: data.programName })
  }

  function anchorOf(data) {
    if (data.posLevel >= positions.fullSelection && valid(data.endBottom) && valid(data.startTop)) {
      return { x: data.endBottom.x, y: data.endBottom.y, top: data.startTop.y, precise: true }
    }
    if (!valid(data.mousePosEnd)) return null
    const start = valid(data.mousePosStart) ? data.mousePosStart : data.mousePosEnd
    return { x: data.mousePosEnd.x, y: data.mousePosEnd.y, top: Math.min(start.y, data.mousePosEnd.y) - 10, precise: false }
  }

  function onMouseDown(point) {
    pressedOnOverlay = overlay.mode !== 'hidden' && overlay.contains(point)
    if (overlay.mode !== 'hidden' && !pressedOnOverlay) dismiss({ reason: 'click-outside', point })
  }

  function onMouseWheel(point) {
    if (overlay.mode === 'bar' && !overlay.contains(point)) dismiss({ reason: 'scroll-outside', point })
  }

  function onKeyDown(key) {
    if (MODIFIER_KEYS.has(key)) {
      held.add(key)
      return
    }
    if (key === 'Escape') {
      // The hook also sees keys typed into the panel. There the page handles Escape itself, and an
      // input method may be using it to cancel a composition.
      if (overlay.mode === 'panel' && overlay.isKey()) return
      speech.stop()
      dismiss({ force: true, reason: 'escape' })
    } else if (overlay.mode === 'bar' && !held.has('Meta') && !held.has('Control') && now() - shownAt > KEY_DISMISS_GRACE_MS) {
      // Typing elsewhere means the user has moved on; a shortcut such as ⌘C does not.
      dismiss({ reason: 'typing' })
    }
  }

  function onKeyUp(key) {
    held.delete(key)
  }

  function onPage(message) {
    switch (message?.type) {
      case 'skill':
        return runSkill(message.id)
      case 'menu':
        if (message.action !== 'disable-app' && message.action !== 'settings') return
        if (message.action === 'disable-app' && selection) send({ type: 'disable-app', app: selection.app })
        if (message.action === 'settings') send({ type: 'open-settings' })
        return dismiss({ force: true, reason: `menu-${message.action}` })
      case 'drag':
        overlay.drag(message.phase, { x: message.x, y: message.y })
        return
      case 'retry':
        if (message.requestId) {
          // A failure notice retries its own request, and only while that request is the one on screen.
          if (active?.requestId === message.requestId) {
            startRequest(active.skillId, active.kind, { language: active.language, question: active.question, history: active.history })
          }
        } else if (panel?.kind === 'prompt') {
          startRequest(panel.skillId, 'prompt', { language: panel.language, history: [] })
        }
        return
      case 'language':
        if (panel?.skillId === 'translate' && typeof message.code === 'string') {
          panel.language = message.code
          startRequest('translate', 'prompt', { language: message.code, history: [] })
        }
        return
      case 'ask':
        if (panel && typeof message.question === 'string' && message.question.trim()) {
          startRequest('ask', 'ask', { question: message.question.trim().slice(0, 2000), history: conversation() })
        }
        return
      case 'copy-result':
        if (typeof message.text === 'string') writeClipboard(message.text)
        return
      case 'open-url':
        if (typeof message.url === 'string') openUrl(message.url)
        return
      case 'pin':
        pinned = Boolean(message.pinned)
        return
      case 'keyboard':
        overlay.setKeyable(Boolean(message.needed))
        return
      case 'close':
        speech.stop()
        return dismiss({ force: true, reason: 'close-button' })
    }
  }

  function runSkill(id) {
    const skill = config?.skills.find((candidate) => candidate.id === id)
    if (!skill || !selection) return
    switch (skill.kind) {
      case 'prompt':
        panel = { skillId: skill.id, kind: 'prompt' }
        overlay.showPanel({ skill, text: selection.text, app: selection.app, languages: config.languages, translateTarget: config.translateTarget })
        return startRequest(skill.id, 'prompt', { history: [] })
      case 'ask':
        cancelActive()
        panel = { skillId: 'ask', kind: 'ask' }
        active = { requestId: '', skillId: 'ask', kind: 'ask', answer: '', history: [] }
        overlay.showPanel({ skill, text: selection.text, app: selection.app, languages: config.languages })
        // The ask box needs keystrokes; the non-activating panel takes them without activating this process.
        overlay.setKeyable(true)
        return
      case 'speak':
        return speech.toggle(selection.full)
      case 'copy': {
        writeClipboard(selection.full)
        overlay.flash('copy')
        const copied = selection.id
        later(() => {
          if (selection?.id === copied && overlay.mode === 'bar') dismiss({ reason: 'copied' })
        }, COPY_FEEDBACK_MS)
        return
      }
      case 'search':
        openUrl(config.searchTemplate.replace('%s', encodeURIComponent(cut(selection.full, SEARCH_MAX_LENGTH))))
        return dismiss({ force: true, reason: 'search' })
    }
  }

  function startRequest(skillId, kind, { language, question, history }) {
    if (!selection) return
    cancelActive()
    const requestId = `${idPrefix}-${selection.id}-${++nextRequest}`
    active = { requestId, skillId, kind, language, question, answer: '', history }
    overlay.begin(requestId, { question })
    send({ type: 'run', requestId, skillId, text: selection.text, language, question, history })
  }

  /**
   * The panel's finished turns, for a follow-up question. The first turn of a panel opened with
   * another skill is that skill's answer; the Host shows the model what it was asked to do there.
   */
  function conversation() {
    if (!active) return []
    const history = [...active.history]
    if (active.answer) {
      history.push(active.question
        ? { question: active.question, answer: active.answer }
        : { skillId: active.skillId, language: active.language, answer: active.answer })
    }
    return history
  }

  function onResult({ requestId, chunk, done, error }) {
    if (!active || active.requestId !== requestId) return
    if (chunk) {
      active.answer += chunk
      overlay.append(requestId, chunk)
    }
    if (error) overlay.fail(requestId, error)
    else if (done) overlay.done(requestId)
  }

  function cancelActive() {
    if (active?.requestId) send({ type: 'cancel', requestId: active.requestId })
    active = null
  }

  function dismiss({ force = false, reason = 'other', point } = {}) {
    if (overlay.mode === 'hidden' || (pinned && !force)) return
    // Positions only, never text: enough to tell a misplaced hit test from an intended dismissal.
    log('debug', 'overlay dismissed', { reason, mode: overlay.mode, point, bounds: overlay.bounds })
    cancelActive()
    pinned = false
    pressedOnOverlay = false
    selection = null
    panel = null
    overlay.setKeyable(false)
    overlay.hide()
  }

  return { configure, onSelection, onMouseDown, onMouseWheel, onKeyDown, onKeyUp, onPage, onResult }
}

/** Shortens text without splitting a surrogate pair, which encodeURIComponent and JSON would reject. */
export function cut(text, max) {
  if (text.length <= max) return text
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max
  return text.slice(0, end)
}
