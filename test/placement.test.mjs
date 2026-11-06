import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fitWindow, place, roomBelow } from '../src/worker/placement.mjs'

const SCREEN = { x: 0, y: 0, width: 1470, height: 956 }
const FLOOR = 956 - 6
const selection = (top, bottom, precise = true) => ({ x: 700, y: bottom, top, precise })

describe('placing the overlay', () => {
  test('below the selection when there is room, free to grow to the bottom of the screen', () => {
    assert.deepEqual(place(selection(200, 220), 280, SCREEN), { top: 228, room: FLOOR - 228 })
    assert.equal(place(selection(200, 220, false), 280, SCREEN).top, 238, 'a mouse anchor keeps more distance')
    assert.deepEqual(place(selection(600, 660), 280, SCREEN), { top: 668, room: FLOOR - 668 }, 'just enough room is enough')
  })

  test('just above the selection otherwise, growing down to it and no further', () => {
    const { top, room } = place(selection(840, 860), 280, SCREEN)
    assert.equal(top, 840 - 8 - 280)
    assert.equal(top + room, 840 - 8, 'at full height it ends where the selection starts')
  })

  test('a toolbar that does not fit below sits right above the selection', () => {
    assert.equal(place(selection(925, 945), 40, SCREEN).top, 925 - 8 - 40)
  })

  test('a selection filling the screen is covered rather than the card squeezed', () => {
    const { top, room } = place(selection(20, 940), 280, SCREEN)
    assert.equal(top, 6)
    assert.equal(room, FLOOR - 6)
  })

  test('the room below a dragged card ends at the bottom of its screen', () => {
    assert.equal(roomBelow(700, SCREEN), FLOOR - 700)
    assert.equal(roomBelow(700, null), Infinity)
    assert.deepEqual(place(selection(700, 720), 280, null), { top: 728, room: Infinity })
  })

  test('cards start at the selection end and move left or up only as far as the screen requires', () => {
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
    assert.equal(placed.y + 58 + 190, FLOOR, 'the menu bottom sits on the screen edge')
  })

  test('displays at negative coordinates work the same way', () => {
    const above = { x: -204, y: -1080, width: 1920, height: 1080 }
    assert.deepEqual(place({ x: 0, y: -900, top: -920, precise: true }, 280, above), { top: -892, room: -6 + 892 })
    assert.equal(fitWindow({ origin: { x: -500, y: -1200 }, layout: { width: 100, height: 50, primary: { x: 0, y: 0, width: 100, height: 50 }, hits: [] }, screen: above }).x, -198)
  })
})
