// Where the overlay window goes. No native code: overlay.mjs supplies the selection, the page's card
// layout and the screen, all in the same top-left-origin points.

const SCREEN_INSET = 6
// With selection bounds the anchor is the selection's bottom edge; with only the mouse position it is
// roughly mid-line, so keep half a line more distance.
const GAP_PRECISE = 8
const GAP_MOUSE = 18

/**
 * The top edge of a card that grows downwards, and how tall it may grow. Below the selection when at
 * least `minRoom` fits there (it may then grow to the bottom of the screen); otherwise just above the
 * selection with `minRoom` of space, so it ends at the selection instead of covering it. The top edge
 * stays put afterwards, so text being read never moves.
 * @param {{ x: number, y: number, top: number, precise: boolean }} anchor
 * @param {number} minRoom
 * @param {{ x: number, y: number, width: number, height: number } | null} screen
 * @returns {{ top: number, room: number }}
 */
export function place(anchor, minRoom, screen) {
  const gap = anchor.precise ? GAP_PRECISE : GAP_MOUSE
  const below = anchor.y + gap
  if (!screen) return { top: below, room: Infinity }
  const floor = screen.y + screen.height - SCREEN_INSET
  if (floor - below >= minRoom) return { top: below, room: floor - below }
  const ceiling = anchor.top - gap
  const top = Math.max(screen.y + SCREEN_INSET, ceiling - minRoom)
  // A selection filling nearly the whole screen leaves no room above either; then cover it.
  return { top, room: ceiling - top >= minRoom ? ceiling - top : floor - top }
}

/** How tall a card whose top edge is at `top` may grow before it reaches the bottom of the screen. */
export function roomBelow(top, screen) {
  return screen ? screen.y + screen.height - SCREEN_INSET - top : Infinity
}

/**
 * Window bounds from a wanted top-left, with every card inside the screen: it moves left only as far
 * as the right edge requires, and likewise up. When a card is taller than the screen, its top edge,
 * with the panel's controls, is the part that stays visible.
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
