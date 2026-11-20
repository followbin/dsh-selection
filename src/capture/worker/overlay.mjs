// One overlay per display: a native window holding the frozen frame on its own layer,
// with a transparent web view above it as the editing surface.
//
// The windows and their web views are built once and kept hidden, because a web view
// cannot paint while its window is hidden (requestAnimationFrame is throttled), so
// building them on the hotkey would put the first frame hundreds of milliseconds late.
import { Application } from '@webviewjs/webview'
import { pageHtml } from './page.mjs'
import { createLoupe, colourText } from './loupe.mjs'

/** Scheme the overlay window serves its own crops on. */
const PROTOCOL = 'dshshot'

/** How often the magnifier follows the pointer: faster than the display refreshes. */
const LOUPE_TICK_MS = 8

const PUMP_VISIBLE_MS = 16
const PUMP_HIDDEN_MS = 250
const PAGE_READY_TIMEOUT_MS = 5000
/** Without native layers the page shows the frame; a window waits this long for it at most. */
const FRAME_WAIT_MS = 600
/** Where the platform has no native layers, the page draws its own magnifier. */
const NO_LOUPE = Object.freeze({
  visible: false, colour: null,
  setFrame() {}, update() {}, hide() {}, refresh() {}, copied() {}, dispose() {},
})

/**
 * @param {{
 *   native: any,
 *   displays: () => import('./displays.mjs').Display[],
 *   onMessage: (displayId: number, message: any) => void,
 *   log: (level: string, message: string, fields?: object) => void,
 *   locale?: () => string,
 *   actions?: () => { id: string, name: string | null, icon: string }[],
 *   onClipboardText?: (text: string) => void,
 * }} options `actions` is the AI row, refreshed on every capture.
 */
export async function createOverlay({ native, displays, onMessage, log, locale = () => 'zh', actions = () => null, onClipboardText }) {
  /** How the magnifier shows a colour, and what the copy shortcut copies; Shift switches it. */
  let colourFormat = 'rgb'
  native.preventAppActivation()
  const app = new Application()
  const ready = app.whenReady({ autoRun: false })
  let pump = null
  const setPump = (ms) => {
    if (pump?.ms === ms) return
    if (pump) clearInterval(pump.timer)
    pump = { ms, timer: setInterval(() => app.pumpEvents(), ms) }
  }
  // Every window in this process is driven by this one pump. It idles slowly only when
  // nothing is on screen and nothing is being built: a window being created, a pinned
  // image being dragged and a streaming answer all wait on it, and at the idle rate each
  // of their steps costs up to a quarter of a second.
  const awake = new Set()
  let overlayVisible = false
  let pumpClosed = false
  // AppKit applies window changes made from script (ordering a window out, closing it) when
  // its event loop next runs. When the pump slows down, the change that slowed it is
  // usually a window going away, so run the loop once now rather than at the idle tick.
  const syncPump = () => {
    const ms = overlayVisible || awake.size > 0 ? PUMP_VISIBLE_MS : PUMP_HIDDEN_MS
    const slowing = pump !== null && pump.ms < ms
    setPump(ms)
    if (slowing) setImmediate(() => { if (!pumpClosed) app.pumpEvents() })
  }
  setPump(PUMP_HIDDEN_MS)
  // The toolkit resets the activation policy when launching finishes, so set it either side.
  native.hideFromDock()
  await ready
  native.hideFromDock()

  const html = pageHtml('overlay')
  /** @type {Map<number, any>} */
  let screens = new Map()
  let visible = false
  let round = 0
  let disposed = false

  async function buildScreen(display) {
    const win = app.createBrowserWindow({
      title: 'dsh-shot',
      width: Math.max(1, Math.round(display.width)),
      height: Math.max(1, Math.round(display.height)),
      logical: true,
      decorations: false,
      // With native layers the frame sits on the window's own layer beneath a transparent
      // page; without them the page paints the frame itself and the window can be opaque.
      transparent: native.nativeLayers,
      resizable: false,
      visible: false,
      focused: false,
      macosHasShadow: false,
      windowsSkipTaskbar: true,
      windowsUndecoratedShadow: false,
    })
    let loaded = false
    let pageUri = null
    // A crop is hundreds of kilobytes to several megabytes. Passing it as a base64 string
    // through evaluateScript puts that whole payload through the JS bridge, which is what
    // made a large region take the overlay down. The bytes are served over the window's own
    // protocol instead, so the page loads them as an ordinary image.
    const crops = new Map()
    let cropSeq = 0
    let frameServed = null
    win.registerProtocol(PROTOCOL, (request) => {
      // The last segment names the image on every platform; Windows serves the protocol at
      // http://scheme.host/path, so the host and path split differently there.
      const key = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? ''
      const isFrame = frameServed?.key === key
      const bytes = isFrame ? frameServed.bytes : crops.get(key)
      if (!bytes) return new Response('no such image', { status: 404 })
      return new Response(bytes, {
        headers: {
          'Content-Type': isFrame ? 'image/bmp' : 'image/png',
          'Cache-Control': 'no-store',
          // The page's own origin differs from this protocol's, so without CORS the
          // canvas it is drawn into is tainted and export throws.
          'Access-Control-Allow-Origin': '*',
        },
      })
    })
    const webview = win.createWebview({
      html,
      transparent: native.nativeLayers,
      // The page must never leave its own document: a navigation would keep `window.ipc`
      // and receive every later capture.
      navigationHandler: () => !loaded,
      newWindowHandler: () => false,
    })
    webview.setBackgroundColor(0, 0, 0, native.nativeLayers ? 0 : 255)

    let resolveReady
    const pageReady = new Promise((resolve) => { resolveReady = resolve })
    webview.onIpcMessage((message) => {
      if (pageUri !== null && message.uri !== pageUri) return
      let parsed
      try { parsed = JSON.parse(message.body.toString()) } catch { return }
      if (parsed?.type === 'page-ready') {
        if (pageUri !== null) return
        pageUri = message.uri
        loaded = true
        resolveReady()
        return
      }
      if (pageUri === null) return
      if (parsed?.type === 'page-error') {
        log('warn', 'overlay page error', { display: display.id, error: String(parsed.message).slice(0, 300) })
        return
      }
      // The magnifier shows only while the page is choosing a region, not once it is
      // editing one; the page says which.
      if (parsed?.type === 'mode') {
        const screen = screens.get(display.id)
        if (screen) { screen.mode = parsed.mode; if (!loupeWanted(screen)) screen.loupe.hide() }
        return
      }
      // Keys for the magnifier arrive from whichever page has focus, which need not be the
      // display the pointer is on; they act on the magnifier that is showing.
      if (parsed?.type === 'color-format') {
        colourFormat = colourFormat === 'rgb' ? 'hex' : 'rgb'
        for (const screen of screens.values()) screen.loupe.refresh()
        return
      }
      // A page that draws its own magnifier sends the text it copied.
      if (parsed?.type === 'copy-color' && typeof parsed.text === 'string') {
        onClipboardText?.(parsed.text)
        log('info', 'colour copied', { from: 'page' })
        return
      }
      if (parsed?.type === 'frame-ready') {
        const screen = screens.get(display.id)
        if (screen?.reveal && parsed.round === screen.reveal.round) screen.reveal.now()
        return
      }
      if (parsed?.type === 'copy-color') {
        const showing = [...screens.values()].find((sc) => sc.loupe.visible)
        if (!showing) return
        const text = colourText(showing.loupe.colour, colourFormat)
        onClipboardText?.(text)
        showing.loupe.copied(text)
        log('info', 'colour copied', { format: colourFormat })
        return
      }
      // Page messages are delivered synchronously inside app.pumpEvents(), which holds a
      // mutable borrow of the native application. A handler that creates a window there
      // (a pin, an answer panel) borrows it again and fails with "cannot be borrowed
      // mutably while another borrow is active". Handle them once the pump has returned.
      setImmediate(() => onMessage(display.id, parsed))
    })

    await Promise.race([pageReady, new Promise((resolve) => setTimeout(resolve, PAGE_READY_TIMEOUT_MS))])
    const window_ = native.createOverlayWindow({ bounds: display, taoWindow: win })
    const putCrop = (bytes) => {
      // One crop at a time per display: the previous one can never be requested again.
      crops.clear()
      const key = `c${cropSeq++}`
      crops.set(key, bytes)
      return native.protocolUrl(PROTOCOL, `crop/${key}`)
    }
    /** The frozen frame for a page that paints it (no native layers). */
    let frameSeq = 0
    const putFrame = (bytes) => {
      frameServed = bytes ? { key: `f${frameSeq++}`, bytes } : null
      return frameServed ? native.protocolUrl(PROTOCOL, `frame/${frameServed.key}`) : null
    }
    const call = (fn, ...args) =>
      webview.evaluateScript(`window.shot.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`)
    call('locale', locale())
    call('theme', native.systemTheme?.() ?? 'auto')
    const loupe = native.nativeLayers ? createLoupe({ native, window: window_, locale, format: () => colourFormat }) : NO_LOUPE
    return { display, win, webview, window: window_, call, putCrop, putFrame, frame: null, loupe, mode: 'idle', reveal: null }
  }

  async function rebuild(next) {
    const wanted = new Map(next.map((d) => [d.id, d]))
    for (const [id, screen] of screens) {
      if (!wanted.has(id)) {
        screen.loupe.dispose()
        screen.window.dispose()
        screens.delete(id)
        log('info', 'overlay window removed', { display: id })
      }
    }
    for (const [id, display] of wanted) {
      const existing = screens.get(id)
      if (existing) {
        // Same display, new geometry: move the window rather than rebuilding its web view.
        if (existing.display.width !== display.width || existing.display.height !== display.height
          || existing.display.x !== display.x || existing.display.y !== display.y) {
          existing.display = display
          existing.window.setBounds(display)
          log('info', 'overlay window moved', { display: id })
        }
        continue
      }
      try {
        screens.set(id, await buildScreen(display))
        log('info', 'overlay window built', { display: id })
      } catch (error) {
        log('error', 'overlay window failed', { display: id, error: String(error?.message ?? error) })
      }
    }
  }

  const loupeWanted = (screen) => screen.mode === 'idle' || screen.mode === 'picking'
  let loupeTimer = null
  let lastPointer = ''
  /**
   * Follow the pointer with the magnifier on whichever display it is over. Polled from the
   * global pointer rather than fed by page events, so it keeps pace with the pointer and
   * moves between displays without either page having to report anything.
   */
  function tickLoupe() {
    const p = native.cursorPoint()
    if (!p) return
    const key = `${p.x},${p.y}`
    if (key === lastPointer) return
    lastPointer = key
    for (const screen of screens.values()) {
      const d = screen.display
      const inside = p.x >= d.x && p.x < d.x + d.width && p.y >= d.y && p.y < d.y + d.height
      if (inside && loupeWanted(screen)) screen.loupe.update({ x: p.x - d.x, y: p.y - d.y }, d)
      else screen.loupe.hide()
    }
  }

  await rebuild(displays())

  return {
    /** The shared toolkit application; every other window in this process uses it too. */
    app,
    /** Keep the event pump at its fast rate while `key` is held (a window opening or open). */
    holdAwake(key) { awake.add(key); syncPump() },
    releaseAwake(key) { awake.delete(key); syncPump() },
    get ready() { return screens.size > 0 },
    get visible() { return visible },
    screenCount: () => screens.size,

    /** Rebuild after a topology change. Safe while hidden; callers hide first. */
    retopology: (next) => rebuild(next),

    /**
     * Freeze every display and raise the overlay.
     * @param {{ frames: Map<number, any>, keyDisplay: number }} input
     * @returns {number} the round id the pages will report back.
     */
    show({ frames, keyDisplay }) {
      round += 1
      overlayVisible = true
      syncPump()
      // Appearance can change between captures, so it is refreshed here rather than
      // only when the windows were built.
      const theme = native.systemTheme?.() ?? 'auto'
      const language = locale()
      const aiRow = actions()
      for (const [id, screen] of screens) {
        screen.call('theme', theme)
        screen.call('locale', language)
        if (aiRow) screen.call('actions', aiRow)
        const frame = frames.get(id) ?? null
        screen.frame = frame
        screen.mode = 'idle'
        screen.call('reset')
        if (native.nativeLayers) {
          screen.window.setFrameImage(frame)
          screen.loupe.setFrame(frame)
        } else {
          // The page paints the frame; the window stays hidden until it has, so the screen
          // never flashes an empty window.
          screen.window.setBounds(screen.display)
          screen.call('frame', frame ? screen.putFrame(native.frameBmp(frame)) : null, round, frame?.scale ?? 1)
        }
      }
      log('info', 'overlay shown', { round, screens: screens.size, keyDisplay })
      const shownRound = round
      const reveal = (id, screen) => {
        screen.reveal = null
        if (!visible || round !== shownRound) return
        screen.window.show({ key: id === keyDisplay })
        // Only now is the page compositing, so this is when its paint probe can start. The
        // backing ratio rides along so the page can size its canvas before any crop arrives.
        screen.call('shown', shownRound, screen.frame?.scale ?? 1)
      }
      visible = true
      if (native.nativeLayers) {
        for (const [id, screen] of screens) screen.window.show({ key: id === keyDisplay })
        native.activateApp()
        for (const screen of screens.values()) screen.call('shown', round, screen.frame?.scale ?? 1)
        lastPointer = ''
        clearInterval(loupeTimer)
        loupeTimer = setInterval(tickLoupe, LOUPE_TICK_MS)
        tickLoupe()
      } else {
        for (const [id, screen] of screens) {
          const timer = setTimeout(() => screen.reveal?.now(), FRAME_WAIT_MS)
          screen.reveal = { round, now: () => { clearTimeout(timer); reveal(id, screen) } }
        }
      }
      return round
    },

    hide(reason = 'unspecified') {
      if (visible) log('info', 'overlay hidden', { reason })
      clearInterval(loupeTimer)
      loupeTimer = null
      for (const screen of screens.values()) {
        // A window still waiting for its frame is not shown; its timer finds nothing to do.
        screen.reveal = null
        screen.loupe.hide()
        screen.loupe.setFrame(null)
        screen.window.hide()
        screen.frame = null
        screen.putFrame(null)
        // Clear while hidden, not on the way back up: a web view throttles script in a
        // hidden window, so a reset sent at show time can land after the window is
        // already on screen and the previous region flashes up first.
        screen.call('reset')
      }
      visible = false
      overlayVisible = false
      syncPump()
    },

    /** The frozen frame still held for one display, or null. */
    frameOf: (displayId) => screens.get(displayId)?.frame ?? null,
    displayOf: (displayId) => screens.get(displayId)?.display ?? null,

    /**
     * Hand one display's page the crop it should edit, as a URL its own window serves.
     * @param {number} displayId
     * @param {Buffer} png encoded crop bytes.
     * @param {number} ratio backing pixels per logical point.
     * @param {number | null} seq the page's number for the pick this crop answers.
     */
    sendCrop(displayId, png, ratio, seq) {
      const screen = screens.get(displayId)
      if (!screen) return
      screen.call('crop', screen.putCrop(png), ratio, seq)
    },

    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(loupeTimer)
      for (const screen of screens.values()) { screen.loupe.dispose(); screen.window.dispose() }
      screens.clear()
      if (pump) clearInterval(pump.timer)
      pump = null
      pumpClosed = true
    },
  }
}
