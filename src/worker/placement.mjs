// Where the overlay window goes. No native code: overlay.mjs supplies the selection, the page's card
// layout and the screen, all in the same top-left-origin points.

const SCREEN_INSET = 6
// With selection bounds the anchor is the selection's bottom edge; with only the mouse position it is
// roughly mid-line, so keep half a line more distance.
const GAP_PRECISE = 8
const GAP_MOUSE = 18

/**
 * The top edge for a card that can grow to `height`. The top edge then stays put, so text being read
 * never moves while an answer streams in: below the selection when the card fits there, otherwise
 * above it with room for the whole height, otherwise as low as the screen allows, over part of it.
 * @param {{ x: number, y: number, top: number, precise: boolean }} anchor
 * @param {number} height
 * @param {{ x: number, y: number, width: number, height: number } | null} screen
 */
export function planTop(anchor, height, screen) {
  const gap = anchor.precise ? GAP_PRECISE : GAP_MOUSE
  const below = anchor.y + gap
  if (!screen) return below
  const lowest = screen.y + screen.height - SCREEN_INSET - height
  if (below <= lowest) return below
  const above = anchor.top - gap - height
  if (above >= screen.y + SCREEN_INSET) return above
  return Math.max(screen.y + SCREEN_INSET, lowest)
}

/**
 * Window bounds from a wanted top-left, with every card inside the screen. When a card is taller
 * than the screen, its top edge, with the panel's controls, is the part that stays visible.
 * @param {{ origin: { x: number, y: number }, layout: { width: number, height: number, primary: object, hits: object[] }, screen: object | null }} options
 */
export function fitWindow({ origin, layout, screen }) {
  let { x, y } = origin
  if (screen) {
    const cards = layout.hits.length ? layout.hits : [layout.primary]
    const left = Math.min(...cards.map((card) => card.x))
    const right = Math.max(...cards.map((card) => card.x + card.width))
    const top = Math.min(...cards.map((card) => card.y))
    const bottom = Math.max(...cards.map((card) => card.y + card.height))
    x = Math.max(screen.x + SCREEN_INSET - left, Math.min(x, screen.x + screen.width - SCREEN_INSET - right))
    y = Math.max(screen.y + SCREEN_INSET - top, Math.min(y, screen.y + screen.height - SCREEN_INSET - bottom))
  }
  return { x: Math.round(x), y: Math.round(y), width: layout.width, height: layout.height }
}
