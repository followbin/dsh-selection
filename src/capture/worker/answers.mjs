// Answer panels: a short conversation about one captured image. The worker owns each
// panel's window and its conversation; the Host owns the model call and streams pieces
// back by panel id, so a panel never talks to a provider itself.
//
// An unpinned panel closes when the user clicks anywhere outside it, as a popover does;
// a pinned one stays until closed.
import { createFloat, createSpare } from './float.mjs'
import { pageHtml } from './page.mjs'

const WIDTH = 440
const START_HEIGHT = 168
const MIN_HEIGHT = 120
const MAX_HEIGHT = 640
/** Room below a panel's top that makes a side worth choosing: about a medium answer. */
const WANTED_ROOM = 360
const GAP = 10
const EDGE = 8
/** The menu bar and similar chrome along a display's top edge. */
const TOP_INSET = 30
const RADIUS = 12
const AWAKE_KEY = 'answers'
const OUTSIDE_TICK_MS = 40

/**
 * @param {{
 *   app: any,
 *   native: any,
 *   log: (level: string, message: string, fields?: object) => void,
 *   locale: () => string,
 *   actionName: (id: string) => string | null,
 *   displays: () => { x: number, y: number, width: number, height: number }[],
 *   awake: { hold: (key: string) => void, release: (key: string) => void },
 *   onRequest: (request: {
 *     id: string, png: Buffer, action: string, question: string,
 *     history: { question: string | null, answer: string }[], followUp?: string,
 *   }) => void,
 *   onClipboardText: (text: string) => void,
 *   onOpenSettings: () => void,
 * }} options
 */
export function createAnswers({ app, native, log, locale, actionName, displays, awake, onRequest, onClipboardText, onOpenSettings }) {
  const html = pageHtml('answer')
  /**
   * @typedef {{ question: string | null, answer: string, state: 'streaming' | 'done' | 'failed' }} Exchange
   * @type {Map<string, {
   *   float: any, png: Buffer, action: string, question: string, exchanges: Exchange[],
   *   current: number, pinned: boolean, growUp: boolean, maxHeight: number, openedAt: number,
   * }>}
   */
  const panels = new Map()
  let opening = 0
  // A streaming answer is a run of script calls into its page; keep the pump fast while
  // any panel is open or opening.
  const syncAwake = () => {
    if (panels.size + opening > 0) awake.hold(AWAKE_KEY)
    else awake.release(AWAKE_KEY)
    syncOutside()
  }

  const spare = createSpare(async () => {
    awake.hold('answers-build')
    try {
      return await createFloat({
        app, native, html,
        bounds: { x: -20000, y: -20000, width: WIDTH, height: START_HEIGHT },
        level: native.LEVEL.float, key: true, shadow: true, log,
        onMessage: (message, api) => handle(message, api),
      })
    } finally {
      awake.release('answers-build')
    }
  }, { log })

  // --- placement -----------------------------------------------------------------
  /**
   * Where a panel for `rect` goes: below the region (where the capture toolbar was), else
   * beside it, else above it; the first side with room for a medium answer wins, and with
   * none the side with the most room. Returns the top-left, how tall the panel may grow,
   * and whether it grows upward (when it sits above the region).
   */
  function place(rect) {
    const all = displays()
    const cx = rect ? rect.x + rect.width / 2 : 0
    const cy = rect ? rect.y + rect.height / 2 : 0
    const screen = all.find((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) ?? all[0]
    if (!screen) return { x: 80, y: 80, maxHeight: MAX_HEIGHT, growUp: false, side: 'fallback' }
    const area = { left: screen.x + EDGE, top: screen.y + TOP_INSET, right: screen.x + screen.width - EDGE, bottom: screen.y + screen.height - EDGE }
    const r = rect ?? { x: area.left, y: area.top, width: 0, height: 0 }
    const clampX = (x) => Math.max(area.left, Math.min(x, area.right - WIDTH))
    const clampY = (y) => Math.max(area.top, Math.min(y, area.bottom - MIN_HEIGHT))
    const right = r.x + r.width
    const bottom = r.y + r.height
    const candidates = [
      { side: 'below', x: clampX(right - WIDTH), y: bottom + GAP, room: area.bottom - (bottom + GAP), fits: true },
      { side: 'right', x: right + GAP, y: clampY(r.y), room: area.bottom - clampY(r.y), fits: right + GAP + WIDTH <= area.right },
      { side: 'left', x: r.x - GAP - WIDTH, y: clampY(r.y), room: area.bottom - clampY(r.y), fits: r.x - GAP - WIDTH >= area.left },
      { side: 'above', x: clampX(right - WIDTH), y: r.y - GAP, room: r.y - GAP - area.top, fits: true, growUp: true },
    ].filter((c) => c.fits && c.room >= MIN_HEIGHT)
    const chosen = candidates.find((c) => c.room >= WANTED_ROOM)
      ?? candidates.sort((a, b) => b.room - a.room)[0]
      // No side has room: the panel goes over the region's lower right, inside the display.
      ?? { side: 'inside', x: clampX(right - WIDTH - EDGE), y: clampY(bottom - START_HEIGHT - EDGE), room: area.bottom - clampY(bottom - START_HEIGHT - EDGE) }
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, chosen.room))
    // A panel above the region is anchored by its bottom edge, just above the region.
    const y = chosen.growUp ? chosen.y - Math.min(START_HEIGHT, maxHeight) : chosen.y
    return { x: Math.round(chosen.x), y: Math.round(y), maxHeight, growUp: Boolean(chosen.growUp), side: chosen.side }
  }

  // --- outside clicks ------------------------------------------------------------------
  let outsideTimer = null
  let wasDown = false
  function syncOutside() {
    const any = [...panels.values()].some((entry) => !entry.pinned)
    if (any && !outsideTimer) {
      wasDown = native.leftButtonDown()
      outsideTimer = setInterval(checkOutside, OUTSIDE_TICK_MS)
    } else if (!any && outsideTimer) {
      clearInterval(outsideTimer)
      outsideTimer = null
    }
  }
  function checkOutside() {
    const down = native.leftButtonDown()
    const pressed = down && !wasDown
    wasDown = down
    if (!pressed) return
    const p = native.cursorPoint()
    if (!p) return
    for (const [id, entry] of panels) {
      if (entry.pinned || Date.now() - entry.openedAt < 300) continue
      const b = entry.float.bounds
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (!inside) close(id, 'clicked outside')
    }
  }

  // --- conversation ----------------------------------------------------------------
  async function open({ png, rect, action, prompt }) {
    opening += 1
    syncAwake()
    let float
    try {
      float = await spare.take()
    } finally {
      opening -= 1
    }
    const spot = place(rect)
    const name = action || 'ask'
    const question = String(prompt ?? '').trim()
    const entry = {
      float, png, action: name, question,
      exchanges: [{ question: name === 'ask' && question ? question : null, answer: '', state: 'streaming' }],
      current: 0, pinned: false, growUp: spot.growUp, maxHeight: spot.maxHeight, openedAt: Date.now(),
    }
    panels.set(float.id, entry)
    syncAwake()
    float.rounded(RADIUS)
    float.setBounds({ x: spot.x, y: spot.y, width: WIDTH, height: Math.min(START_HEIGHT, spot.maxHeight) })
    float.call('locale', locale())
    float.call('theme', native.systemTheme?.() ?? 'auto')
    float.call('thumbnail', float.putAsset('thumb.png', png))
    float.call('open', name, { plain: name === 'ocr', title: actionName(name) })
    float.show({ key: true })
    log('info', 'answer panel opened', { id: float.id, action: name, side: spot.side, rect, at: { x: spot.x, y: spot.y }, maxHeight: spot.maxHeight })
    request(float.id, 0)
    return float.id
  }

  /** (Re)run exchange `index`, with every finished exchange before it as history. */
  function request(id, index) {
    const entry = panels.get(id)
    if (!entry) return
    const exchange = entry.exchanges[index]
    exchange.answer = ''
    exchange.state = 'streaming'
    entry.current = index
    entry.float.call('begin', index, exchange.question)
    const first = entry.exchanges[0]
    // Without a first answer there is nothing to follow up on: a question typed after a
    // failed first turn starts the conversation over as that question.
    if (index > 0 && first.state !== 'done') {
      onRequest({ id, png: entry.png, action: 'ask', question: exchange.question ?? '', history: [] })
      return
    }
    const history = entry.exchanges.slice(0, index)
      .filter((e, i) => i === 0 || e.state === 'done')
      .map((e) => ({ question: e.question, answer: e.answer }))
    onRequest({
      id, png: entry.png, action: entry.action, question: entry.question, history,
      ...index > 0 ? { followUp: exchange.question ?? '' } : {},
    })
  }

  function resize(entry, height) {
    const h = Math.round(Math.max(MIN_HEIGHT, Math.min(entry.maxHeight, height)))
    const b = entry.float.bounds
    if (Math.abs(b.height - h) < 2) return
    entry.float.resizeTo(WIDTH, h, entry.growUp ? { x: 0, y: 1 } : undefined)
  }

  function handle(message, api) {
    const entry = panels.get(api.id)
    if (!entry) return
    const busy = entry.exchanges[entry.current]?.state === 'streaming'
    switch (message?.type) {
      case 'close': return close(api.id, 'closed')
      case 'pin':
        entry.pinned = !entry.pinned
        entry.float.call('pinned', entry.pinned)
        syncOutside()
        return
      case 'copy-text': return onClipboardText(String(message.text ?? ''))
      case 'regenerate': {
        const index = Number(message.index)
        if (busy || index !== entry.exchanges.length - 1) return
        return request(api.id, index)
      }
      case 'ask': {
        const text = String(message.text ?? '').trim()
        if (!text || busy) return
        entry.exchanges.push({ question: text, answer: '', state: 'streaming' })
        return request(api.id, entry.exchanges.length - 1)
      }
      case 'size': return resize(entry, Number(message.height) || START_HEIGHT)
      case 'open-settings': return onOpenSettings()
      default: return
    }
  }

  function close(id, reason) {
    const entry = panels.get(id)
    if (!entry) return
    // Out of the map first: a chunk still on its way finds no panel and is dropped.
    panels.delete(id)
    entry.float.dispose()
    syncAwake()
    log('info', 'answer panel closed', { id, reason, open: panels.size })
  }

  function exchangeOf(id) {
    const entry = panels.get(id)
    return entry ? { entry, exchange: entry.exchanges[entry.current] } : null
  }

  return {
    open,
    get count() { return panels.size },
    /** Forward one streamed piece to the panel that asked for it. */
    chunk(id, text) {
      const found = exchangeOf(id)
      if (!found || found.exchange.state !== 'streaming') return
      found.exchange.answer += text
      found.entry.float.call('chunk', found.entry.current, text)
    },
    end(id) {
      const found = exchangeOf(id)
      if (!found) return
      found.exchange.state = 'done'
      found.entry.float.call('end', found.entry.current)
    },
    fail(id, code, detail) {
      const found = exchangeOf(id)
      if (!found) return
      found.exchange.state = 'failed'
      found.entry.float.call('fail', found.entry.current, code, detail ?? '')
    },
    /** Build the spare panel in the background, after `delayMs`. */
    warm: (delayMs) => spare.warm(delayMs),
    closeAll() { for (const id of [...panels.keys()]) close(id, 'close all') },
    dispose() {
      this.closeAll()
      spare.dispose()
      if (outsideTimer) clearInterval(outsideTimer)
      outsideTimer = null
      awake.release(AWAKE_KEY)
    },
  }
}
