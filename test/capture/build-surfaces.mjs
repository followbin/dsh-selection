// Harnesses for the floating surfaces, built from the shipped pages: the Host is replaced
// by a mock that feeds a drawn image and a scripted answer stream, so a pin and an answer
// panel can be exercised with no capture, no window manager and no model.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The capture pages live in ui/capture; the Markdown renderer is the toolbar's (ui/markdown.js).
const ui = (name) => readFileSync(new URL(name === 'markdown.js' ? `../../ui/${name}` : `../../ui/capture/${name}`, import.meta.url), 'utf8')

const SHARED = `
<style>
  html, body { background: #30303a; }
  #stage { position: fixed; inset: 0; display: grid; place-items: center; }
  #probe { position: fixed; left: 8px; bottom: 8px; z-index: 99; max-width: 46vw; max-height: 34vh;
    overflow: auto; background: rgba(12,12,14,.9); color: #9fe; padding: 7px 9px; border-radius: 7px;
    font: 11px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; pointer-events: none; }
</style>
<div id="probe"></div>
<script>
window.__sent = []
const probe = () => {
  document.getElementById('probe').textContent = window.__sent.slice(-8)
    .map(m => JSON.stringify(m).slice(0, 160)).join('\\n')
}
window.ipc = { postMessage(raw) { window.__sent.push(JSON.parse(raw)); probe() } }
window.__harness = {
  sent: () => window.__sent,
  last: (t) => [...window.__sent].reverse().find(m => m.type === t) ?? null,
  clear: () => { window.__sent.length = 0; probe() },
}
/** A recognisable stand-in for a captured region. */
function fakeShot(w, h) {
  const c = document.createElement('canvas')
  c.width = w * 2; c.height = h * 2
  const g = c.getContext('2d'); g.setTransform(2, 0, 0, 2, 0, 0)
  const bg = g.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, '#1b2b45'); bg.addColorStop(1, '#43203a')
  g.fillStyle = bg; g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(255,255,255,.18)'
  for (let x = 0; x <= w; x += 40) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, h); g.stroke() }
  for (let y = 0; y <= h; y += 40) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(w, y + .5); g.stroke() }
  g.strokeStyle = '#ff6b6b'; g.lineWidth = 3
  g.strokeRect(w * .18, h * .22, w * .34, h * .3)
  g.beginPath(); g.arc(w * .72, h * .62, Math.min(w, h) * .16, 0, Math.PI * 2); g.stroke()
  g.fillStyle = '#fff'; g.font = 'bold 20px -apple-system, system-ui, sans-serif'
  g.fillText('CAPTURED ' + w + '×' + h, 16, 34)
  return c.toDataURL('image/png')
}
</script>
`

const PIN_MOCK = `
<script>
// The real pin shows its image on the window's own layer, beneath this page; stand in for
// it with the same drawing as a page background.
const W = 360, H = 240
document.documentElement.style.background = 'url(' + fakeShot(W, H) + ') center / 100% 100% no-repeat'
window.surface.locale('zh')
window.surface.theme('dark')
window.__harness.pin = { width: W, height: H }
</script>
`

const ANSWER_MOCK = `
<style>
  /* Stand in for the native window: 440 points wide, as tall as the page last asked for,
     rounded and shadowed like the real one. */
  html { width: 100% !important; height: 100% !important; background: #5a6170 !important; }
  body { position: relative !important; width: 440px !important; height: var(--h, 168px) !important; margin: 60px auto 0 !important;
    border-radius: 12px; overflow: hidden !important; box-shadow: 0 10px 40px rgba(0,0,0,.45), 0 0 0 .5px rgba(0,0,0,.4); }
</style>
<script>
const MIN = 120, MAX = 640
const theme = new URLSearchParams(location.search).get('theme') || 'dark'
window.surface.locale('zh')
window.surface.theme(theme)
window.surface.thumbnail(fakeShot(120, 90))
const REPLY = [
  '这张截图是一个**代码编辑器**窗口，终端里有一处报错。\\n\\n',
  '- 打开的文件是 \\\`orders.js\\\`\\n- 第 42 行读取了 \\\`undefined\\\` 的 \\\`reduce\\\`\\n',
  '- 原因是 \\\`order.items\\\` 不存在\\n\\n',
  '| 季度 | 营收 |\\n|---|---|\\n| Q3 | 8.0 |\\n| Q4 | 6.5 |\\n\\n',
  '\\\`\\\`\\\`js\\nconst total = (order.items ?? []).reduce((s, i) => s + i.price, 0)\\n\\\`\\\`\\\`\\n',
]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let mockTurns = 0
async function play(index, question, pieces = REPLY, delay = 70) {
  window.surface.begin(index, question)
  await sleep(250)
  for (const p of pieces) { window.surface.chunk(index, p); await sleep(delay) }
  window.surface.end(index)
}
const sent = window.ipc.postMessage
window.ipc.postMessage = (raw) => {
  sent(raw)
  const m = JSON.parse(raw)
  if (m.type === 'size') document.documentElement.style.setProperty('--h', Math.max(MIN, Math.min(MAX, m.height)) + 'px')
  if (m.type === 'pin') { window.__pinned = !window.__pinned; window.surface.pinned(window.__pinned) }
  if (m.type === 'ask') { mockTurns += 1; play(mockTurns, m.text, ['好的，Q3 比 Q1 高 **4.0** 百万美元。']) }
  if (m.type === 'regenerate') play(m.index, null)
}
window.__harness.start = (action = "explain", options = {}) => { mockTurns = 0; window.surface.open(action, options); return play(0, options.question ?? null, options.pieces) }
window.__harness.failWith = (code) => { mockTurns = 0; window.surface.open('explain'); window.surface.begin(0, null); window.surface.fail(0, code, 'boom') }
window.__harness.start()
</script>
`

function build(name, mock) {
  const html = ui(`${name}.html`)
    .replace(`<link rel="stylesheet" href="${name}.css">`, () => `<style>${ui(`${name}.css`)}</style>`)
    .replace(/<script src="([\w-]+\.js)"><\/script>/g, (_, file) => file === `${name}.js`
      ? `${SHARED}\n<script>${ui(file)}</script>\n${mock}`
      : `<script>${ui(file)}</script>`)
  const out = fileURLToPath(new URL(`./${name}-harness.html`, import.meta.url))
  writeFileSync(out, html)
  console.log('wrote', out, `(${html.length} bytes)`)
}

build('pin', PIN_MOCK)
build('answer', ANSWER_MOCK)
