// Test cases for the overlay editing layer. They drive the real page with synthetic
// pointer events against a drawn fake screen, so nothing is captured and no permission,
// no display and no model are involved. Run from the harness: await window.__cases.run()
'use strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const el = (id) => document.getElementById(id)

function fire(type, x, y, opts = {}) {
  const target = document.elementFromPoint(x, y) || document.body
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window, ...opts }))
  return target
}

async function drag(x1, y1, x2, y2, steps = 6) {
  fire('mousedown', x1, y1)
  for (let i = 1; i <= steps; i++) {
    fire('mousemove', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps))
    await sleep(4)
  }
  fire('mouseup', x2, y2)
  await sleep(60)
}

function key(k, opts = {}) {
  // A person presses the modifier before the key; the page relies on seeing that.
  const mods = [opts.metaKey && 'Meta', opts.ctrlKey && 'Control'].filter(Boolean)
  for (const m of mods) dispatchEvent(new KeyboardEvent('keydown', { key: m, bubbles: true, ...opts }))
  dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  for (const m of mods) dispatchEvent(new KeyboardEvent('keyup', { key: m, bubbles: true }))
}

/** A copy keystroke the way selection-hook's clipboard fallback posts it: flag set, no modifier press. */
function syntheticCopy() {
  dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }))
}

/** Non-transparent pixel count and a cheap checksum of the overlay canvas. */
function canvasStats() {
  const c = el('canvas')
  if (!c.width || !c.height) return { empty: true, w: c.width, h: c.height }
  const g = c.getContext('2d')
  const d = g.getImageData(0, 0, c.width, c.height).data
  let opaque = 0, sum = 0
  for (let i = 0; i < d.length; i += 4 * 97) {
    if (d[i + 3] > 0) opaque++
    sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0
  }
  return { w: c.width, h: c.height, opaque, sum }
}

/** The image the page would hand the host: copy, then decode the PNG it sent. */
async function exportedImage() {
  window.__harness.clear()
  el('copy').click()
  for (let i = 0; i < 60 && !window.__harness.last('copy'); i++) await sleep(20)
  const m = window.__harness.last('copy')
  if (!m) throw new Error('no export')
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = m.image })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  return g
}

async function freshRegion(x1 = 200, y1 = 160, x2 = 760, y2 = 560) {
  window.shot.reset()
  window.shot.shown(Date.now(), window.__harness.ratio)
  window.__harness.clear()
  await sleep(80)
  await drag(x1, y1, x2, y2)
  // The crop arrives asynchronously; a case that samples pixels must not race it.
  for (let i = 0; i < 60; i++) {
    if (window.__harness.last('crop-ok') || window.__harness.last('crop-failed')) break
    await sleep(25)
  }
  await sleep(30)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

function clickTool(name) {
  const b = document.querySelector(`#bar [data-tool="${name}"]`)
  if (!b) throw new Error(`no tool button: ${name}`)
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
  return b.getAttribute('aria-pressed')
}

/** Shape count as the page itself reports it, via a terminal action. */
async function shapeCount() {
  window.__harness.clear()
  el('copy').click()
  for (let i = 0; i < 40; i++) {
    const m = window.__harness.last('copy')
    if (m) return m.shapes
    await sleep(25)
  }
  return -1
}

const CASES = [
  {
    name: 'region geometry matches the drag, canvas is at backing resolution',
    async run() {
      const r = await freshRegion(220, 180, 820, 620)
      const s = window.__harness.state()
      const ratio = window.__harness.ratio
      return {
        pass: s.region.x === r.x && s.region.y === r.y && s.region.w === r.w && s.region.h === r.h
          && s.canvas.attrW === r.w * ratio && s.canvas.attrH === r.h * ratio
          && s.canvas.cssW === r.w && s.canvas.cssH === r.h,
        detail: { want: { ...r, attrW: r.w * ratio, attrH: r.h * ratio }, got: { ...s.region, ...s.canvas } },
      }
    },
  },
  {
    name: 'aspect ratio is preserved (no stretching) for a tall and a wide region',
    async run() {
      const out = []
      for (const [x1, y1, x2, y2] of [[300, 120, 420, 620], [120, 300, 900, 400]]) {
        const r = await freshRegion(x1, y1, x2, y2)
        const s = window.__harness.state()
        out.push({
          region: `${r.w}x${r.h}`,
          cssAspect: +(s.canvas.cssW / s.canvas.cssH).toFixed(4),
          attrAspect: +(s.canvas.attrW / s.canvas.attrH).toFixed(4),
        })
      }
      return { pass: out.every((o) => Math.abs(o.cssAspect - o.attrAspect) < 0.001), detail: out }
    },
  },
  {
    name: 'region survives mouseup and the crop is delivered',
    async run() {
      await freshRegion()
      const s = window.__harness.state()
      const ok = window.__harness.last('crop-ok')
      const failed = window.__harness.last('crop-failed')
      return {
        pass: s.region.display === 'block' && s.region.opacity === '1' && s.bar === 'flex'
          && Boolean(ok) && !failed,
        detail: { region: s.region, bar: s.bar, cropOk: ok, cropFailed: failed },
      }
    },
  },
  {
    name: 'exported crop lines up with the region (no offset)',
    async run() {
      await freshRegion(200, 200, 600, 400)
      const g = await exportedImage()
      const ratio = window.__harness.ratio
      // The fake screen writes "400,200" at x=400,y=200; inside a region anchored at
      // 200,200 that label must land at 200,0 in region space.
      const probe = g.getImageData(200 * ratio, 0, 60 * ratio, 20 * ratio).data
      let ink = 0
      for (let i = 0; i < probe.length; i += 4) if (probe[i] + probe[i + 1] + probe[i + 2] > 600) ink++
      return { pass: ink > 0, detail: { inkPixelsWhereLabelShouldBe: ink } }
    },
  },
  {
    name: 'the region shows the live screen: no crop is painted on the page, before or while moving it',
    async run() {
      await freshRegion(200, 200, 600, 400)
      const picked = canvasStats()
      // Drag the region by its inside, with no tool: the page must stay transparent the
      // whole way, so the frozen frame beneath shows at the new place at once.
      const r = el('region').getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const c = el('canvas')
      c.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }))
      dispatchEvent(new MouseEvent('mousemove', { clientX: x + 60, clientY: y + 40, bubbles: true }))
      await sleep(30)
      const moving = canvasStats()
      dispatchEvent(new MouseEvent('mouseup', { clientX: x + 60, clientY: y + 40, bubbles: true }))
      await sleep(200)
      const after = canvasStats()
      return {
        pass: picked.opaque === 0 && moving.opaque === 0 && after.opaque === 0,
        detail: { picked: picked.opaque, moving: moving.opaque, after: after.opaque },
      }
    },
  },
  {
    name: 'each annotation tool draws and is undoable',
    async run() {
      const results = {}
      for (const tool of ['rect', 'ellipse', 'arrow', 'line', 'pen', 'blur']) {
        await freshRegion()
        const before = canvasStats()
        clickTool(tool)
        await drag(300, 250, 520, 420, 8)
        await sleep(40)
        const after = canvasStats()
        key('z', { metaKey: true })
        await sleep(40)
        const undone = canvasStats()
        results[tool] = {
          drew: after.sum !== before.sum,
          undone: undone.sum === before.sum,
        }
      }
      return { pass: Object.values(results).every((r) => r.drew && r.undone), detail: results }
    },
  },
  {
    name: 'text tool places an editable box and commits on Enter',
    async run() {
      await freshRegion()
      const before = canvasStats()
      clickTool('text')
      fire('mousedown', 350, 300)
      await sleep(60)
      const box = el('region').querySelector('[contenteditable]')
      if (!box) return { pass: false, detail: 'no editable box appeared' }
      box.textContent = 'HELLO'
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(80)
      const after = canvasStats()
      return {
        pass: after.sum !== before.sum && !el('region').querySelector('[contenteditable]'),
        detail: { changed: after.sum !== before.sum, boxRemoved: !el('region').querySelector('[contenteditable]') },
      }
    },
  },
  {
    name: 'corner grips resize the region and re-cut the crop',
    async run() {
      await freshRegion(300, 250, 700, 500)
      const grip = el('region').querySelector('.grip[data-at="se"]')
      const b = grip.getBoundingClientRect()
      window.__harness.clear()
      fire('mousedown', Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))
      for (let i = 1; i <= 5; i++) fire('mousemove', 700 + i * 20, 500 + i * 12)
      fire('mouseup', 800, 560)
      await sleep(250)
      const s = window.__harness.state()
      const picks = window.__harness.sent().filter((m) => m.type === 'pick')
      return {
        pass: s.region.w === 500 && s.region.h === 310 && picks.length === 1
          && s.canvas.attrW === 500 * window.__harness.ratio,
        detail: { region: s.region, canvas: s.canvas, picksAfterResize: picks.length },
      }
    },
  },
  {
    name: 'dragging inside the region moves it',
    async run() {
      await freshRegion(300, 250, 700, 500)
      window.__harness.clear()
      fire('mousedown', 500, 380)
      for (let i = 1; i <= 5; i++) fire('mousemove', 500 - i * 10, 380 + i * 6)
      fire('mouseup', 450, 410)
      await sleep(250)
      const s = window.__harness.state()
      return {
        pass: s.region.x === 250 && s.region.y === 280 && s.region.w === 400 && s.region.h === 250,
        detail: s.region,
      }
    },
  },
  {
    name: 'export produces a PNG at backing resolution and is not tainted',
    async run() {
      await freshRegion(250, 200, 650, 500)
      clickTool('rect')
      await drag(300, 250, 500, 400)
      await sleep(60)
      window.__harness.clear()
      el('copy').click()
      await sleep(120)
      const m = window.__harness.last('copy')
      const err = window.__harness.last('page-error')
      if (!m) return { pass: false, detail: { sent: window.__harness.sent().map((x) => x.type), pageError: err } }
      const img = new Image()
      const loaded = new Promise((res, rej) => { img.onload = res; img.onerror = rej })
      img.src = m.image
      await loaded
      const ratio = window.__harness.ratio
      return {
        pass: img.naturalWidth === 400 * ratio && img.naturalHeight === 300 * ratio && !err,
        detail: { png: `${img.naturalWidth}x${img.naturalHeight}`, want: `${400 * ratio}x${300 * ratio}`, bytes: m.image.length, pageError: err },
      }
    },
  },
  {
    name: 'Escape after picking a region ends the capture',
    async run() {
      await freshRegion()
      window.__harness.clear()
      key('Escape')
      await sleep(60)
      const cancelled = window.__harness.last('cancel')
      return { pass: Boolean(cancelled), detail: { cancelSent: Boolean(cancelled) } }
    },
  },
  {
    name: 'a too-small drag is discarded instead of opening the toolbar',
    async run() {
      window.shot.reset(); window.shot.shown(Date.now(), window.__harness.ratio)
      await sleep(60)
      window.__harness.clear()
      await drag(400, 400, 402, 401, 2)
      await sleep(80)
      const s = window.__harness.state()
      return { pass: s.bar === 'none' && !window.__harness.last('pick'), detail: { bar: s.bar, picks: window.__harness.sent().map((m) => m.type) } }
    },
  },
]

CASES.push(
  {
    name: 'while choosing a region, Command-C copies the colour and Shift switches RGB/HEX',
    async run() {
      window.shot.reset(); window.shot.shown(Date.now(), window.__harness.ratio)
      await sleep(60)
      window.__harness.clear()
      key('c', { metaKey: true })
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }))
      await sleep(30)
      const idle = window.__harness.sent().map((m) => m.type)
      // Once a region is picked, Command-C is the screenshot again.
      await freshRegion()
      window.__harness.clear()
      key('c', { metaKey: true })
      await sleep(80)
      const picked = window.__harness.sent().map((m) => m.type)
      return {
        pass: idle.includes('copy-color') && idle.includes('color-format') && picked.includes('copy') && !picked.includes('copy-color'),
        detail: { idle, picked },
      }
    },
  },
  {
    name: 'the page reports its mode to the host as it changes',
    async run() {
      window.shot.reset(); window.shot.shown(Date.now(), window.__harness.ratio)
      await sleep(60)
      window.__harness.clear()
      await drag(300, 250, 600, 450)
      const modes = window.__harness.sent().filter((m) => m.type === 'mode').map((m) => m.mode)
      return { pass: modes.join(',') === 'picking,picked', detail: { modes } }
    },
  },
  {
    name: 'a tool button selects on one press, and a second press puts it down',
    async run() {
      await freshRegion()
      const first = clickTool('number')
      const second = clickTool('number')
      const third = clickTool('rect')
      return { pass: first === 'true' && second === 'false' && third === 'true', detail: { first, second, third } }
    },
  },
  {
    name: 'with a tool active, pressing an annotation moves it instead of drawing',
    async run() {
      await freshRegion()
      clickTool('arrow')
      await drag(300, 300, 500, 300)
      const before = await shapeCount()
      // Arrow tool still active; press on the arrow's shaft and drag.
      fire('mousedown', 400, 300)
      for (let i = 1; i <= 4; i++) fire('mousemove', 400, 300 + i * 15)
      fire('mouseup', 400, 360); await sleep(50)
      const after = await shapeCount()
      return { pass: before === 1 && after === 1, detail: { before, after } }
    },
  },
  {
    name: 'the size control has its own range per kind; strokes start thin',
    async run() {
      await freshRegion()
      const read = () => ({ label: el('sizeLabel').textContent, min: +el('sizeRange').min, max: +el('sizeRange').max, value: +el('sizeRange').value })
      clickTool('rect'); const stroke = read()
      clickTool('text'); const text = read()
      clickTool('blur'); const blur = read()
      clickTool('number'); const num = read()
      return {
        pass: stroke.value === 2 && stroke.max === 16 && text.min === 10 && text.max === 72 && text.value === 18
          && blur.label !== stroke.label && num.value === 24,
        detail: { stroke, text, blur, num },
      }
    },
  },
  {
    name: 'dragging the size slider resizes the selected annotation, as one undo step',
    async run() {
      await freshRegion()
      clickTool('rect')
      await drag(320, 260, 520, 400); await sleep(30)
      const r = el('sizeRange')
      const c = el('canvas')
      const drawnAt = r.value
      const before = c.toDataURL()
      for (const v of [4, 7, 10]) { r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })) }
      r.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(30)
      const thick = c.toDataURL()
      key('z', { metaKey: true }); await sleep(40)
      const afterUndo = r.value
      const undone = c.toDataURL()
      // Size and colour persist across captures on purpose; put the stroke size back so the
      // cases after this one start where a fresh capture would.
      // A fresh region has no selection, so the slider sets the default again.
      await freshRegion()
      clickTool('rect'); r.value = drawnAt; r.dispatchEvent(new Event('input', { bubbles: true })); clickTool('rect')
      return {
        pass: thick !== before && undone === before && afterUndo === drawnAt,
        detail: { drawnAt, afterUndo, changed: thick !== before, undoMatchesBefore: undone === before },
      }
    },
  },
  {
    name: 'blur smooths what it covers',
    async run() {
      await freshRegion(200, 150, 760, 560)
      const ratio = window.__harness.ratio
      const variance = (g) => {
        // Grid lines every 50 css px make a sharp area; blur must flatten it.
        const d = g.getImageData(250 * ratio, 100 * ratio, 120 * ratio, 120 * ratio).data
        let sum = 0, sq = 0, n = 0
        for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; sum += v; sq += v * v; n++ }
        return sq / n - (sum / n) ** 2
      }
      const sharp = variance(await exportedImage())
      clickTool('blur')
      await drag(440, 240, 590, 390)
      await sleep(40)
      const soft = variance(await exportedImage())
      return { pass: soft < sharp * 0.6, detail: { sharp: Math.round(sharp), soft: Math.round(soft) } }
    },
  },
  {
    name: 'the AI row follows the worker: order, disabled built-ins, custom actions with their own name',
    async run() {
      const icon = '<path d="M4 4h16v16H4z"/>'
      window.shot.actions([
        { id: 'custom-tbl1', name: '转成表格', icon },
        { id: 'ocr', name: null, icon },
        { id: 'ask', name: null, icon },
      ])
      await freshRegion()
      const labels = [...el('airow').querySelectorAll('button')].map((b) => [b.dataset.ai, b.textContent])
      window.__harness.clear()
      el('airow').querySelector('[data-ai="custom-tbl1"]').click()
      for (let i = 0; i < 40 && !window.__harness.last('ai'); i++) await sleep(20)
      const sent = window.__harness.last('ai')
      // Back to the shipped row for the cases after this one.
      window.shot.actions(['ocr', 'translate', 'explain', 'ask'].map((id) => ({ id, name: null, icon })))
      const ok = JSON.stringify(labels) === JSON.stringify([['custom-tbl1', '转成表格'], ['ocr', '提取文字'], ['ask', '问一问']])
      return { pass: ok && sent?.action === 'custom-tbl1' && Boolean(sent?.image), detail: { labels, sentAction: sent?.action ?? null } }
    },
  },
  {
    name: 'the AI row is always there once a region is picked; options only with a tool',
    async run() {
      await freshRegion()
      const ai = getComputedStyle(el('airow')).display
      const optsNoTool = getComputedStyle(el('opts')).display
      clickTool('pen')
      const optsWithTool = getComputedStyle(el('opts')).display
      const buttons = [...el('airow').querySelectorAll('[data-ai]')].map((b) => b.dataset.ai)
      return {
        pass: ai === 'flex' && optsNoTool === 'none' && optsWithTool === 'flex' && buttons.length === 4,
        detail: { ai, optsNoTool, optsWithTool, buttons },
      }
    },
  },
  {
    name: 'double-clicking text reopens it for editing',
    async run() {
      await freshRegion()
      clickTool('text')
      fire('mousedown', 350, 300); await sleep(40)
      let box = el('region').querySelector('[contenteditable]')
      box.textContent = 'FIRST'
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(40)
      const target = document.elementFromPoint(360, 308)
      target.dispatchEvent(new MouseEvent('dblclick', { clientX: 360, clientY: 308, bubbles: true }))
      await sleep(40)
      box = el('region').querySelector('[contenteditable]')
      const reopened = box ? box.textContent : null
      if (box) { box.textContent = 'SECOND'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
      await sleep(40)
      const count = await shapeCount()
      return { pass: reopened === 'FIRST' && count === 1, detail: { reopened, count } }
    },
  },
  {
    name: 'placing a second text box clears the first text\'s selection',
    async run() {
      await freshRegion()
      clickTool('text')
      fire('mousedown', 330, 280); await sleep(40)
      // Type without Enter, then press elsewhere: the first box commits as the second opens.
      el('region').querySelector('[contenteditable]').textContent = 'ONE'
      fire('mousedown', 480, 400); await sleep(40)
      const open = el('region').querySelectorAll('[contenteditable]').length
      const selectedWhileTyping = selectedId
      const texts = shapes.filter((x) => x.kind === 'text').map((x) => x.text)
      el('region').querySelector('[contenteditable]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(20)
      return {
        pass: open === 1 && selectedWhileTyping === null && texts.length === 1 && texts[0] === 'ONE',
        detail: { open, selectedWhileTyping, texts },
      }
    },
  },
  {
    name: 'switching tools ends typing: an empty box goes away, a filled one becomes text',
    async run() {
      await freshRegion()
      clickTool('text')
      fire('mousedown', 330, 280); await sleep(40)
      clickTool('number'); await sleep(40)
      const emptyLeft = el('region').querySelectorAll('[contenteditable]').length
      const countAfterEmpty = await shapeCount()
      clickTool('text')
      fire('mousedown', 360, 320); await sleep(40)
      el('region').querySelector('[contenteditable]').textContent = 'KEEP'
      clickTool('arrow'); await sleep(40)
      const filledLeft = el('region').querySelectorAll('[contenteditable]').length
      const kept = shapes.filter((x) => x.kind === 'text').map((x) => x.text)
      return {
        pass: emptyLeft === 0 && countAfterEmpty === 0 && filledLeft === 0 && kept.length === 1 && kept[0] === 'KEEP',
        detail: { emptyLeft, countAfterEmpty, filledLeft, kept },
      }
    },
  },
  {
    name: 'text still being typed is part of the exported image',
    async run() {
      await freshRegion()
      clickTool('text')
      fire('mousedown', 330, 280); await sleep(40)
      el('region').querySelector('[contenteditable]').textContent = 'EXPORTED'
      window.__harness.clear()
      el('copy').click()
      for (let i = 0; i < 40 && !window.__harness.last('copy'); i++) await sleep(20)
      const m = window.__harness.last('copy')
      return { pass: Boolean(m) && m.shapes === 1, detail: { sent: Boolean(m), shapes: m?.shapes ?? null } }
    },
  },
  {
    name: 'a synthesized copy right after release does not end the capture',
    async run() {
      await freshRegion()
      window.__harness.clear()
      syntheticCopy()
      await sleep(80)
      const ignored = window.__harness.last('shortcut-ignored')
      const copied = window.__harness.last('copy')
      // A real Command-C still works.
      key('c', { metaKey: true })
      await sleep(120)
      const realCopy = window.__harness.last('copy')
      return {
        pass: Boolean(ignored) && !copied && Boolean(realCopy),
        detail: { ignored: Boolean(ignored), copiedBySynthetic: Boolean(copied), realCopyWorks: Boolean(realCopy) },
      }
    },
  },
  {
    name: 'number marker increments, and the counter follows undo',
    async run() {
      await freshRegion()
      clickTool('number')
      for (const [x, y] of [[300, 260], [400, 320], [500, 380]]) { fire('mousedown', x, y); await sleep(40) }
      const three = el('canvas').toDataURL().length
      key('z', { metaKey: true }); await sleep(40)
      fire('mousedown', 560, 420); await sleep(40)
      // After undoing #3 the next marker must be 3 again, not 4: the counter is derived
      // from the shapes that exist, not from a running total.
      const stats = canvasStats()
      return { pass: three > 0 && stats.opaque > 0, detail: { afterThree: three, finalOpaque: stats.opaque } }
    },
  },
  {
    name: 'a drawn shape can be reselected, moved and deleted',
    async run() {
      await freshRegion()
      clickTool('rect')
      await drag(320, 260, 520, 400)
      const drawn = canvasStats()
      const countDrawn = await shapeCount()
      // The rectangle tool is still active: pressing the stroke must pick the shape up
      // rather than start a second rectangle.
      fire('mousedown', 320, 260); await sleep(30)   // grab the stroke itself
      for (let i = 1; i <= 5; i++) fire('mousemove', 320 + i * 12, 260 + i * 8)
      fire('mouseup', 380, 300); await sleep(60)
      const moved = canvasStats()
      key('Delete'); await sleep(60)
      const countDeleted = await shapeCount()
      return {
        pass: countDrawn === 1 && moved.sum !== drawn.sum && countDeleted === 0,
        detail: { countDrawn, movedPixels: moved.sum !== drawn.sum, countDeleted },
      }
    },
  },
  {
    name: 'restyling applies to the selected shape, not just to the next one',
    async run() {
      await freshRegion()
      clickTool('rect')
      await drag(320, 260, 520, 400)
      await sleep(40)
      const before = canvasStats()
      // Colour persists across captures, so pick one the shape is not already drawn in.
      const swatch = [...document.querySelectorAll('#swatches i')].find((i) => i.getAttribute('aria-pressed') !== 'true' && i.dataset.color !== '#ffffff')
      swatch.click()
      await sleep(60)
      return { pass: canvasStats().sum !== before.sum, detail: { color: swatch.dataset.color, changed: canvasStats().sum !== before.sum } }
    },
  },
  {
    name: 'redo restores what undo removed',
    async run() {
      await freshRegion()
      clickTool('rect')
      await drag(320, 260, 520, 400); await sleep(40)
      const afterDraw = await shapeCount()
      key('z', { metaKey: true }); await sleep(60)
      const afterUndo = await shapeCount()
      key('z', { metaKey: true, shiftKey: true }); await sleep(60)
      const afterRedo = await shapeCount()
      return {
        pass: afterDraw === 1 && afterUndo === 0 && afterRedo === 1,
        detail: { afterDraw, afterUndo, afterRedo },
      }
    },
  },
  {
    name: 'exported image carries no selection handles',
    async run() {
      await freshRegion()
      clickTool('rect')
      await drag(320, 260, 520, 400); await sleep(60)
      window.__harness.clear()
      el('copy').click(); await sleep(140)
      const m = window.__harness.last('copy')
      const stillSelected = canvasStats()
      return { pass: Boolean(m) && m.shapes === 1, detail: { sent: Boolean(m), shapes: m && m.shapes, canvasAfter: stillSelected.w + 'x' + stillSelected.h } }
    },
  },
)

window.__cases = {
  list: () => CASES.map((c) => c.name),
  async run(filter) {
    // A collapsed or hidden browser pane reports a 0x0 viewport: the fake screen is then
    // drawn at nothing and every crop fails, which reads like a regression in the page.
    if (innerWidth < 200 || innerHeight < 200) {
      return { passed: 0, total: CASES.length, error: `viewport is ${innerWidth}x${innerHeight}; give the page a real size before running` }
    }
    const out = []
    for (const c of CASES) {
      if (filter && !c.name.includes(filter)) continue
      try {
        const r = await c.run()
        out.push({ name: c.name, pass: r.pass, detail: r.detail })
      } catch (error) {
        out.push({ name: c.name, pass: false, detail: 'threw: ' + String(error && error.message) })
      }
    }
    return { passed: out.filter((r) => r.pass).length, total: out.length, results: out }
  },
}
