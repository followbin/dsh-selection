// Pinned captures. Each one is its own floating window that outlives the capture, so a
// pin keeps nothing of the session alive: it owns a copy of the finished PNG and nothing
// else. Several can be open at once and they are independent.
//
// The image sits on the window's own layer and every change of size is computed here, in
// floating point, and applied once per tick: an image drawn by the page, resized by the
// page, lagged a frame behind the window on every step and shook while zooming.
import { createFloat, createSpare } from './float.mjs'
import { pageHtml } from './page.mjs'
import { personHolds, shortcutArgs } from './modifiers.mjs'

/** A pin opens slightly down-right of where it was captured, so it does not hide the original. */
const OFFSET = 14
/** Cascade successive pins taken from the same place. */
const CASCADE = 22
const AWAKE_KEY = 'pins'
/** How often the host checks which pin the pointer is over. */
const HOVER_TICK_MS = 50
/** How often a corner resize follows the pointer. */
/**
 * How often a corner drag samples the pointer. On Windows each new size also resizes the
 * page's WebView2, which redraws at most once per display frame; sampling faster only queues
 * sizes it draws late, so the pin trails the pointer.
 */
const RESIZE_TICK_MS = { darwin: 7, win32: 16 }
const ZOOM_MIN = 0.15
const ZOOM_MAX = 5
/** Smallest side, in points, a pin can be resized or zoomed down to. */
const MIN_SIDE = 36
const OPACITY_MIN = 0.2
/** How long the size badge and the gesture state outlast the last zoom step. */
const SETTLE_MS = 900
const CORNER_RADIUS = 6
const BADGE_MARGIN = 6

const STRINGS = {
  zh: { opacity: '不透明度' },
  en: { opacity: 'Opacity' },
}

/**
 * @param {{
 *   app: any,
 *   native: any,
 *   log: (level: string, message: string, fields?: object) => void,
 *   locale: () => string,
 *   awake: { hold: (key: string) => void, release: (key: string) => void },
 *   onAction: (action: string, pin: { png: Buffer, rect: object }) => void,
 * }} options
 */
export function createPins({ app, native, log, locale, awake, onAction }) {
  const html = pageHtml('pin')
  /** @type {Map<string, any>} */
  const pins = new Map()
  let cascade = 0
  let opening = 0

  const syncAwake = () => {
    if (pins.size + opening > 0) awake.hold(AWAKE_KEY)
    else awake.release(AWAKE_KEY)
    syncHover()
  }

  const spare = createSpare(async () => {
    awake.hold('pins-build')
    try {
      return await createFloat({
        app, native, html,
        bounds: { x: -20000, y: -20000, width: 320, height: 200 },
        level: native.LEVEL.float, shadow: true, log,
        onMessage: (message, api) => handle(message, api),
      })
    } finally {
      awake.release('pins-build')
    }
  }, { log })

  // --- hover ---------------------------------------------------------------------
  // A web view in an app that is not active gets no hover, and a pin is used while other
  // apps are in front, so hover is decided here from the global pointer.
  let hoverTimer = null
  function syncHover() {
    if (pins.size > 0 && !hoverTimer) hoverTimer = setInterval(checkHover, HOVER_TICK_MS)
    else if (pins.size === 0 && hoverTimer) { clearInterval(hoverTimer); hoverTimer = null }
  }
  function checkHover() {
    const p = native.cursorPoint()
    if (!p) return
    for (const entry of pins.values()) {
      const b = entry.float.bounds
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (inside !== entry.hover) {
        entry.hover = inside
        entry.float.call('hover', inside)
        syncBadge(entry)
      }
    }
  }

  // --- size badge ----------------------------------------------------------------
  // Drawn as layers in the window, pinned to its bottom-right corner, so it moves with the
  // edge in the same frame rather than a frame behind it.
  function buildBadge(entry) {
    // Without native layers the page draws the badge (pin.css), one pump tick behind the edge.
    if (!native.nativeLayers) { entry.badge = { page: true, label: '', shown: false }; return }
    const root = entry.float.rootLayer()
    const pill = native.createLayer()
    const text = native.createTextLayer({ size: 11, weight: 'semibold', scale: 2 })
    native.instantly(() => {
      pill.background(native.color(0.08, 0.08, 0.09, 0.74))
      pill.radius(5)
      pill.z(10)
      text.ink(native.color(1, 1, 1, 1))
      pill.add(text)
      pill.hidden(true)
      root.add(pill)
    })
    entry.badge = { pill, text, label: '', shown: false }
  }

  function badgeLabel(entry) {
    if (entry.showOpacity) return `${(STRINGS[locale()] ?? STRINGS.en).opacity} ${Math.round(entry.alpha * 100)}%`
    return `${Math.round(entry.zoom * 100)}%`
  }

  function syncBadge(entry) {
    const want = Boolean(entry.hover || entry.settling)
    const label = badgeLabel(entry)
    if (entry.badge.page) {
      if (want === entry.badge.shown && label === entry.badge.label) return
      entry.badge.shown = want
      entry.badge.label = label
      entry.float.call('badge', want ? label : null)
      return
    }
    const { pill, text } = entry.badge
    native.instantly(() => {
      if (label !== entry.badge.label) { text.text(label); entry.badge.label = label }
      const m = text.measure()
      const w = Math.ceil(m.width) + 12, h = Math.ceil(m.height) + 4
      const width = entry.frame.width
      // Layer coordinates have their origin at the bottom-left, so y is the bottom margin.
      pill.frame({ x: width - w - BADGE_MARGIN, y: BADGE_MARGIN, width: w, height: h })
      text.frame({ x: 6, y: 2, width: Math.ceil(m.width), height: Math.ceil(m.height) })
      if (want !== entry.badge.shown) { pill.hidden(!want); entry.badge.shown = want }
    })
  }

  // --- geometry ------------------------------------------------------------------
  /** The frame as last set here, unless the window has moved since (a drag). */
  function currentFrame(entry) {
    const b = entry.float.bounds
    const f = entry.frame
    if (!f || Math.abs(Math.round(f.x) - b.x) > 1 || Math.abs(Math.round(f.y) - b.y) > 1) {
      entry.frame = { x: b.x, y: b.y, width: f ? f.width : b.width, height: f ? f.height : b.height }
    }
    return entry.frame
  }

  function apply(entry, frame) {
    entry.frame = frame
    // Round the edges, not the origin and the size: rounded separately, a corner held
    // fixed by a resize drifts by a pixel as the size changes.
    const x1 = Math.round(frame.x), y1 = Math.round(frame.y)
    const x2 = Math.round(frame.x + frame.width), y2 = Math.round(frame.y + frame.height)
    entry.float.setFrameExact({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 })
    syncBadge(entry)
  }

  /** When a queued zoom applies: at once, or on Windows at the next display frame. */
  const nextResize = native.platform === 'win32' ? (fn) => setTimeout(fn, RESIZE_TICK_MS.win32) : setImmediate

  const clampZoom = (entry, z) => {
    const min = Math.max(ZOOM_MIN, MIN_SIDE / Math.min(entry.base.width, entry.base.height))
    return Math.min(ZOOM_MAX, Math.max(min, z))
  }

  /** A zoom, resize or opacity change is under way: hide the page chrome, show the badge. */
  function settle(entry) {
    if (!entry.settling) { entry.settling = true; entry.float.call('gesture', true) }
    clearTimeout(entry.settleTimer)
    entry.settleTimer = setTimeout(() => {
      entry.settling = false
      entry.showOpacity = false
      entry.float.call('gesture', false)
      syncBadge(entry)
    }, SETTLE_MS)
    syncBadge(entry)
  }

  /**
   * Zoom by a factor, keeping a global point fixed on the image. Wheel steps that arrive
   * before the next resize are multiplied together and applied once: within one tick, or on
   * Windows within one display frame (see RESIZE_TICK_MS).
   */
  function zoomBy(entry, factor, anchor) {
    entry.pendingZoom = (entry.pendingZoom ?? 1) * factor
    entry.pendingAnchor = anchor
    if (entry.zoomQueued) return
    entry.zoomQueued = true
    nextResize(() => {
      entry.zoomQueued = false
      const f = currentFrame(entry)
      const z1 = clampZoom(entry, entry.zoom * entry.pendingZoom)
      entry.pendingZoom = 1
      if (z1 === entry.zoom) return
      const a = entry.pendingAnchor ?? { x: f.x + f.width / 2, y: f.y + f.height / 2 }
      // Where the anchor sits inside the image, as a fraction of its size.
      const rx = Math.min(1, Math.max(0, (a.x - f.x) / f.width))
      const ry = Math.min(1, Math.max(0, (a.y - f.y) / f.height))
      const width = entry.base.width * z1, height = entry.base.height * z1
      entry.zoom = z1
      entry.showOpacity = false
      apply(entry, { x: f.x + rx * f.width - rx * width, y: f.y + ry * f.height - ry * height, width, height })
      settle(entry)
    })
  }

  /**
   * Resize from one corner keeping the aspect ratio: the opposite corner stays put, and the
   * size follows the pointer projected onto the image's diagonal, so neither axis alone
   * decides and the corner tracks the pointer smoothly.
   */
  function startResize(entry, corner) {
    stopResize(entry)
    const f = currentFrame(entry)
    const west = corner.includes('w'), north = corner.includes('n')
    const fixed = { x: west ? f.x + f.width : f.x, y: north ? f.y + f.height : f.y }
    const W = entry.base.width, H = entry.base.height
    entry.showOpacity = false
    settle(entry)
    entry.resizeTimer = setInterval(() => {
      if (!native.leftButtonDown()) { stopResize(entry); return }
      const p = native.cursorPoint()
      if (!p) return
      const dx = west ? fixed.x - p.x : p.x - fixed.x
      const dy = north ? fixed.y - p.y : p.y - fixed.y
      const z = clampZoom(entry, (dx * W + dy * H) / (W * W + H * H))
      // Under half a point of change moves no edge: leave the window alone.
      if (entry.frame && Math.abs(z - entry.zoom) * Math.max(W, H) < 0.5) return
      entry.zoom = z
      const width = W * z, height = H * z
      apply(entry, { x: west ? fixed.x - width : fixed.x, y: north ? fixed.y - height : fixed.y, width, height })
      settle(entry)
    }, RESIZE_TICK_MS[native.platform] ?? 16)
  }
  function stopResize(entry) {
    if (entry.resizeTimer) clearInterval(entry.resizeTimer)
    entry.resizeTimer = null
  }

  function setOpacity(entry, alpha) {
    entry.alpha = Math.min(1, Math.max(OPACITY_MIN, alpha))
    entry.float.setAlpha(entry.alpha)
    entry.showOpacity = true
    settle(entry)
  }

  // --- lifecycle -----------------------------------------------------------------
  async function open({ png, rect }) {
    const base = { width: Math.max(MIN_SIDE, Math.round(rect?.width ?? 320)), height: Math.max(MIN_SIDE, Math.round(rect?.height ?? 200)) }
    const place = {
      x: Math.round((rect?.x ?? 80) + OFFSET + cascade),
      y: Math.round((rect?.y ?? 80) + OFFSET + cascade),
      ...base,
    }
    cascade = (cascade + CASCADE) % (CASCADE * 6)
    const startedAt = process.hrtime.bigint()
    opening += 1
    syncAwake()
    let float
    try {
      float = await spare.take()
    } finally {
      opening -= 1
    }
    const entry = {
      float, png, base, zoom: 1, alpha: 1, frame: { ...place },
      hover: null, settling: false, showOpacity: false, settleTimer: null, resizeTimer: null,
      pendingZoom: 1, pendingAnchor: null, zoomQueued: false, badge: null,
    }
    pins.set(float.id, entry)
    syncAwake()
    float.rounded(CORNER_RADIUS)
    float.setNativeImage(png)
    float.setFrameExact(place)
    float.call('locale', locale())
    float.call('theme', native.systemTheme?.() ?? 'auto')
    buildBadge(entry)
    syncBadge(entry)
    float.focus()
    setTimeout(() => float.invalidateShadow(), 80)
    log('info', 'pin opened', {
      id: float.id, size: `${place.width}x${place.height}`, open: pins.size,
      ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    })
    return float.id
  }

  function handle(message, api) {
    const entry = pins.get(api.id)
    if (!entry) return
    switch (message?.type) {
      case 'close': return close(api.id)
      case 'zoom': {
        // Option with the wheel changes opacity; a trackpad pinch arrives with Control
        // set and is a zoom like the plain wheel.
        if (message.alt) return setOpacity(entry, entry.alpha - Number(message.deltaY) * 0.002)
        return zoomBy(entry, Math.exp(-Number(message.deltaY) * 0.0022), native.cursorPoint())
      }
      case 'zoom-step': {
        const factor = message.step === 'in' ? 1.15 : message.step === 'out' ? 1 / 1.15 : 1 / entry.zoom
        return zoomBy(entry, factor, null)
      }
      case 'resize-start': return startResize(entry, String(message.corner ?? 'se'))
      case 'shortcut-check':
        if (personHolds(native, message)) api.call('shortcut', ...shortcutArgs(message))
        else log('info', 'pin ignored a shortcut with no physical modifier', { id: api.id, key: message.key })
        return
      case 'copy':
      case 'save':
      case 'ask':
        onAction(message.type, { png: entry.png, rect: api.bounds })
        if (message.type === 'ask') close(api.id)
        return
      default: return
    }
  }

  function close(id) {
    const entry = pins.get(id)
    if (!entry) return
    stopResize(entry)
    clearTimeout(entry.settleTimer)
    entry.float.dispose()
    pins.delete(id)
    syncAwake()
    log('info', 'pin closed', { id, open: pins.size })
  }

  return {
    open,
    /** Build the spare window in the background, after `delayMs`. */
    warm: (delayMs) => spare.warm(delayMs),
    get count() { return pins.size },
    /** Deliver a message to a pin as if its page had sent it. */
    send(id, message) { const entry = pins.get(id); if (entry) handle(message, entry.float) },
    /** A pin's current frame and zoom, or null. */
    state(id) { const e = pins.get(id); return e ? { bounds: e.float.bounds, zoom: e.zoom, alpha: e.alpha } : null },
    closeAll() {
      for (const id of [...pins.keys()]) close(id)
      cascade = 0
    },
    dispose() {
      this.closeAll()
      spare.dispose()
      awake.release(AWAKE_KEY)
      if (hoverTimer) clearInterval(hoverTimer)
      hoverTimer = null
    },
  }
}
