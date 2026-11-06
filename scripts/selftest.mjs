// Overlay self test (macOS). Needs no accessibility permission: it drives the toolbar directly, reads
// back the native window state and the page layout, and checks that the frontmost app never changes.
// Run with DSH's Electron in Node mode (Node 24): `pnpm selftest`. Pass --interactive to click around.
import { execFileSync } from 'node:child_process'
import { defaultSettings, enabledSkills } from '../src/host/settings.mjs'
import { createOverlay } from '../src/worker/overlay.mjs'

const interactive = process.argv.includes('--interactive')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lsappinfo = (...args) => {
  try {
    return execFileSync('lsappinfo', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const frontApp = () => lsappinfo('info', '-only', 'name', lsappinfo('front')).match(/="(.*)"/)?.[1] ?? 'unknown'
const ownType = () => {
  const asn = lsappinfo('find', `pid=${process.pid}`)
  return asn ? lsappinfo('info', '-only', 'ApplicationType', asn).match(/="(.*)"/)?.[1] : 'not registered (no Dock icon)'
}

const messages = []
const overlay = await createOverlay({ onMessage: (message) => messages.push(message), log: (...args) => console.error(...args) })
const skills = enabledSkills(defaultSettings())
overlay.configure({ bar: skills.slice(0, 5), more: skills.slice(5) })

async function probe() {
  overlay.probe()
  await sleep(250)
  const index = messages.findIndex((message) => message.type === 'probe')
  return index === -1 ? null : messages.splice(index, 1)[0]
}

// The message types each click makes the page post. The worker hides the panel on `menu` and `close`,
// so a control that posts anything besides its own message makes the panel vanish.
async function clicks(selectors) {
  const posted = {}
  for (const selector of selectors) {
    messages.splice(0)
    overlay.click(selector)
    await sleep(150)
    posted[selector] = messages.splice(0).map((message) => (message.action ? `${message.type}:${message.action}` : message.type))
  }
  return posted
}
const EXPECTED_CLICKS = {
  '[data-menu-action="settings"]': ['menu:settings'],
  '[data-tool="pin"]': ['pin'],
  '[data-tool="copy"]': ['copy-result'],
}

const frontBefore = frontApp()
const report = { frontBefore, steps: {}, clicks: {} }

overlay.showBar({ x: 640, y: 260, top: 240, precise: false })
await sleep(700)
report.steps.bar = { native: overlay.inspect(), layout: await probe(), front: frontApp(), dock: ownType() }

overlay.setMenu(true)
await sleep(400)
report.steps.menu = { layout: await probe(), front: frontApp() }
Object.assign(report.clicks, await clicks(['.bar', '[data-menu-action="settings"]']))

overlay.showPanel({ skill: skills.find((skill) => skill.id === 'translate'), text: '这是一段从别的应用里选中的文字，用来测试结果面板。', app: 'selftest', languages: [{ code: 'en', name: 'English' }], translateTarget: 'auto' })
overlay.begin('r1', {})
for (const chunk of ['This is ', 'text **selected** ', 'in another app.\n\n- one\n- two']) {
  overlay.append('r1', chunk)
  await sleep(60)
}
overlay.done('r1')
await sleep(400)
report.steps.translate = { layout: await probe(), front: frontApp() }
Object.assign(report.clicks, await clicks(['[data-tool="pin"]','[data-tool="copy"]', '.panel-language', '.panel-head', '.source', '.result']))

overlay.showPanel({ skill: skills.find((skill) => skill.id === 'ask'), text: 'E = mc²', app: 'selftest', languages: [] })
overlay.begin('r2', { question: '这是谁提出的？' })
overlay.append('r2', '爱因斯坦在 1905 年提出。')
overlay.done('r2')
await sleep(400)
report.steps.ask = { layout: await probe(), front: frontApp() }
Object.assign(report.clicks, await clicks(['.composer textarea', '.thread']))
overlay.setKeyable(false)

// Dragging moves the window by the pointer's travel, and later growth keeps the new top-left.
const before = { ...overlay.bounds }
overlay.drag('start', { x: 100, y: 100 })
overlay.drag('move', { x: 130, y: 140 })
overlay.drag('end', { x: 130, y: 140 })
overlay.append('r2', '\n\n补充一段，让面板变高。')
await sleep(300)
const after = overlay.bounds
const frame = overlay.inspect().frame
report.drag = { before, after, frame }

if (interactive) {
  overlay.showBar({ x: 640, y: 260, top: 240, precise: false })
  console.log('The toolbar is near the top centre of the screen. Click around for 20 seconds…')
  const timeline = []
  let last = ''
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const { appActive, isKey } = overlay.inspect()
    const state = `appActive=${appActive} isKey=${isKey} front=${frontApp()}`
    if (state !== last) timeline.push({ ms: Date.now() - started, state })
    last = state
    for (const message of messages.splice(0)) timeline.push({ ms: Date.now() - started, message: message.type, id: message.id ?? message.action })
    await sleep(100)
  }
  report.interactive = timeline
}

overlay.hide()
await sleep(200)
report.frontAfter = frontApp()
const problems = []
const bar = report.steps.bar
if (!bar.native.isPanel || !bar.native.nonactivatingPanel) problems.push('overlay is not a non-activating panel')
if (bar.native.appActive) problems.push('worker process became active')
if (bar.dock === 'Foreground') problems.push('worker shows a Dock icon')
for (const [name, step] of Object.entries(report.steps)) {
  if (!step.layout) problems.push(`${name}: page did not report its layout`)
  else if (step.layout.overflow.length) problems.push(`${name}: buttons overflow their card: ${step.layout.overflow.join(', ')}`)
  else if (step.layout.clipped) problems.push(`${name}: a card is clipped`)
  if (step.front !== frontBefore) problems.push(`${name}: frontmost app changed to ${step.front}`)
}
if (report.steps.menu.layout && report.steps.menu.layout.viewport.height <= bar.layout.viewport.height) problems.push('window did not grow for the ⋯ menu')
for (const [selector, types] of Object.entries(report.clicks)) {
  const expected = EXPECTED_CLICKS[selector] ?? []
  if (types.join() !== expected.join()) problems.push(`clicking ${selector} posted [${types.join(', ')}] instead of [${expected.join(', ')}]`)
}
const { before: from, after: to, frame: real } = report.drag
if (to.x - from.x !== 30 || to.y - from.y !== 40) problems.push(`drag moved the window by ${to.x - from.x},${to.y - from.y} instead of 30,40`)
if (real && (Math.abs(real.x - to.x) > 1 || Math.abs(real.y - to.y) > 1)) problems.push('the native frame does not match the dragged position')
report.problems = problems
console.log(JSON.stringify(report, null, 2))
overlay.dispose()
process.exit(problems.length ? 1 : 0)
