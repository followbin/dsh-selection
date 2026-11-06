// The floating toolbar and result panel: one system web view (WKWebView / WebView2) in one overlay window.
// Must run on the process main thread; window events are pumped from a Node timer.
import { join } from 'node:path'
import { Application } from '@webviewjs/webview'
import { dataDirectory } from '../shared/paths.mjs'
import { createNativeWindowTweaks, plainOverlayWindow } from './native-window.mjs'
import { pageHtml } from './page.mjs'
import { fitWindow, place, roomBelow } from './placement.mjs'

const PUMP_VISIBLE_MS = 16
const PUMP_HIDDEN_MS = 250
const PAGE_READY_TIMEOUT_MS = 5000
// The least height a panel gets for its answer before it scrolls: about eight lines plus the header and
// the follow-up box. Below the selection it may grow further, down to the bottom of the screen.
const PANEL_MIN_ROOM = 280

/**
 * Where the selection ended, in screen coordinates as selection-hook reports them.
 * @typedef {{ x: number, y: number, top: number, precise: boolean }} Anchor
 * `precise` means `y` is the selection's bottom edge; otherwise it is the mouse-up position.
 * `top` is the selection's top edge, used when the overlay has to go above the selection.
 */

/**
 * @param {{ onMessage: (message: any) => void, log: (level: string, message: string, fields?: object) => void }} options
 */
export async function createOverlay({ onMessage, log }) {
  const tweaks = createNativeWindowTweaks()
  const app = new Application()
  // Must happen before the first pump: tao activates the app when launching finishes.
  tweaks?.preventActivation()
  const ready = app.whenReady({ autoRun: false })
  let pump = null
  const setPump = (ms) => {
    if (pump?.ms === ms) return
    if (pump) clearInterval(pump.timer)
    pump = { ms, timer: setInterval(() => app.pumpEvents(), ms) }
  }
  setPump(PUMP_VISIBLE_MS)
  // tao resets the activation policy when launching finishes, so set it before and after.
  tweaks?.hideFromDock()
  await ready
  tweaks?.hideFromDock()

  // Never shown itself: on macOS its web view moves into a native panel, on Windows the tweaks take over.
  const win = app.createBrowserWindow({
    title: 'DSH Selection',
    width: 320,
    height: 80,
    logical: true,
    decorations: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    visible: false,
    focused: false,
    alwaysOnTop: true,
    windowsSkipTaskbar: true,
    macosHasShadow: false,
  })
  // WebView2 defaults its data folder next to the executable, i.e. inside the DSH install directory.
  const webContext = process.platform === 'win32'
    ? app.createWebContext({ dataDirectory: join(dataDirectory(), 'webview') })
    : undefined

  // Sizes the page reports: window size plus the primary card (anchored) and every clickable card.
  const layoutOf = {
    bar: { width: 420, height: 72, primary: { x: 18, y: 12, width: 384, height: 40 }, hits: [] },
    panel: { width: 456, height: 260, primary: { x: 18, y: 12, width: 420, height: 224 }, hits: [] },
  }
  let mode = 'hidden'
  /** @type {Anchor | null} */
  let anchor = null
  let placement = null
  let bounds = null
  // How tall the panel was last allowed to grow, as told to the page.
  let room = null
  // Once the user drags the window it stays where they put it: later size changes keep its top-left.
  let moved = false
  let drag = null

  let resolvePage
  const pageReady = new Promise((resolve) => { resolvePage = resolve })
  // The page must never leave its own document: a dropped or clicked link would otherwise load a foreign
  // page that keeps `window.ipc` and would receive every later selection. Only the first load is allowed,
  // and IPC is accepted only from the document that announced itself first.
  let loaded = false
  let pageUri = null
  const webview = win.createWebview({
    html: pageHtml(),
    transparent: true,
    webContext,
    navigationHandler: () => !loaded,
    newWindowHandler: () => false,
  })
  webview.setBackgroundColor(0, 0, 0, 0)
  webview.onIpcMessage((message) => {
    if (pageUri !== null && message.uri !== pageUri) return
    let parsed
    try {
      parsed = JSON.parse(message.body.toString())
    } catch {
      return
    }
    if (parsed?.type === 'page-ready' && pageUri === null) {
      pageUri = message.uri
      loaded = true
      resolvePage()
      return
    }
    if (pageUri === null || parsed?.type === 'page-ready') return
    if (parsed?.type === 'size') resize(parsed)
    else if (parsed?.type === 'page-error') log('warn', 'toolbar page error', { error: String(parsed.message).slice(0, 300) })
    else onMessage(parsed)
  })
  const overlayWindow = tweaks ? tweaks.adopt(win) : plainOverlayWindow(win)
  await Promise.race([pageReady, new Promise((resolve) => setTimeout(resolve, PAGE_READY_TIMEOUT_MS))])

  const call = (fn, ...args) => webview.evaluateScript(`window.bar.${fn}(${args.map((arg) => JSON.stringify(arg)).join(',')})`)

  function screenAt(point) {
    if (tweaks?.displayBoundsAt && process.platform === 'darwin') return tweaks.displayBoundsAt(point)
    const monitor = win.getMonitorFromPoint(point.x, point.y)
    if (!monitor) return null
    const scale = monitor.scaleFactor || 1
    return { x: monitor.position.x / scale, y: monitor.position.y / scale, width: monitor.size.width / scale, height: monitor.size.height / scale }
  }

  /** selection-hook reports physical pixels on Windows and points on macOS; layout works in points. */
  function toLogical(point) {
    if (process.platform !== 'win32') return point
    const scale = win.getMonitorFromPoint(point.x, point.y)?.scaleFactor || 1
    return { ...point, x: point.x / scale, y: point.y / scale, ...(point.top === undefined ? {} : { top: point.top / scale }) }
  }

  function apply() {
    const layout = layoutOf[mode]
    // A dragged window keeps its place; otherwise the primary card starts where the selection ends,
    // to its right and below it.
    const origin = moved && bounds
      ? { x: bounds.x, y: bounds.y }
      : { x: anchor.x - layout.primary.x, y: placement.top - layout.primary.y }
    const screen = moved && bounds ? screenAt({ x: origin.x + layout.primary.x, y: origin.y + layout.primary.y }) : screenAt(anchor)
    const next = fitWindow({ origin, layout, screen })
    if (bounds && Object.keys(next).every((key) => next[key] === bounds[key])) return
    bounds = next
    overlayWindow.setBounds(bounds)
  }

  /** The panel scrolls inside instead of growing past its room, so the window never has to move. */
  function setRoom(next) {
    const value = Number.isFinite(next) ? Math.floor(next) : null
    if (mode !== 'panel' || value === room) return
    room = value
    call('setRoom', value)
  }

  function resize(report) {
    if (report.mode !== 'bar' && report.mode !== 'panel') return
    layoutOf[report.mode] = { width: report.width, height: report.height, primary: report.primary, hits: report.hits ?? [] }
    if (report.mode === mode && placement) apply()
  }

  function show(nextMode, minRoom) {
    mode = nextMode
    setPump(PUMP_VISIBLE_MS)
    placement = place(anchor, minRoom, screenAt(anchor))
    setRoom(placement.room)
    apply()
    overlayWindow.showInactive()
  }

  return {
    /** @param {{ bar: object[], more: object[] }} toolbar Skills on the toolbar and in the ⋯ menu. */
    configure: (toolbar) => call('configure', toolbar),
    /** @param {Anchor} point In selection-hook coordinates. */
    showBar(point) {
      anchor = toLogical(point)
      moved = false
      drag = null
      call('showBar')
      show('bar', layoutOf.bar.primary.height)
    },
    showPanel(payload) {
      call('showPanel', payload)
      show('panel', PANEL_MIN_ROOM)
    },
    /** A request started: clears the result (or opens a new turn in the ask panel). */
    begin: (requestId, info) => call('begin', requestId, info),
    append: (requestId, chunk) => call('append', requestId, chunk),
    done: (requestId) => call('done', requestId),
    fail: (requestId, failure) => call('fail', requestId, failure),
    setSpeaking: (speaking) => call('setSpeaking', speaking),
    /** Opens or closes the ⋯ menu (normally done by the page itself). */
    setMenu: (open) => call('setMenu', open),
    flash: (skillId) => call('flash', skillId),
    setKeyable: (keyable) => overlayWindow.setKeyable(keyable),
    /** Whether the panel has the keyboard, i.e. the user is typing into it. */
    isKey: () => Boolean(overlayWindow.inspect().isKey),
    /**
     * Moves the window with the pointer. Points are the page's screen coordinates; only their
     * difference from the start is used, so their origin does not matter.
     * @param {'start' | 'move' | 'end'} phase
     */
    drag(phase, point) {
      if (!bounds || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
      if (phase === 'start') {
        drag = { x: point.x, y: point.y, bounds: { ...bounds } }
        moved = true
        return
      }
      if (!drag) return
      bounds = { ...bounds, x: Math.round(drag.bounds.x + point.x - drag.x), y: Math.round(drag.bounds.y + point.y - drag.y) }
      overlayWindow.setBounds(bounds)
      if (phase !== 'end') return
      drag = null
      const top = bounds.y + layoutOf[mode].primary.y
      setRoom(roomBelow(top, screenAt({ x: bounds.x + layoutOf[mode].primary.x, y: top })))
    },
    hide() {
      if (mode === 'hidden') return
      overlayWindow.hide()
      mode = 'hidden'
      placement = null
      bounds = null
      room = null
      moved = false
      drag = null
      call('reset')
      setPump(PUMP_HIDDEN_MS)
    },
    get mode() { return mode },
    /** Where the window was placed, in the same coordinates as `contains` (self tests and diagnostics). */
    get bounds() { return bounds },
    /** Whether a point (selection-hook coordinates) is on one of the visible cards, not their shadow margin. */
    contains(point) {
      if (mode === 'hidden' || !bounds) return false
      const { x, y } = toLogical(point)
      const cards = layoutOf[mode].hits.length ? layoutOf[mode].hits : [layoutOf[mode].primary]
      return cards.some((card) => x >= bounds.x + card.x && x <= bounds.x + card.x + card.width
        && y >= bounds.y + card.y && y <= bounds.y + card.y + card.height)
    },
    inspect: () => overlayWindow.inspect(),
    /** Makes the page report its layout through onMessage (self tests). */
    probe: () => call('probe'),
    /** Clicks an element in the page through its own click handling (self tests). */
    click: (selector) => call('click', selector),
    dispose() {
      if (pump) clearInterval(pump.timer)
      app.exit()
    },
  }
}
