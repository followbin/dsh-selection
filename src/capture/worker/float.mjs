// One floating web view window, used by every surface that outlives a capture: a pinned
// image, an answer panel. It is deliberately plain — the latency work belongs to the
// capture overlay, where a frame has to be up in tens of milliseconds. These windows open
// once and stay, so their content can simply be a page.
import { fileURLToPath } from 'node:url'

/** Scheme a floating window serves its own images on. */
const PROTOCOL = 'dshshotasset'
const PAGE_READY_TIMEOUT_MS = 5000
/** How often a window being dragged follows the pointer: faster than the display refreshes. */
const DRAG_TICK_MS = 7

let seq = 0
const clampUnit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * @param {{
 *   app: any,
 *   native: any,
 *   html: string,
 *   bounds: { x: number, y: number, width: number, height: number },
 *   level?: number,
 *   shadow?: boolean,
 *   key?: boolean,
 *   onMessage: (message: any, api: FloatWindow) => void,
 *   log: (level: string, message: string, fields?: object) => void,
 * }} options
 * @returns {Promise<FloatWindow>}
 */
export async function createFloat({ app, native, html, bounds, level, shadow = true, key = false, onMessage, log }) {
  const id = `f${++seq}`
  const win = app.createBrowserWindow({
    title: 'dsh-shot',
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
    logical: true,
    decorations: false,
    // Without native layers (Windows) the window is opaque and the system rounds and
    // shadows it; with them the page is transparent over the window's own layer.
    transparent: native.nativeLayers,
    resizable: false,
    visible: false,
    focused: false,
    macosHasShadow: false,
    windowsSkipTaskbar: true,
    windowsUndecoratedShadow: false,
  })

  /** Images this window serves to its own page, by key. */
  const assets = new Map()
  win.registerProtocol(PROTOCOL, (request) => {
    // The last segment names the asset on every platform (Windows serves the protocol at
    // http://scheme.host/path).
    const name = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? ''
    const bytes = assets.get(name)
    if (!bytes) return new Response('no such asset', { status: 404 })
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    })
  })

  let loaded = false
  let pageUri = null
  const webview = win.createWebview({
    html,
    transparent: native.nativeLayers,
    navigationHandler: () => !loaded,
    newWindowHandler: () => false,
  })
  if (native.nativeLayers) webview.setBackgroundColor(0, 0, 0, 0)
  // An opaque window shows this until the page paints; match the system appearance.
  else if (native.systemTheme?.() === 'dark') webview.setBackgroundColor(42, 42, 45, 255)
  else webview.setBackgroundColor(255, 255, 255, 255)

  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })

  const hosted = native.createHostedWindow({
    bounds, taoWindow: win,
    level: level ?? native.LEVEL.float,
    opaque: false, shadow, allSpaces: false,
  })

  /** @typedef {object} FloatWindow */
  const api = {
    id,
    get bounds() { return hosted.bounds() },
    call(fn, ...args) {
      return webview.evaluateScript(`window.surface.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`)
    },
    /** Publish one image this window's page can load by URL. */
    putAsset(name, bytes) {
      assets.set(name, bytes)
      return native.protocolUrl(PROTOCOL, `asset/${name}`)
    },
    setBounds(next) { hosted.setBounds(next) },
    moveBy(dx, dy) {
      const b = hosted.bounds()
      hosted.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height })
    },
    /**
     * Resize keeping one point of the window fixed: `anchor` is that point as fractions of
     * the current size, so zooming with the pointer at (0.3, 0.6) keeps what is under the
     * pointer where it was. Without an anchor the top-left corner stays put.
     */
    resizeTo(width, height, anchor) {
      const b = hosted.bounds()
      const ax = clampUnit(anchor?.x), ay = clampUnit(anchor?.y)
      hosted.setBounds({
        x: Math.round(b.x + (b.width - width) * ax),
        y: Math.round(b.y + (b.height - height) * ay),
        width: Math.round(width), height: Math.round(height),
      })
      // The page repaints at the new size a frame or two later; the shadow follows that.
      clearTimeout(shadowTimer)
      shadowTimer = setTimeout(() => hosted.invalidateShadow(), 50)
    },
    invalidateShadow: () => hosted.invalidateShadow(),
    /**
     * Set the frame exactly (top-left global coordinates). The caller owns the geometry;
     * the shadow follows a moment later, once the new size is on screen.
     */
    setFrameExact(rect) {
      hosted.setBounds(rect)
      clearTimeout(shadowTimer)
      shadowTimer = setTimeout(() => hosted.invalidateShadow(), 60)
    },
    /**
     * Show an image on the window's own layer, under the page. It scales with the window
     * in the same frame, where an image in the page would lag a frame behind each resize.
     * @param {Uint8Array} png
     */
    setNativeImage(png) {
      const next = native.imageFromPng(png)
      if (!next) throw new Error('pin image could not be decoded')
      if (!native.nativeLayers) {
        // No layer to hold it: the page shows the image, filling the window.
        api.call('image', api.putAsset(`image-${next.width}x${next.height}.png`, png))
        return { width: next.width, height: next.height }
      }
      hosted.setFrameImage(next)
      if (image) native.releaseFrame(image)
      image = next
      return { width: next.width, height: next.height }
    },
    rounded(r) { hosted.setCornerRadius(r) },
    rootLayer: () => hosted.rootLayer(),
    contentHeight: () => hosted.contentHeight(),
    /** Follow the global pointer until the left button is released. */
    startDrag: () => startDrag(),
    /** Make this the key window of an active app, so it gets hover, keys and focus. */
    focus() {
      hosted.show({ key: true })
      native.activateApp()
    },
    setAlpha(v) { hosted.setAlpha(v) },
    setLevel(v) { hosted.setLevel(v) },
    show({ key: wantKey = key } = {}) {
      hosted.show({ key: wantKey })
      if (wantKey) native.activateApp()
    },
    hide() { hosted.hide() },
    dispose() {
      stopDrag()
      clearTimeout(shadowTimer)
      assets.clear()
      hosted.dispose()
      if (image) { native.releaseFrame(image); image = null }
    },
    inspect: () => hosted.inspect(),
  }

  /**
   * The page only says a drag began; this process then moves the window itself, following
   * the global pointer until the button is released. Relaying every mouse move from the
   * page instead put each step one pump tick behind the pointer, and once a fast drag
   * left the window the page saw no more moves and the drag stopped - which also made it
   * impossible to reach another screen. Global coordinates cross screens naturally.
   */
  let shadowTimer = null
  let image = null
  let dragTimer = null
  function stopDrag() {
    if (dragTimer) clearInterval(dragTimer)
    dragTimer = null
  }
  function startDrag() {
    const start = native.cursorPoint()
    const origin = hosted.bounds()
    if (!start || !origin) return
    stopDrag()
    let last = { x: origin.x, y: origin.y }
    dragTimer = setInterval(() => {
      // Read the button from input state, not from events: a release outside every window
      // of this process sends this page no mouseup.
      if (!native.leftButtonDown()) { stopDrag(); return }
      const p = native.cursorPoint()
      if (!p) return
      const x = Math.round(origin.x + p.x - start.x), y = Math.round(origin.y + p.y - start.y)
      if (x === last.x && y === last.y) return
      last = { x, y }
      hosted.moveTopLeft(x, y)
    }, DRAG_TICK_MS)
  }

  webview.onIpcMessage((message) => {
    if (pageUri !== null && message.uri !== pageUri) return
    let parsed
    try { parsed = JSON.parse(message.body.toString()) } catch { return }
    if (parsed?.type === 'page-ready') {
      if (pageUri !== null) return
      pageUri = message.uri
      loaded = true
      // Pages style a few things per platform (Windows rounds and shadows the window itself).
      webview.evaluateScript(`document.documentElement.dataset.platform = ${JSON.stringify(native.platform)}`)
      resolveReady()
      return
    }
    if (pageUri === null) return
    if (parsed?.type === 'page-error') {
      log('warn', 'float page error', { id, error: String(parsed.message).slice(0, 300) })
      return
    }
    // Delivered inside app.pumpEvents(); acting on the toolkit from here re-borrows the
    // native application. Defer until the pump has returned (see overlay.mjs).
    setImmediate(() => {
      // A fault in one window's handler stays in that window: thrown out of here it would
      // be uncaught, and an uncaught error ends the worker and every window it owns.
      try {
        // Window gestures are answered here rather than by every caller: a page cannot place
        // its own window.
        if (parsed?.type === 'drag-start') { startDrag(); return }
        if (parsed?.type === 'resize') { api.resizeTo(parsed.width, parsed.height, parsed.anchor); return }
        if (parsed?.type === 'focus') { api.focus(); return }
        // The page's content is on screen: the shadow can now be cut to its shape.
        if (parsed?.type === 'shown') { hosted.invalidateShadow(); return }
        onMessage(parsed, api)
      } catch (error) {
        log('error', 'float message handler failed', { id, type: parsed?.type, error: String(error?.stack ?? error).slice(0, 800) })
      }
    })
  })

  await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, PAGE_READY_TIMEOUT_MS))])
  return api
}

/**
 * Keeps one window of a kind built, loaded and hidden, so opening one is a move and a
 * show rather than a window, a web view and a page load. Building a window takes about a
 * second and a half; taking the spare takes a few frames.
 * @param {() => Promise<any>} make builds one hidden window.
 * @param {{ log: Function, rebuildDelayMs?: number }} options
 */
export function createSpare(make, { log, rebuildDelayMs = 700 }) {
  let spare = null
  let building = null
  let disposed = false

  function build() {
    if (disposed || spare || building) return building
    building = make()
      .then((made) => {
        building = null
        if (disposed) { made.dispose(); return null }
        spare = made
        return made
      })
      .catch((error) => {
        building = null
        log('warn', 'building a spare window failed', { error: String(error?.message ?? error) })
        return null
      })
    return building
  }

  return {
    /** Start building the spare, after `delayMs`, unless one exists. */
    warm(delayMs = 0) { setTimeout(() => { void build() }, delayMs) },
    /** A ready window: the spare if there is one, else a fresh one. A new spare follows. */
    async take() {
      if (!spare && building) await building
      let ready = spare
      spare = null
      if (!ready) ready = await make()
      setTimeout(() => { void build() }, rebuildDelayMs)
      return ready
    },
    dispose() {
      disposed = true
      spare?.dispose()
      spare = null
    },
  }
}

/** Absolute path of a file in `ui/`, for the page builders. */
