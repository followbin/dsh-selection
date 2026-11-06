import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fitWindow, planTop } from '../src/worker/placement.mjs'

const SCREEN = { x: 0, y: 0, width: 1470, height: 956 }
const selection = (top, bottom, precise = true) => ({ x: 700, y: bottom, top, precise })

describe('placing the overlay', () => {
  test('below the selection when the whole card fits there, so it grows downwards', () => {
    assert.equal(planTop(selection(200, 220), 440, SCREEN), 228)
    assert.equal(planTop(selection(200, 220, false), 440, SCREEN), 238, 'a mouse anchor keeps more distance')
  })

  test('above the selection with room for the whole card when it does not fit below', () => {
    const top = planTop(selection(700, 720), 440, SCREEN)
    assert.equal(top, 700 - 8 - 440)
    assert.ok(top + 440 <= 700, 'even at full height it stops short of the selection')
  })

  test('as low as the screen allows when it fits neither below nor above', () => {
    assert.equal(planTop(selection(300, 600), 440, SCREEN), 956 - 6 - 440)
    assert.equal(planTop(selection(5, 950), 2000, SCREEN), 6, 'a card taller than the screen starts at its top')
  })

  test('without a known screen the card goes below', () => {
    assert.equal(planTop(selection(700, 720), 440, null), 728)
  })

  test('every card stays inside the screen, on both axes, keeping the top when it must give', () => {
    const layout = { width: 456, height: 300, primary: { x: 18, y: 12, width: 420, height: 270 }, hits: [] }
    assert.deepEqual(fitWindow({ origin: { x: 100, y: 100 }, layout, screen: SCREEN }), { x: 100, y: 100, width: 456, height: 300 })
    assert.deepEqual(fitWindow({ origin: { x: -200, y: -50 }, layout, screen: SCREEN }), { x: 6 - 18, y: 6 - 12, width: 456, height: 300 })
    assert.deepEqual(fitWindow({ origin: { x: 1400, y: 900 }, layout, screen: SCREEN }), { x: 1470 - 6 - 438, y: 956 - 6 - 282, width: 456, height: 300 })
    const tall = { ...layout, height: 1200, primary: { ...layout.primary, height: 1170 } }
    assert.equal(fitWindow({ origin: { x: 100, y: 300 }, layout: tall, screen: SCREEN }).y, 6 - 12, 'the top edge with the controls stays')
  })

  test('the toolbar and its open menu are kept on screen together', () => {
    const layout = { width: 420, height: 260, primary: { x: 18, y: 12, width: 384, height: 40 }, hits: [{ x: 18, y: 12, width: 384, height: 40 }, { x: 250, y: 58, width: 180, height: 190 }] }
    const placed = fitWindow({ origin: { x: 600, y: 800 }, layout, screen: SCREEN })
    assert.equal(placed.y + 58 + 190, 956 - 6, 'the menu bottom sits on the screen edge')
  })

  test('displays at negative coordinates work the same way', () => {
    const above = { x: -204, y: -1080, width: 1920, height: 1080 }
    assert.equal(planTop({ x: 0, y: -900, top: -920, precise: true }, 440, above), -892)
    assert.equal(fitWindow({ origin: { x: -500, y: -1200 }, layout: { width: 100, height: 50, primary: { x: 0, y: 0, width: 100, height: 50 }, hits: [] }, screen: above }).x, -198)
  })
})
