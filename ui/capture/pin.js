// A pinned capture's chrome. The image is on the window's own layer underneath; this page
// draws the hover toolbar and corner handles and reports gestures. Moving, zooming and
// resizing are done by the host, which owns the window and its geometry.
'use strict'

const post = (o) => window.ipc.postMessage(JSON.stringify(o))
const $ = (id) => document.getElementById(id)
const body = document.body

const STRINGS = {
  en: { copy: 'Copy', save: 'Save', ask: 'Ask DSH', close: 'Close (Esc)' },
  zh: { copy: '复制', save: '保存', ask: '问 DSH', close: '关闭 (Esc)' },
}
let t = STRINGS.zh
const applyStrings = () => {
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t[el.dataset.i18nTitle] ?? ''
}

// --- press: focus, then drag or resize -----------------------------------------
// Pressing takes focus: until this window is key in an active app the web view gets no
// keys, so Escape would not reach it.
let pressing = false
addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  body.classList.add('hot')
  post({ type: 'focus' })
  if (e.target?.closest?.('#bar')) return
  const corner = e.target?.closest?.('.corner')
  pressing = true
  if (corner) post({ type: 'resize-start', corner: corner.dataset.at })
  else { post({ type: 'drag-start' }); body.classList.add('dragging') }
  e.preventDefault()
})
addEventListener('mouseup', () => { pressing = false; body.classList.remove('dragging') })

// The toolbar and handles show while the pointer is over the image. A web view in an
// inactive app receives no hover, so the host also reports it (surface.hover).
for (const type of ['mouseenter', 'mousemove']) addEventListener(type, () => body.classList.add('hot'))
addEventListener('mouseleave', () => { if (!pressing) body.classList.remove('hot') })

addEventListener('dblclick', (e) => {
  if (e.target?.closest?.('#bar, .corner')) return
  post({ type: 'close' })
})

// The wheel zooms around the pointer; with Option it changes opacity. The host applies it.
addEventListener('wheel', (e) => {
  e.preventDefault()
  post({ type: 'zoom', deltaY: e.deltaY * (e.deltaMode === 1 ? 16 : 1), alt: e.altKey })
}, { passive: false })

// --- toolbar -------------------------------------------------------------------
$('bar').addEventListener('mousedown', (e) => e.stopPropagation())
$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b) post({ type: b.id })
})

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return post({ type: 'close' })
  // A copy posted by another app's selection tool after a click here must not copy or
  // save the pin (see keys.js).
  if (isSyntheticShortcut(e)) { e.preventDefault(); return }
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 'c') { e.preventDefault(); return post({ type: 'copy' }) }
  if (k === 's') { e.preventDefault(); return post({ type: 'save' }) }
  if (k === '=' || k === '+') { e.preventDefault(); return post({ type: 'zoom-step', step: 'in' }) }
  if (k === '-') { e.preventDefault(); return post({ type: 'zoom-step', step: 'out' }) }
  if (k === '0') { e.preventDefault(); return post({ type: 'zoom-step', step: 'reset' }) }
})

// --- host interface ----------------------------------------------------------
window.surface = {
  locale(code) { t = STRINGS[code] ?? STRINGS.en; applyStrings() },
  /** The pinned image, for a window with no native layer to hold it. */
  image(src) {
    const img = document.getElementById('image')
    img.crossOrigin = 'anonymous'
    img.src = src
    img.hidden = false
  },
  /** The zoom or opacity badge, for a window with no native layer to draw it; null hides it. */
  badge(text) {
    const el = document.getElementById('badge')
    el.hidden = text === null
    if (text !== null) el.textContent = text
  },
  theme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode
    else delete document.documentElement.dataset.theme
  },
  /** Pointer over this window or not, as the host sees it from the global pointer. */
  hover(on) { if (!pressing) body.classList.toggle('hot', Boolean(on)) },
  /** A zoom or resize is under way; the chrome steps aside until it settles. */
  gesture(on) { body.classList.toggle('gesture', Boolean(on)) },
}

addEventListener('error', (e) => post({ type: 'page-error', message: String(e.message).slice(0, 200) }))
applyStrings()
post({ type: 'page-ready' })
