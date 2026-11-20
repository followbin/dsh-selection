// The editing layer. It never touches the frozen screen itself: that is a captured image
// pinned to the overlay window's own layer underneath. This page draws the dim mask, the
// region and the annotations, and once a region is picked it receives just that crop.
//
// Every annotation stays a live object until the capture is sent: whatever tool is
// active, pressing on an existing annotation picks it up to move, resize, restyle or
// delete, and pressing on empty space uses the tool. Rendering is a full repaint from the
// shape list, so undo and redo are snapshots of it.
'use strict'

const post = (o) => window.ipc.postMessage(JSON.stringify(o))
const $ = (id) => document.getElementById(id)
const body = document.body

const regionEl = $('region'), canvas = $('canvas'), sizeEl = $('size')
const barEl = $('bar'), optsEl = $('opts'), aiEl = $('airow'), askEl = $('ask'), promptEl = $('prompt')
const rangeEl = $('sizeRange'), rangeOut = $('sizeValue'), rangeLabel = $('sizeLabel')
// The page shows annotations only: inside the region the canvas is transparent, so the
// frozen frame on the window's own layer shows through, live and at full resolution while
// the region moves. The crop is composed with the annotations only on export.
const displayCtx = canvas.getContext('2d')
/** Where paint() draws: the display canvas, or the export canvas while composing. */
let ctx = displayCtx

const STRINGS = {
  en: {
    hint: 'Drag to select  ·  Esc to cancel', rect: 'Rectangle', ellipse: 'Ellipse',
    arrow: 'Arrow', line: 'Line', pen: 'Pen', text: 'Text', number: 'Number marker', blur: 'Blur',
    pin: 'Pin to screen', undo: 'Undo', redo: 'Redo', copy: 'Copy', save: 'Save',
    cancel: 'Cancel', done: 'Done', fill: 'Filled',
    sizeStroke: 'Width', sizeText: 'Size', sizeNumber: 'Size', sizeBlur: 'Blur',
    aiOcr: 'Extract text', aiTranslate: 'Translate', aiExplain: 'Explain', aiAsk: 'Ask',
    askPlaceholder: 'Ask about this screenshot…', askTip: 'Enter to send · Shift+Enter for a new line',
    back: 'Back', send: 'Send',
  },
  zh: {
    hint: '拖拽框选  ·  Esc 取消', rect: '矩形', ellipse: '椭圆',
    arrow: '箭头', line: '直线', pen: '画笔', text: '文字', number: '数字标记', blur: '模糊',
    pin: '贴到屏幕', undo: '撤销', redo: '重做', copy: '复制', save: '保存',
    cancel: '取消', done: '完成', fill: '填充',
    sizeStroke: '粗细', sizeText: '字号', sizeNumber: '大小', sizeBlur: '强度',
    aiOcr: '提取文字', aiTranslate: '翻译', aiExplain: '解释', aiAsk: '问一问',
    askPlaceholder: '想问这张截图什么…', askTip: 'Enter 发送 · Shift+Enter 换行',
    back: '返回', send: '发送',
  },
}
let t = STRINGS.zh
function applyStrings() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n] ?? ''
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t[el.dataset.i18nTitle] ?? ''
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t[el.dataset.i18nPlaceholder] ?? ''
  syncOptions()
}

const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#1c1c1e']
/** Tools that draw by dragging a box. */
const BOXY = new Set(['rect', 'ellipse', 'blur'])
/** Tools that draw by dragging a segment. */
const SEGMENT = new Set(['arrow', 'line'])
/**
 * What the size control means for each kind of mark, with its own range and default, so
 * changing the font size does not also thicken the next rectangle.
 */
const SIZE = {
  stroke: { min: 1, max: 16, step: 1, initial: 2, label: 'sizeStroke' },
  text: { min: 10, max: 72, step: 1, initial: 18, label: 'sizeText' },
  number: { min: 16, max: 48, step: 1, initial: 24, label: 'sizeNumber' },
  blur: { min: 2, max: 30, step: 1, initial: 10, label: 'sizeBlur' },
}
const sizeKind = (kind) => kind === 'text' ? 'text' : kind === 'number' ? 'number' : kind === 'blur' ? 'blur' : 'stroke'
const HANDLE = 4.5
const MIN_SHAPE = 4

// --- state -------------------------------------------------------------------
const MODE = { IDLE: 'idle', PICKING: 'picking', PICKED: 'picked' }
let mode = MODE.IDLE
let rect = null              // region in CSS px of this display
let anchor = null
let scale = 1                // backing pixels per CSS px
let base = null              // Image of the crop: blur samples it, export draws under the shapes
let baseNatural = null       // the crop at natural size, for blur sampling
let picksSent = 0            // regions sent to the host, numbering each pick for the page's lifetime
let baseSeq = -1             // the pick the current crop answers; only the latest pick's crop counts
let cropWaiters = []         // exports waiting for the crop of the current region
let exporting = false
let shapes = []
let selectedId = null
let tool = null              // null: no tool, the region itself can be moved
let color = PALETTE[0]
let fill = false
const sizes = Object.fromEntries(Object.entries(SIZE).map(([k, v]) => [k, v.initial]))
let drawing = null
let gesture = null
let round = 0
let seq = 0
let pickedAt = 0
let history = []
let future = []
let sliderSnapshotTaken = false
/**
 * The text box being typed in, if any. Anything that changes what the region shows (a tool
 * switch, an export, undo, another text box) commits it first, because toolbar buttons keep
 * focus where it is and the box would otherwise never blur.
 */
let activeEditor = null
const commitEditor = () => activeEditor?.commit()

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
const selected = () => shapes.find((s) => s.id === selectedId) ?? null

function snapshot() {
  history.push(JSON.stringify(shapes))
  if (history.length > 80) history.shift()
  future.length = 0
  syncButtons()
}
function restore(stack, other) {
  commitEditor()
  if (stack.length === 0) return
  other.push(JSON.stringify(shapes))
  shapes = JSON.parse(stack.pop())
  if (!shapes.some((s) => s.id === selectedId)) selectedId = null
  redraw(); syncButtons(); syncOptions()
}

// --- geometry ----------------------------------------------------------------
const TEXT_FACES = '-apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif'
const textFont = (s) => `600 ${s.size}px ${TEXT_FACES}`
const numberRadius = (s) => s.size / 2

function measureText(s) {
  ctx.save()
  ctx.font = textFont(s)
  const lines = String(s.text).split('\n')
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width))
  ctx.restore()
  return { w, h: lines.length * s.size * 1.3 }
}

function bbox(s) {
  if (BOXY.has(s.kind)) return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
  if (SEGMENT.has(s.kind)) return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) }
  if (s.kind === 'pen') {
    const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  if (s.kind === 'text') { const m = measureText(s); return { x: s.x, y: s.y, w: m.w, h: m.h } }
  if (s.kind === 'number') { const r = numberRadius(s); return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 } }
  return { x: 0, y: 0, w: 0, h: 0 }
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const u = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy))
}

/** Whether a point picks up this shape. Strokes are hit on the stroke, areas inside. */
function hit(s, p) {
  const pad = Math.max(5, (sizeKind(s.kind) === 'stroke' ? s.size : 0) / 2 + 4)
  const b = bbox(s)
  switch (s.kind) {
    case 'pen': {
      for (let i = 1; i < s.points.length; i++) if (distToSegment(p, s.points[i - 1], s.points[i]) <= pad) return true
      return s.points.length === 1 && Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= pad
    }
    case 'arrow':
    case 'line': return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= pad
    case 'number': return Math.hypot(p.x - s.x, p.y - s.y) <= numberRadius(s) + 3
    case 'ellipse': {
      if (s.fill) {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2
        return ((p.x - cx) / (b.w / 2 || 1)) ** 2 + ((p.y - cy) / (b.h / 2 || 1)) ** 2 <= 1
      }
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2
      const rx = b.w / 2 || 1, ry = b.h / 2 || 1
      const inner = ((p.x - cx) / Math.max(1, rx - pad)) ** 2 + ((p.y - cy) / Math.max(1, ry - pad)) ** 2
      const outer = ((p.x - cx) / (rx + pad)) ** 2 + ((p.y - cy) / (ry + pad)) ** 2
      return outer <= 1 && inner >= 1
    }
    case 'rect': {
      const inOuter = p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad
      if (s.fill) return inOuter
      const inInner = p.x > b.x + pad && p.x < b.x + b.w - pad && p.y > b.y + pad && p.y < b.y + b.h - pad
      return inOuter && !inInner
    }
    default:
      return p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3
  }
}

const topmostAt = (p) => [...shapes].reverse().find((s) => hit(s, p)) ?? null

function handlesOf(s) {
  if (SEGMENT.has(s.kind)) return [{ at: 'p1', x: s.x1, y: s.y1 }, { at: 'p2', x: s.x2, y: s.y2 }]
  if (s.kind === 'pen' || s.kind === 'number') return []
  const b = bbox(s)
  if (s.kind === 'text') return [{ at: 'se', x: b.x + b.w, y: b.y + b.h }]
  return [
    { at: 'nw', x: b.x, y: b.y }, { at: 'ne', x: b.x + b.w, y: b.y },
    { at: 'sw', x: b.x, y: b.y + b.h }, { at: 'se', x: b.x + b.w, y: b.y + b.h },
    { at: 'n', x: b.x + b.w / 2, y: b.y }, { at: 's', x: b.x + b.w / 2, y: b.y + b.h },
    { at: 'w', x: b.x, y: b.y + b.h / 2 }, { at: 'e', x: b.x + b.w, y: b.y + b.h / 2 },
  ]
}
const handleAt = (s, p) => handlesOf(s).find((h) => Math.abs(h.x - p.x) <= HANDLE + 3 && Math.abs(h.y - p.y) <= HANDLE + 3) ?? null

// --- rendering ---------------------------------------------------------------
/**
 * A Gaussian-like blur done in script, so it renders the same in every engine. WKWebView
 * has no canvas filter, and a single shrink-and-stretch smears instead of blurring.
 *
 * The box is downsampled to a working size where the blur radius is a few pixels, run
 * through three box-blur passes each way (three passes converge on a Gaussian), and drawn
 * back up with smoothing; blurred content is low-frequency, so the downsampling loses
 * nothing visible and keeps the cost small. Patches are cached per box and strength,
 * because the canvas repaints on every pointer move.
 */
const blurCache = new Map()
const BLUR_CACHE_MAX = 24

function blurRow(src, dst, w, h, r, horizontal) {
  const div = 2 * r + 1
  const outer = horizontal ? h : w, inner = horizontal ? w : h
  const stride = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4
  for (let line = 0; line < outer; line++) {
    const base = line * lineStep
    for (let c = 0; c < 4; c++) {
      let acc = 0
      // Edge pixels are repeated, so the box does not darken towards a border.
      for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, inner - 1) * stride + c]
      for (let i = 0; i < inner; i++) {
        dst[base + i * stride + c] = acc / div
        acc += src[base + Math.min(i + r + 1, inner - 1) * stride + c] - src[base + Math.max(i - r, 0) * stride + c]
      }
    }
  }
}

function blurredPatch(b, strength) {
  const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)},${strength}`
  const cached = blurCache.get(key)
  if (cached) return cached
  const natW = baseNatural.width, natH = baseNatural.height
  const sigma = strength * scale                 // the Gaussian sigma, in crop pixels
  const pad = sigma * 2.5                        // neighbours the box edge blurs from
  const sx = Math.max(0, Math.floor(b.x * scale - pad)), sy = Math.max(0, Math.floor(b.y * scale - pad))
  const ex = Math.min(natW, Math.ceil((b.x + b.w) * scale + pad)), ey = Math.min(natH, Math.ceil((b.y + b.h) * scale + pad))
  const sw = ex - sx, sh = ey - sy
  if (sw < 1 || sh < 1) return null
  const down = Math.max(1, sigma / 4)
  const w = Math.max(1, Math.round(sw / down)), h = Math.max(1, Math.round(sh / down))
  const work = document.createElement('canvas')
  work.width = w; work.height = h
  const g = work.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(baseNatural, sx, sy, sw, sh, 0, 0, w, h)
  const img = g.getImageData(0, 0, w, h)
  // Box width whose three passes give the target sigma: sigma^2 = 3 * (width^2 - 1) / 12.
  const sigmaWork = sigma / down
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigmaWork * sigmaWork + 1) - 1) / 2))
  const tmp = new Uint8ClampedArray(img.data.length)
  for (let pass = 0; pass < 3; pass++) {
    blurRow(img.data, tmp, w, h, r, true)
    blurRow(tmp, img.data, w, h, r, false)
  }
  g.putImageData(img, 0, 0)
  const patch = { canvas: work, x: sx / scale, y: sy / scale, w: sw / scale, h: sh / scale }
  blurCache.set(key, patch)
  if (blurCache.size > BLUR_CACHE_MAX) blurCache.delete(blurCache.keys().next().value)
  return patch
}

function sizeCanvas() {
  if (!rect) return
  canvas.width = Math.max(1, Math.round(rect.w * scale))
  canvas.height = Math.max(1, Math.round(rect.h * scale))
  redraw()
}

function redraw() {
  if (!canvas.width) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  paintShapes()
  const sel = selected()
  if (sel && !drawing) paintSelection(sel)
}

/** Blur reads the crop beneath it, so it paints first and annotations sit on top of it. */
function paintShapes() {
  for (const s of shapes) if (s.kind === 'blur') paint(s)
  if (drawing?.kind === 'blur') paint(drawing)
  for (const s of shapes) if (s.kind !== 'blur') paint(s)
  if (drawing && drawing.kind !== 'blur') paint(drawing)
}

function paint(s) {
  ctx.save()
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const b = bbox(s)
  switch (s.kind) {
    case 'rect':
      if (s.fill) ctx.fillRect(b.x, b.y, b.w, b.h)
      else ctx.strokeRect(b.x, b.y, b.w, b.h)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w / 2, .5), Math.max(b.h / 2, .5), 0, 0, Math.PI * 2)
      s.fill ? ctx.fill() : ctx.stroke()
      break
    case 'line':
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke()
      break
    case 'arrow': paintArrow(s); break
    case 'pen':
      ctx.beginPath()
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.stroke()
      break
    case 'text': paintText(s); break
    case 'number': paintNumber(s); break
    case 'blur': paintBlur(s); break
    default: break
  }
  ctx.restore()
}

function paintArrow(s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1
  const len = Math.hypot(dx, dy)
  if (len < 1) return
  const head = clamp(len * 0.32, 7 + s.size * 2.2, 10 + s.size * 4.5)
  const a = Math.atan2(dy, dx)
  const bx = s.x2 - Math.cos(a) * head * .85, by = s.y2 - Math.sin(a) * head * .85
  ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(bx, by); ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(s.x2, s.y2)
  ctx.lineTo(s.x2 - Math.cos(a) * head - Math.sin(a) * head * .42, s.y2 - Math.sin(a) * head + Math.cos(a) * head * .42)
  ctx.lineTo(s.x2 - Math.cos(a) * head + Math.sin(a) * head * .42, s.y2 - Math.sin(a) * head - Math.cos(a) * head * .42)
  ctx.closePath(); ctx.fill()
}

function paintText(s) {
  ctx.font = textFont(s)
  ctx.textBaseline = 'top'
  ctx.fillStyle = s.color
  String(s.text).split('\n').forEach((line, i) => ctx.fillText(line, s.x, s.y + i * s.size * 1.3))
}

function paintNumber(s) {
  const r = numberRadius(s)
  ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
  ctx.fillStyle = s.color; ctx.fill()
  ctx.lineWidth = Math.max(1.5, r * .13); ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.stroke()
  const light = s.color === '#ffffff' || s.color === '#ffcc00'
  ctx.fillStyle = light ? '#1c1c1e' : '#fff'
  ctx.font = `700 ${Math.round(r * 1.12)}px ${TEXT_FACES}`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(String(s.n), s.x, s.y + .5)
}

function paintBlur(s) {
  if (!baseNatural) return
  const b = bbox(s)
  if (b.w < 2 || b.h < 2) return
  const patch = blurredPatch(b, s.size)
  if (!patch) return
  ctx.save()
  ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(patch.canvas, patch.x, patch.y, patch.w, patch.h)
  ctx.restore()
}

function paintSelection(s) {
  const b = bbox(s)
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(10,132,255,.95)'
  const pad = s.kind === 'number' ? 3 : 2
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
  ctx.setLineDash([])
  for (const h of handlesOf(s)) {
    ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'; ctx.fill()
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a84ff'; ctx.stroke()
  }
  ctx.restore()
}

// --- layout ------------------------------------------------------------------
function layoutRegion() {
  if (!rect) return
  regionEl.style.left = rect.x + 'px'
  regionEl.style.top = rect.y + 'px'
  regionEl.style.width = rect.w + 'px'
  regionEl.style.height = rect.h + 'px'
  $('sizeW').textContent = Math.round(rect.w)
  $('sizeH').textContent = Math.round(rect.h)
  const pill = sizeEl.offsetHeight || 28
  sizeEl.style.left = clamp(rect.x, 6, innerWidth - (sizeEl.offsetWidth || 90) - 6) + 'px'
  sizeEl.style.top = (rect.y > pill + 10 ? rect.y - pill - 7 : rect.y + 7) + 'px'
  layoutBars()
}

/**
 * Main bar under the region (or above it when there is no room), the AI row directly
 * beneath the bar in a fixed spot so it is always where the hand expects it, and the
 * tool options beside the AI row, or on a third line when the screen is too narrow.
 */
function layoutBars() {
  if (mode !== MODE.PICKED || !rect) return
  const gap = 7
  const bw = barEl.offsetWidth || 470, bh = barEl.offsetHeight || 48
  const aw = aiEl.offsetWidth || 360, ah = aiEl.offsetHeight || 42
  const optsOn = body.classList.contains('tool-opts')
  const ow = optsOn ? (optsEl.offsetWidth || 340) : 0
  const oh = optsOn ? (optsEl.offsetHeight || 40) : 0
  const sideBySide = optsOn && aw + gap + ow <= Math.max(bw, innerWidth - 16)
  const stackH = bh + gap + ah + (optsOn && !sideBySide ? gap + oh : 0)

  const bx = clamp(rect.x + rect.w - bw, 8, Math.max(8, innerWidth - bw - 8))
  let top = rect.y + rect.h + 9
  let above = false
  if (top + stackH > innerHeight - 8) {
    if (rect.y - stackH - 9 >= 8) { top = rect.y - stackH - 9; above = true }
    else top = clamp(innerHeight - stackH - 8, 8, innerHeight - stackH - 8)
  }
  // Above the region the order flips, so the main bar stays nearest the region.
  const rows = above
    ? { opts: top, ai: top + (optsOn && !sideBySide ? oh + gap : 0), bar: top + stackH - bh }
    : { bar: top, ai: top + bh + gap, opts: top + bh + gap + ah + gap }
  barEl.style.left = bx + 'px'; barEl.style.top = rows.bar + 'px'

  const ax = clamp(bx, 8, innerWidth - aw - 8)
  aiEl.style.left = ax + 'px'; aiEl.style.top = rows.ai + 'px'

  if (optsOn) {
    if (sideBySide) {
      optsEl.style.left = clamp(ax + aw + gap, 8, innerWidth - ow - 8) + 'px'
      optsEl.style.top = rows.ai + (ah - oh) / 2 + 'px'
    } else {
      optsEl.style.left = clamp(bx, 8, innerWidth - ow - 8) + 'px'
      optsEl.style.top = rows.opts + 'px'
    }
  }
  askEl.style.left = clamp(ax, 8, Math.max(8, innerWidth - 448)) + 'px'
  askEl.style.top = clamp(above ? rows.bar - 128 : rows.ai + ah + gap + (optsOn && !sideBySide ? oh + gap : 0), 8, innerHeight - 124) + 'px'
}

// --- pointer -----------------------------------------------------------------
const inChrome = (e) => e.target?.closest?.('#bar, #opts, #ask, #airow')
const local = (e) => ({ x: e.clientX - rect.x, y: e.clientY - rect.y })

addEventListener('mousedown', (e) => {
  if (e.button !== 0 || inChrome(e)) return
  if (mode === MODE.IDLE) {
    anchor = { x: e.clientX, y: e.clientY }
    rect = { x: anchor.x, y: anchor.y, w: 0, h: 0 }
    setMode(MODE.PICKING)
    layoutRegion()
    return
  }
  if (mode !== MODE.PICKED) return

  const grip = e.target?.closest?.('.grip')
  if (grip) { gesture = { kind: 'region', at: grip.dataset.at, rect0: { ...rect } }; e.preventDefault(); return }
  if (e.target !== canvas) return
  const p = local(e)

  // The selected shape's own handles come first.
  const sel = selected()
  if (sel) {
    const h = handleAt(sel, p)
    if (h) { snapshot(); gesture = { kind: 'shape-resize', at: h.at, before: structuredClone(sel), start: p }; e.preventDefault(); return }
  }

  // Pressing on an existing annotation picks it up, whatever tool is active.
  const under = topmostAt(p)
  if (under) {
    selectedId = under.id
    snapshot()
    gesture = { kind: 'shape-move', before: structuredClone(under), start: p, moved: false }
    syncOptions(); redraw(); syncButtons()
    e.preventDefault()
    return
  }

  // Empty space: deselect, then let the tool act.
  selectedId = null
  syncOptions()
  if (tool === null) {
    gesture = { kind: 'region-move', rect0: { ...rect }, start: { x: e.clientX, y: e.clientY } }
    redraw()
    e.preventDefault()
    return
  }
  if (tool === 'text') { placeText(p); e.preventDefault(); return }
  if (tool === 'number') { addNumber(p); e.preventDefault(); return }

  const size = sizes[sizeKind(tool)]
  drawing = BOXY.has(tool)
    ? { id: ++seq, kind: tool, color, fill, size, x: p.x, y: p.y, w: 0, h: 0 }
    : SEGMENT.has(tool)
      ? { id: ++seq, kind: tool, color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y }
      : { id: ++seq, kind: 'pen', color, size, points: [p] }
  redraw()
  e.preventDefault()
})

addEventListener('mousemove', (e) => {
  if (mode === MODE.PICKING) {
    rect = norm(anchor, { x: e.clientX, y: e.clientY })
    layoutRegion()
    return
  }
  if (gesture) return runGesture(e)
  if (drawing) {
    const p = local(e)
    if (drawing.kind === 'pen') drawing.points.push(p)
    else if (SEGMENT.has(drawing.kind)) { drawing.x2 = p.x; drawing.y2 = p.y }
    else { drawing.w = p.x - drawing.x; drawing.h = p.y - drawing.y }
    redraw()
    return
  }
  if (mode === MODE.PICKED && rect && e.target === canvas) {
    const p = local(e)
    const sel = selected()
    const overHandle = sel && handleAt(sel, p)
    body.classList.toggle('over-shape', Boolean(!overHandle && topmostAt(p)))
    body.classList.toggle('over-handle', Boolean(overHandle))
  }
})

addEventListener('mouseup', () => {
  if (mode === MODE.PICKING) {
    if (rect.w < MIN_SHAPE || rect.h < MIN_SHAPE) { resetPick(); return }
    setMode(MODE.PICKED)
    layoutRegion()
    sizeCanvas()
    sendPick()
    return
  }
  if (gesture) {
    const g = gesture
    gesture = null
    if (g.kind === 'region' || g.kind === 'region-move') { sizeCanvas(); sendPick(); return }
    // A press that never moved changed nothing; drop the snapshot it took.
    if (g.kind === 'shape-move' && !g.moved) { history.pop(); syncButtons() }
    return
  }
  if (drawing) {
    const keep = drawing.kind === 'pen'
      ? drawing.points.length > 1
      : SEGMENT.has(drawing.kind)
        ? Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1) > MIN_SHAPE
        : Math.abs(drawing.w) > MIN_SHAPE && Math.abs(drawing.h) > MIN_SHAPE
    if (keep) { snapshot(); shapes.push(drawing); selectedId = drawing.id }
    drawing = null
    redraw(); syncButtons(); syncOptions()
  }
})

// Double-clicking text reopens it for editing.
addEventListener('dblclick', (e) => {
  if (mode !== MODE.PICKED || e.target !== canvas) return
  const s = topmostAt(local(e))
  if (s?.kind === 'text') editText(s)
})

function runGesture(e) {
  if (gesture.kind === 'region') {
    const r0 = gesture.rect0, at = gesture.at
    let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h
    if (at.includes('w')) x1 = clamp(e.clientX, 0, innerWidth)
    if (at.includes('e')) x2 = clamp(e.clientX, 0, innerWidth)
    if (at.includes('n')) y1 = clamp(e.clientY, 0, innerHeight)
    if (at.includes('s')) y2 = clamp(e.clientY, 0, innerHeight)
    rect = norm({ x: x1, y: y1 }, { x: x2, y: y2 })
    layoutRegion(); sizeCanvas()
    return
  }
  if (gesture.kind === 'region-move') {
    const r0 = gesture.rect0
    rect = {
      x: clamp(r0.x + (e.clientX - gesture.start.x), 0, innerWidth - r0.w),
      y: clamp(r0.y + (e.clientY - gesture.start.y), 0, innerHeight - r0.h),
      w: r0.w, h: r0.h,
    }
    layoutRegion()
    return
  }
  const s = selected()
  if (!s) return
  const p = local(e)
  const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y
  const b0 = gesture.before
  if (gesture.kind === 'shape-move') {
    if (Math.abs(dx) + Math.abs(dy) > 0) gesture.moved = true
    if (SEGMENT.has(s.kind)) { s.x1 = b0.x1 + dx; s.y1 = b0.y1 + dy; s.x2 = b0.x2 + dx; s.y2 = b0.y2 + dy }
    else if (s.kind === 'pen') s.points = b0.points.map((q) => ({ x: q.x + dx, y: q.y + dy }))
    else { s.x = b0.x + dx; s.y = b0.y + dy }
  } else if (gesture.kind === 'shape-resize') {
    if (SEGMENT.has(s.kind)) {
      if (gesture.at === 'p1') { s.x1 = p.x; s.y1 = p.y } else { s.x2 = p.x; s.y2 = p.y }
    } else if (s.kind === 'text') {
      s.size = Math.round(clamp(b0.size + dy * .6, SIZE.text.min, SIZE.text.max))
      syncOptions()
    } else {
      const at = gesture.at, bb = bbox(b0)
      let x1 = bb.x, y1 = bb.y, x2 = bb.x + bb.w, y2 = bb.y + bb.h
      if (at.includes('w')) x1 = p.x
      if (at.includes('e')) x2 = p.x
      if (at.includes('n')) y1 = p.y
      if (at.includes('s')) y2 = p.y
      const n = norm({ x: x1, y: y1 }, { x: x2, y: y2 })
      s.x = n.x; s.y = n.y; s.w = n.w; s.h = n.h
    }
  }
  redraw()
}

function sendPick() {
  picksSent += 1
  post({ seq: picksSent, type: 'pick', rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) } })
}

// --- shape creators ----------------------------------------------------------
function addNumber(p) {
  snapshot()
  const next = shapes.filter((s) => s.kind === 'number').reduce((m, s) => Math.max(m, s.n), 0) + 1
  const s = { id: ++seq, kind: 'number', color, size: sizes.number, x: p.x, y: p.y, n: next }
  shapes.push(s)
  selectedId = s.id
  redraw(); syncButtons(); syncOptions()
}

/** Open an inline editor at a point; `existing` re-edits a text shape in place. */
function openTextEditor(at, initial, existing) {
  commitEditor()
  // The shape being typed is the box itself; nothing else stays selected meanwhile.
  selectedId = null
  redraw()
  const size = existing ? existing.size : sizes.text
  const ink = existing ? existing.color : color
  const box = document.createElement('div')
  box.contentEditable = 'plaintext-only'
  box.spellcheck = false
  box.textContent = initial
  Object.assign(box.style, {
    position: 'absolute', left: (at.x - 3) + 'px', top: (at.y - 1) + 'px', minWidth: '12px', zIndex: 5,
    font: `600 ${size}px ${TEXT_FACES}`,
    color: ink, outline: `1px dashed ${ink}`, padding: '1px 3px',
    background: 'transparent', cursor: 'text', whiteSpace: 'pre', lineHeight: 1.3,
  })
  regionEl.appendChild(box)
  if (existing) { existing.hidden = true; redraw() }
  box.focus()
  const range = document.createRange(); range.selectNodeContents(box); range.collapse(false)
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)

  let committed = false
  const commit = () => {
    if (committed) return
    committed = true
    if (activeEditor === editor) activeEditor = null
    const text = box.textContent.replace(/\s+$/, '')
    box.remove()
    if (existing) {
      delete existing.hidden
      if (!text) { snapshot(); shapes = shapes.filter((s) => s !== existing); selectedId = null }
      else if (text !== existing.text) { snapshot(); existing.text = text; selectedId = existing.id }
    } else if (text) {
      snapshot()
      const s = { id: ++seq, kind: 'text', color: ink, size, x: at.x, y: at.y, text }
      shapes.push(s); selectedId = s.id
    }
    redraw(); syncButtons(); syncOptions()
  }
  /** Drop the box without touching the shapes: the region it belonged to is gone. */
  const abandon = () => {
    committed = true
    if (activeEditor === editor) activeEditor = null
    if (existing) delete existing.hidden
    box.remove()
  }
  const editor = { commit, abandon }
  activeEditor = editor
  box.addEventListener('blur', commit)
  box.addEventListener('keydown', (e) => {
    e.stopPropagation()
    // Commit directly rather than through blur: a box that never took focus cannot blur.
    if (e.key === 'Escape') { if (!existing) box.textContent = ''; commit(); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
  })
}
const placeText = (p) => openTextEditor({ x: p.x + 3, y: p.y + 1 }, '', null)
const editText = (s) => openTextEditor({ x: s.x, y: s.y }, s.text, s)

// --- options -----------------------------------------------------------------
function buildSwatches() {
  const sw = $('swatches')
  sw.innerHTML = ''
  for (const c of PALETTE) {
    const i = document.createElement('i')
    i.dataset.color = c
    i.style.background = c
    sw.appendChild(i)
  }
}

/**
 * The options follow the selected annotation when there is one, else the active tool.
 * The size control's meaning, range and label change with it.
 */
function syncOptions() {
  const sel = selected()
  const kind = sel ? sel.kind : tool
  const on = mode === MODE.PICKED && kind !== null && kind !== undefined
  const was = body.classList.contains('tool-opts')
  body.classList.toggle('tool-opts', on)
  if (!on) { if (was) layoutBars(); return }

  const sk = sizeKind(kind)
  const spec = SIZE[sk]
  const value = sel ? sel.size : sizes[sk]
  rangeEl.min = spec.min; rangeEl.max = spec.max; rangeEl.step = spec.step
  rangeEl.value = value
  rangeOut.textContent = String(Math.round(value))
  rangeLabel.textContent = t[spec.label]
  rangeEl.style.setProperty('--fill', ((value - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + '%')

  const colored = kind !== 'blur'
  $('swatches').style.display = colored ? '' : 'none'
  $('colorSep').style.display = colored ? '' : 'none'
  const ink = sel ? sel.color : color
  for (const i of document.querySelectorAll('#swatches i')) i.setAttribute('aria-pressed', String(i.dataset.color === ink))

  const fillable = kind === 'rect' || kind === 'ellipse'
  $('fillSep').style.display = fillable ? '' : 'none'
  $('fill').style.display = fillable ? '' : 'none'
  $('fill').setAttribute('aria-pressed', String(Boolean(sel ? sel.fill : fill)))
  if (!was) layoutBars()
}

function setColor(next) {
  color = next
  const s = selected()
  if (s && s.kind !== 'blur' && s.color !== next) { snapshot(); s.color = next; redraw() }
  syncOptions()
}

rangeEl.addEventListener('input', () => {
  const value = Number(rangeEl.value)
  const s = selected()
  const sk = sizeKind(s ? s.kind : tool)
  sizes[sk] = value
  if (s) {
    // One undo step per drag of the slider, not one per pixel it moved.
    if (!sliderSnapshotTaken) { snapshot(); sliderSnapshotTaken = true }
    s.size = value
    redraw()
  }
  rangeOut.textContent = String(value)
  const spec = SIZE[sk]
  rangeEl.style.setProperty('--fill', ((value - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + '%')
})
rangeEl.addEventListener('change', () => { sliderSnapshotTaken = false })

function syncButtons() {
  $('undo').disabled = history.length === 0
  $('redo').disabled = future.length === 0
}

/** Pressing the active tool again puts it down. */
function selectTool(next) { setTool(tool === next ? null : next) }

function setTool(next) {
  // Switching tools ends typing: an empty box goes away, a filled one becomes the text it says.
  commitEditor()
  tool = next
  for (const b of barEl.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool))
  body.classList.toggle('tool-draw', tool !== null && tool !== 'text')
  body.classList.toggle('tool-text', tool === 'text')
  body.classList.toggle('tool-none', tool === null)
  if (tool !== null && selected() && sizeKind(selected().kind) !== sizeKind(tool)) selectedId = null
  redraw()
  syncOptions()
  layoutBars()
}

// --- chrome events -----------------------------------------------------------
// Tool buttons act on press, not on click: a click needs press and release on the same
// element, and anything that shifts the button in between loses it.
barEl.addEventListener('pointerdown', (e) => {
  e.stopPropagation()
  const b = e.target.closest('button[data-tool]')
  if (b && e.button === 0) { e.preventDefault(); selectTool(b.dataset.tool) }
})
barEl.addEventListener('mousedown', (e) => e.stopPropagation())
barEl.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b || b.dataset.tool) return
  switch (b.id) {
    case 'undo': restore(history, future); return
    case 'redo': restore(future, history); return
    case 'cancel': return post({ type: 'cancel' })
    case 'copy': return emit('copy', {}, e)
    case 'save': return emit('save', {}, e)
    case 'pin': return emit('pin', {}, e)
    case 'done': return emit('done', {}, e)
    default: return
  }
})

optsEl.addEventListener('pointerdown', (e) => e.stopPropagation())
optsEl.addEventListener('mousedown', (e) => e.stopPropagation())
optsEl.addEventListener('click', (e) => {
  const sw = e.target.closest('#swatches i')
  if (sw) return setColor(sw.dataset.color)
  if (e.target.closest('#fill')) {
    const s = selected()
    if (s && (s.kind === 'rect' || s.kind === 'ellipse')) { snapshot(); s.fill = !s.fill; fill = s.fill; redraw() }
    else fill = !fill
    syncOptions()
  }
})

aiEl.addEventListener('pointerdown', (e) => e.stopPropagation())
aiEl.addEventListener('mousedown', (e) => e.stopPropagation())
aiEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ai]')
  if (!b) return
  if (b.dataset.ai === 'ask') {
    body.classList.add('asking'); layoutBars(); promptEl.focus()
    return
  }
  emit('ai', { action: b.dataset.ai }, e)
})

askEl.addEventListener('mousedown', (e) => e.stopPropagation())
$('askCancel').addEventListener('click', () => { body.classList.remove('asking'); promptEl.value = '' })
$('askSend').addEventListener('click', (e) => emit('ai', { action: 'ask', prompt: promptEl.value.trim() }, e))
promptEl.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); emit('ai', { action: 'ask', prompt: promptEl.value.trim() }, e) }
  if (e.key === 'Escape') { body.classList.remove('asking'); promptEl.value = '' }
})

function outRect() {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) }
}

/** Resolves once the crop of the current region has arrived (or after `ms`, with false). */
function cropReady(ms = 2000) {
  if (base && baseSeq === picksSent) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cropWaiters = cropWaiters.filter((w) => w !== done); resolve(false) }, ms)
    const done = () => { clearTimeout(timer); resolve(true) }
    cropWaiters.push(done)
  })
}

/** The crop with the annotations on it, composed off screen at backing resolution. */
function exportPng() {
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  const g = out.getContext('2d')
  g.setTransform(scale, 0, 0, scale, 0, 0)
  g.drawImage(base, 0, 0, rect.w, rect.h)
  ctx = g
  try {
    paintShapes()
  } finally {
    ctx = displayCtx
  }
  try {
    return out.toDataURL('image/png')
  } catch (error) {
    // A tainted canvas means the crop was served without CORS; handing the host a blank
    // PNG would look like a successful capture of nothing.
    post({ type: 'page-error', message: 'export blocked: ' + String(error && error.message) })
    return null
  }
}

/** Describe the input event behind an action, for the host's log. */
function cause(e) {
  if (!e) return { via: 'unknown' }
  return {
    via: e.type,
    trusted: e.isTrusted,
    target: e.target?.id || e.target?.closest?.('button')?.id || e.target?.tagName || null,
    key: e.key ?? null,
    meta: Boolean(e.metaKey), ctrl: Boolean(e.ctrlKey), shift: Boolean(e.shiftKey),
    detail: e.detail ?? null,
    x: e.clientX ?? null, y: e.clientY ?? null,
  }
}

/** Send one terminal action with the finished image, once the region's crop is here. */
async function emit(type, extra = {}, e = null) {
  // One export at a time: a second click while the crop is on its way would send twice.
  if (exporting || mode !== MODE.PICKED) return
  // Text still being typed is part of the image.
  commitEditor()
  exporting = true
  try {
    const at = { ...cause(e), sincePickMs: Math.round(performance.now() - pickedAt) }
    if (!(await cropReady())) { post({ type: 'page-error', message: 'export without a crop for the region' }); return }
    if (mode !== MODE.PICKED) return
    const image = exportPng()
    if (!image) return
    post({ type, image, rect: outRect(), shapes: shapes.length, ...extra, cause: at })
  } finally {
    exporting = false
  }
}

// --- keyboard ----------------------------------------------------------------
// Synthetic Command shortcuts (another app's selection tool posting a copy after a drag)
// are recognised by keys.js; here they are dropped and reported.
addEventListener('keydown', (e) => {
  if (e.key === 'Meta' || e.key === 'Control') return
  const synthetic = isSyntheticShortcut(e)
  const mod = (e.metaKey || e.ctrlKey) && !synthetic
  if (synthetic && mode === MODE.PICKED) {
    post({ type: 'shortcut-ignored', key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, sincePickMs: Math.round(performance.now() - pickedAt) })
    e.preventDefault()
    return
  }
  // Esc leaves the capture from any state, as in other capture tools. Typing in the ask
  // box or a text label has its own Esc handler, which only ends the typing.
  if (e.key === 'Escape') {
    post({ type: 'cancel' })
    return
  }
  // While a region is being chosen, the keys act on the magnifier: Command-C copies the
  // colour under the pointer and Shift switches between RGB and HEX.
  if (mode !== MODE.PICKED) {
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (frozen) copyLoupeColour()
      else post({ type: 'copy-color' })
      return
    }
    if (e.key === 'Shift' && !e.repeat) {
      if (frozen) { loupeHex = !loupeHex; if (loupeAt) drawLoupe(loupeAt.x, loupeAt.y) }
      else post({ type: 'color-format' })
      return
    }
    return
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    e.shiftKey ? restore(future, history) : restore(history, future)
    return
  }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); return emit('copy', {}, e) }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return emit('save', {}, e) }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); return emit('pin', {}, e) }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    e.preventDefault()
    snapshot()
    shapes = shapes.filter((s) => s.id !== selectedId)
    selectedId = null
    redraw(); syncButtons(); syncOptions()
    return
  }
  // Arrow keys nudge the selected annotation: one point, or ten with Shift.
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
  if (nudge && selectedId) {
    e.preventDefault()
    const s = selected(), k = e.shiftKey ? 10 : 1
    snapshot()
    if (SEGMENT.has(s.kind)) { s.x1 += nudge[0] * k; s.x2 += nudge[0] * k; s.y1 += nudge[1] * k; s.y2 += nudge[1] * k }
    else if (s.kind === 'pen') s.points = s.points.map((q) => ({ x: q.x + nudge[0] * k, y: q.y + nudge[1] * k }))
    else { s.x += nudge[0] * k; s.y += nudge[1] * k }
    redraw()
    return
  }
  if (e.key === 'Enter') { e.preventDefault(); emit('done', {}, e) }
})

function setMode(next) {
  if (next === MODE.PICKED && mode !== MODE.PICKED) pickedAt = performance.now()
  // The host shows its magnifier while a region is being chosen, not while one is edited.
  if (next !== mode) post({ type: 'mode', mode: next })
  mode = next
  if (next === MODE.PICKED) hideLoupe()
  body.classList.toggle('picking', next === MODE.PICKING)
  body.classList.toggle('picked', next === MODE.PICKED)
}

function resetPick() {
  setMode(MODE.IDLE)
  // The canvas keeps the previous capture's pixels until something redraws it, and
  // nothing does until a new region exists. Clearing is enough; resizing it to nothing
  // would also collapse the element, so it would stop receiving the pointer.
  if (canvas.width && canvas.height) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
  body.classList.remove('asking', 'over-shape', 'over-handle')
  rect = null; base = null; baseNatural = null
  // picksSent keeps counting across captures, so a crop still in flight from the last one
  // can never match a pick of this one.
  baseSeq = -1; exporting = false
  for (const done of cropWaiters.splice(0)) done()
  blurCache.clear()
  shapes = []; selectedId = null; drawing = null; gesture = null
  history = []; future = []
  promptEl.value = ''
  activeEditor?.abandon()
  for (const box of regionEl.querySelectorAll('[contenteditable]')) box.remove()
  setTool(null)
  syncButtons()
}


// --- frozen frame and magnifier drawn by the page ---------------------------------
// On macOS the frozen frame and the magnifier are layers of the window itself. Where windows
// have none (Windows), the worker sends the frame here and this page shows it and draws the
// same magnifier: 19 backing pixels across at 8 px each, the pointer's pixel marked, and a
// panel with the position, the colour and the keys that act on it.
const frozenEl = $('frozen'), loupeEl = $('loupe')
const LOUPE = { cells: 19, cell: 8, line: 18, offset: 20, edge: 4 }
LOUPE.mag = LOUPE.cells * LOUPE.cell
LOUPE.panel = 4 * LOUPE.line + 10
const COPY_KEYS = /Mac/.test(navigator.platform) ? '⌘+C' : 'Ctrl+C'
const LOUPE_STRINGS = {
  zh: { position: '坐标：', copyHint: `按 ${COPY_KEYS} 复制颜色值`, formatHint: '按 Shift 切换 RGB/HEX', copied: '已复制 ' },
  en: { position: 'Position: ', copyHint: `${COPY_KEYS}  copy the colour`, formatHint: 'Shift  RGB / HEX', copied: 'Copied ' },
}
/** A natural-size copy of the frame, read for the magnifier; null when the window layer has it. */
let frozen = null
let loupeHex = false
let loupeAt = null
let loupeColour = null
let copiedUntil = 0
let copiedText = ''

const hexOf = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
const colourString = (rgb) => (loupeHex ? hexOf(rgb) : rgb.join(', '))

function hideLoupe() {
  loupeEl.hidden = true
  loupeAt = null
}

function drawLoupe(x, y) {
  if (!frozen || !(mode === MODE.IDLE || mode === MODE.PICKING)) { hideLoupe(); return }
  loupeAt = { x, y }
  const ratio = frozen.scale
  const px = Math.floor(x * ratio), py = Math.floor(y * ratio)
  const half = (LOUPE.cells - 1) / 2
  const dpr = devicePixelRatio || 1
  const w = LOUPE.mag, h = LOUPE.mag + LOUPE.panel
  if (loupeEl.width !== Math.round(w * dpr)) { loupeEl.width = Math.round(w * dpr); loupeEl.height = Math.round(h * dpr) }
  loupeEl.style.width = w + 'px'
  loupeEl.style.height = h + 'px'
  const g = loupeEl.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.fillStyle = 'rgb(31, 31, 33)'
  g.fillRect(0, 0, w, LOUPE.mag)
  g.imageSmoothingEnabled = false
  g.drawImage(frozen.canvas, px - half, py - half, LOUPE.cells, LOUPE.cells, 0, 0, LOUPE.mag, LOUPE.mag)
  // Grid, then the pointer's row and column, then its pixel.
  g.strokeStyle = 'rgba(128, 128, 128, .28)'
  g.lineWidth = 0.5
  g.beginPath()
  for (let i = 1; i < LOUPE.cells; i++) {
    g.moveTo(i * LOUPE.cell + .25, 0); g.lineTo(i * LOUPE.cell + .25, LOUPE.mag)
    g.moveTo(0, i * LOUPE.cell + .25); g.lineTo(LOUPE.mag, i * LOUPE.cell + .25)
  }
  g.stroke()
  g.fillStyle = 'rgba(74, 148, 255, .32)'
  g.fillRect(half * LOUPE.cell, 0, LOUPE.cell, half * LOUPE.cell)
  g.fillRect(half * LOUPE.cell, (half + 1) * LOUPE.cell, LOUPE.cell, half * LOUPE.cell)
  g.fillRect(0, half * LOUPE.cell, half * LOUPE.cell, LOUPE.cell)
  g.fillRect((half + 1) * LOUPE.cell, half * LOUPE.cell, half * LOUPE.cell, LOUPE.cell)
  g.lineWidth = 1
  g.strokeStyle = 'rgba(0, 0, 0, .9)'
  g.strokeRect(half * LOUPE.cell - .5, half * LOUPE.cell - .5, LOUPE.cell + 1, LOUPE.cell + 1)
  g.strokeStyle = '#fff'
  g.strokeRect(half * LOUPE.cell + .5, half * LOUPE.cell + .5, LOUPE.cell - 1, LOUPE.cell - 1)
  // Panel
  const d = px >= 0 && py >= 0 && px < frozen.canvas.width && py < frozen.canvas.height
    ? frozen.read.getImageData(px, py, 1, 1).data : null
  loupeColour = d ? [d[0], d[1], d[2]] : null
  const s = LOUPE_STRINGS[t === STRINGS.en ? 'en' : 'zh']
  g.fillStyle = 'rgba(43, 43, 46, .95)'
  g.fillRect(0, LOUPE.mag, w, LOUPE.panel)
  g.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif'
  g.textBaseline = 'middle'
  const lines = [
    `${s.position}${Math.round(x)}, ${Math.round(y)}`,
    loupeColour ? colourString(loupeColour) : '',
    Date.now() < copiedUntil ? s.copied + copiedText : s.copyHint,
    s.formatHint,
  ]
  lines.forEach((text, i) => {
    g.fillStyle = i >= 2 ? 'rgba(255, 255, 255, .78)' : 'rgba(255, 255, 255, .97)'
    g.fillText(text, 10 + (i === 1 ? 18 : 0), LOUPE.mag + 5 + LOUPE.line * (i + 0.5))
  })
  if (loupeColour) {
    g.fillStyle = `rgb(${loupeColour.join(',')})`
    g.fillRect(10, LOUPE.mag + 5 + LOUPE.line * 1.5 - 6, 12, 12)
    g.strokeStyle = 'rgba(255, 255, 255, .8)'
    g.strokeRect(10.5, LOUPE.mag + 5 + LOUPE.line * 1.5 - 5.5, 11, 11)
  }
  // Beside the pointer, flipped away from the screen's right and bottom edges.
  let bx = x + LOUPE.offset
  if (bx + w > innerWidth - LOUPE.edge) bx = x - LOUPE.offset - w
  let by = y + LOUPE.offset
  if (by + h > innerHeight - LOUPE.edge) by = y - LOUPE.offset - h
  loupeEl.style.left = Math.max(LOUPE.edge, bx) + 'px'
  loupeEl.style.top = Math.max(LOUPE.edge, by) + 'px'
  loupeEl.hidden = false
}

function copyLoupeColour() {
  if (!loupeColour) return
  copiedText = colourString(loupeColour)
  copiedUntil = Date.now() + 1200
  post({ type: 'copy-color', text: copiedText })
  if (loupeAt) drawLoupe(loupeAt.x, loupeAt.y)
  setTimeout(() => { if (loupeAt) drawLoupe(loupeAt.x, loupeAt.y) }, 1250)
}

addEventListener('mousemove', (e) => { if (frozen) drawLoupe(e.clientX, e.clientY) }, true)
document.addEventListener('mouseleave', hideLoupe)

// --- host interface ----------------------------------------------------------
window.shot = {
  /** Called right after the window is ordered front; rAF only runs once visible. */
  shown(id, ratio) {
    round = id
    if (ratio) scale = ratio
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (round !== id) return
      body.classList.add('live')
      post({ type: 'painted', round: id })
    }))
  },
  reset() {
    body.classList.remove('live')
    resetPick()
    hideLoupe()
    frozen = null
    frozenEl.hidden = true
    frozenEl.removeAttribute('src')
  },
  /**
   * The frozen frame, for a window with no native layer to show it (Windows). Reports
   * 'frame-ready' once it is decoded and on screen, which is when the window is shown.
   * @param {string | null} src image URL on the window's own protocol.
   * @param {number} id the capture round, echoed back.
   * @param {number} ratio backing pixels per CSS px.
   */
  frame(src, id, ratio) {
    if (!src) { post({ type: 'frame-ready', round: id }); return }
    frozenEl.crossOrigin = 'anonymous'
    frozenEl.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = frozenEl.naturalWidth
      canvas.height = frozenEl.naturalHeight
      const read = canvas.getContext('2d', { willReadFrequently: true })
      read.drawImage(frozenEl, 0, 0)
      frozen = { canvas, read, scale: ratio || 1 }
      frozenEl.hidden = false
      requestAnimationFrame(() => post({ type: 'frame-ready', round: id }))
    }
    frozenEl.onerror = () => {
      post({ type: 'page-error', message: 'frozen frame failed to load' })
      post({ type: 'frame-ready', round: id })
    }
    frozenEl.src = src
  },
  locale(code) { t = STRINGS[code] ?? STRINGS.en; applyStrings() },
  theme(mode_) {
    if (mode_ === 'light' || mode_ === 'dark') document.documentElement.dataset.theme = mode_
    else delete document.documentElement.dataset.theme
  },
  /**
   * The AI row: enabled actions in the user's order. A built-in's label follows the page
   * language; a custom action brings its own name. `icon` is SVG path markup from the
   * worker's own icon table, never user input.
   * @param {{ id: string, name: string | null, icon: string }[]} list
   */
  actions(list) {
    const LABELS = { ocr: 'aiOcr', translate: 'aiTranslate', explain: 'aiExplain', ask: 'aiAsk' }
    aiEl.replaceChildren(...list.map((entry) => {
      const button = document.createElement('button')
      button.dataset.ai = entry.id
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('aria-hidden', 'true')
      svg.innerHTML = entry.icon
      const label = document.createElement('span')
      if (entry.name) label.textContent = entry.name
      else { label.dataset.i18n = LABELS[entry.id] ?? ''; label.textContent = t[label.dataset.i18n] ?? entry.id }
      if (entry.name) button.title = entry.name
      button.append(svg, label)
      return button
    }))
    if (mode === MODE.PICKED) layoutBars()
  },
  /**
   * The crop for the current region, at backing resolution.
   * @param {string} src `dshshot://` URL served by the host, or a PNG data URL.
   * @param {number} ratio backing pixels per CSS px.
   * @param {number | null} seq the pick it answers; a crop for an older pick (the region moved
   *   since, or a previous capture) is dropped.
   */
  crop(src, ratio, seq = null) {
    if (seq !== null && seq !== picksSent) return
    if (ratio) scale = ratio
    const img = new Image()
    // The host serves the crop over its own protocol, a different origin from this
    // document; without this the canvas is tainted and export throws.
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (seq !== null && seq !== picksSent) return
      baseSeq = seq ?? picksSent
      base = img
      const off = document.createElement('canvas')
      off.width = img.naturalWidth; off.height = img.naturalHeight
      off.getContext('2d').drawImage(img, 0, 0)
      baseNatural = off
      blurCache.clear()
      sizeCanvas()
      if (baseSeq === picksSent) { for (const done of cropWaiters.splice(0)) done() }
      post({ type: 'crop-ok', w: img.naturalWidth, h: img.naturalHeight, via: src.slice(0, 7) })
    }
    img.onerror = () => post({ type: 'crop-failed', via: src.slice(0, 7) })
    img.src = src
  },
}

addEventListener('error', (e) => post({ type: 'page-error', message: String(e.message).slice(0, 300) }))
addEventListener('resize', layoutBars)
buildSwatches()
applyStrings()
setTool(null)
syncButtons()
post({ type: 'page-ready' })
