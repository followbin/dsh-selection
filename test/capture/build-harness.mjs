// Generates test/capture/harness.html: the real overlay page, with the native layer replaced by a
// drawn fake screen and the Host replaced by a mock that answers 'pick' with a real crop.
// One source of truth - the markup, CSS and script are the shipped ones.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The capture pages live in ui/capture; the Markdown renderer is the toolbar's (ui/markdown.js).
const ui = (name) => readFileSync(new URL(name === 'markdown.js' ? `../../ui/${name}` : `../../ui/capture/${name}`, import.meta.url), 'utf8')

const MOCK_BEFORE = `
<canvas id="fakescreen"></canvas>
<style>
  #fakescreen { position: fixed; inset: 0; width: 100%; height: 100%; z-index: -1; display: block; }
  #probe { position: fixed; right: 8px; bottom: 8px; z-index: 50; max-width: 360px; max-height: 40vh;
           overflow: auto; background: rgba(12,12,14,.92); color: #9fe; font: 11px/1.5 ui-monospace, Menlo, monospace;
           padding: 8px 10px; border-radius: 7px; white-space: pre-wrap; pointer-events: none; }
</style>
<div id="probe"></div>
<script>
// --- fake screen -------------------------------------------------------------
// Drawn, not loaded: a grid with its own coordinates written into it, plus circles
// and diagonals, so a crop that is offset, mirrored or stretched is obvious on sight.
const RATIO = Number(new URLSearchParams(location.search).get('ratio') || 2)
const screen = document.getElementById('fakescreen')
function drawFakeScreen() {
  const w = innerWidth, h = innerHeight
  screen.width = Math.round(w * RATIO)
  screen.height = Math.round(h * RATIO)
  const g = screen.getContext('2d')
  g.setTransform(RATIO, 0, 0, RATIO, 0, 0)
  const bg = g.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, '#15223a'); bg.addColorStop(1, '#3a1f2e')
  g.fillStyle = bg; g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(255,255,255,.17)'; g.lineWidth = 1
  for (let x = 0; x <= w; x += 50) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, h); g.stroke() }
  for (let y = 0; y <= h; y += 50) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(w, y + .5); g.stroke() }
  g.strokeStyle = 'rgba(120,200,255,.5)'
  for (let x = 0; x <= w; x += 200) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, h); g.stroke() }
  for (let y = 0; y <= h; y += 200) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(w, y + .5); g.stroke() }
  g.fillStyle = 'rgba(255,255,255,.85)'
  g.font = '11px ui-monospace, Menlo, monospace'
  for (let x = 0; x <= w; x += 200) for (let y = 0; y <= h; y += 200) g.fillText(x + ',' + y, x + 4, y + 13)
  // Circles stay circular only if the aspect ratio survives; squares show axis scaling.
  const marks = [[160,160],[460,300],[760,460],[1060,220],[300,620],[900,700]]
  marks.forEach(([cx, cy], i) => {
    g.strokeStyle = ['#ff6b6b','#ffd166','#06d6a0','#4aa8ff','#c77dff','#fff'][i % 6]
    g.lineWidth = 3
    g.beginPath(); g.arc(cx, cy, 44, 0, Math.PI * 2); g.stroke()
    g.strokeRect(cx - 44, cy - 44, 88, 88)
    g.beginPath(); g.moveTo(cx - 62, cy - 62); g.lineTo(cx + 62, cy + 62); g.stroke()
    g.fillStyle = g.strokeStyle
    g.font = 'bold 15px -apple-system, system-ui, sans-serif'
    g.fillText('M' + (i + 1), cx - 12, cy + 6)
  })
  g.fillStyle = '#fff'
  g.font = 'bold 26px -apple-system, system-ui, sans-serif'
  g.fillText('FAKE SCREEN  ' + w + 'x' + h + ' @' + RATIO + 'x', 24, 48)
  g.font = '13px -apple-system, system-ui, sans-serif'
  g.fillStyle = 'rgba(255,255,255,.75)'
  g.fillText('Translate me: \\u4eca\\u5929\\u5929\\u6c14\\u5f88\\u597d\\uff0c\\u9002\\u5408\\u51fa\\u95e8\\u6563\\u6b65\\u3002', 24, 74)
}
drawFakeScreen()
addEventListener('resize', drawFakeScreen)

// --- mock host ---------------------------------------------------------------
window.__sent = []
const probe = document.getElementById('probe')
function render() {
  probe.textContent = window.__sent.slice(-9).map(m => {
    const c = { ...m }
    if (typeof c.image === 'string') c.image = 'data:png(' + c.image.length + 'B)'
    return JSON.stringify(c)
  }).join('\\n')
}
window.ipc = {
  postMessage(raw) {
    const m = JSON.parse(raw)
    window.__sent.push(m)
    render()
    if (m.type === 'pick') {
      // Exactly what the worker does: cut the region out of the frozen frame at
      // backing resolution and hand it back.
      const r = m.rect
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(r.width * RATIO))
      c.height = Math.max(1, Math.round(r.height * RATIO))
      c.getContext('2d').drawImage(
        screen,
        Math.round(r.x * RATIO), Math.round(r.y * RATIO),
        c.width, c.height,
        0, 0, c.width, c.height,
      )
      // An object URL, not a data URL: that exercises the same non-data branch the real
      // host uses when it serves the crop over its own protocol.
      c.toBlob((blob) => {
        const url = URL.createObjectURL(blob)
        window.__lastCrop = { rect: r, url, bytes: blob.size }
        window.shot.crop(url, RATIO, m.seq)
      }, 'image/png')
    }
  },
}
</script>
`

const MOCK_AFTER = `
<script>
// Test hooks (need window.shot, so they run after the overlay script).
window.__harness = {
  ratio: RATIO,
  sent: () => window.__sent,
  last: (type) => [...window.__sent].reverse().find(m => m.type === type) ?? null,
  clear: () => { window.__sent.length = 0; render() },
  reset: () => { window.shot.reset(); window.shot.shown(Date.now()) },
  state: () => ({
    bodyClass: document.body.className,
    region: (() => {
      const el = document.getElementById('region')
      const s = getComputedStyle(el)
      const b = el.getBoundingClientRect()
      return { display: s.display, opacity: s.opacity, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    })(),
    canvas: (() => {
      const c = document.getElementById('canvas')
      const b = c.getBoundingClientRect()
      return { attrW: c.width, attrH: c.height, cssW: Math.round(b.width), cssH: Math.round(b.height) }
    })(),
    bar: getComputedStyle(document.getElementById('bar')).display,
    size: document.getElementById('size').textContent,
  }),
}
addEventListener('load', () => setTimeout(() => window.shot.shown(1, RATIO), 30))
</script>
<script src="./cases.js?v=${Date.now()}"></script>
`

const html = ui('overlay.html')
  .replace('<link rel="stylesheet" href="overlay.css">', () => `<style>${ui('overlay.css')}</style>`)
  .replace(/<script src="([\w-]+\.js)"><\/script>/g, (_, file) => file === 'overlay.js'
    ? `${MOCK_BEFORE}\n<script>${ui(file)}</script>\n${MOCK_AFTER}`
    : `<script>${ui(file)}</script>`)

const out = fileURLToPath(new URL('./harness.html', import.meta.url))
writeFileSync(out, html)
console.log('wrote', out, `(${html.length} bytes)`)
