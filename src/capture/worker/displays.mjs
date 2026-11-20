// Display topology: the set of screens the overlay must cover, and when it changes.
//
// A capture session must freeze every display at the same moment, so the overlay owns
// one window per display. Displays come and go while the plugin runs (a laptop lid,
// a dock, a projector, a resolution change), and a stale topology shows the overlay on
// a screen that no longer exists or leaves a new one uncovered.

/** Milliseconds of quiet before a burst of reconfiguration events is treated as settled. */
const SETTLE_MS = 250

/**
 * @typedef {object} Display
 * @property {number} id Platform display id; stable while the display stays attached.
 * @property {number} x Top-left logical coordinate in the virtual desktop.
 * @property {number} y
 * @property {number} width Logical points.
 * @property {number} height Logical points.
 * @property {boolean} main
 */

/** Stable identity of one topology, used to tell a real change from a repeated event. */
function topologyKey(displays) {
  return displays
    .map(d => `${d.id}:${d.x},${d.y},${d.width}x${d.height}${d.main ? '*' : ''}`)
    .sort()
    .join('|')
}

/**
 * Tracks the current displays and reports settled changes.
 *
 * Reconfiguration arrives as a burst (a single dock event can move every display), so
 * changes are coalesced and only reported once the burst is quiet. The callback never
 * fires for an event that left the topology identical, which keeps a resolution probe
 * or a redundant notification from tearing down live overlay windows.
 *
 * @param {{
 *   native: { listDisplays: () => Display[], onDisplaysChanged: (cb: () => void) => () => void, cursorPoint: () => ({ x: number, y: number } | null) },
 *   onChange: (displays: Display[], previous: Display[]) => void,
 *   log?: (level: string, message: string, fields?: object) => void,
 *   settleMs?: number,
 * }} options
 */
export function createDisplayTracker({ native, onChange, log, settleMs = SETTLE_MS }) {
  let current = native.listDisplays()
  let key = topologyKey(current)
  let timer = null
  let disposed = false

  function settle() {
    timer = null
    if (disposed) return
    const next = native.listDisplays()
    if (next.length === 0) {
      // Every display is gone (all asleep, or mid-switch). Keep the last known set:
      // reporting an empty topology would dispose every overlay window, and the
      // following event almost always brings them back.
      log?.('warn', 'no active displays; keeping the previous topology', { had: current.length })
      return
    }
    const nextKey = topologyKey(next)
    if (nextKey === key) return
    const previous = current
    const wasKey = key
    current = next
    key = nextKey
    log?.('info', 'display topology changed', { from: previous.length, to: next.length, was: wasKey, now: nextKey })
    try {
      onChange(next, previous)
    } catch (error) {
      log?.('error', 'display change listener failed', { error: String(error?.message ?? error) })
    }
  }

  const stop = native.onDisplaysChanged(() => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(settle, settleMs)
  })

  return {
    /** The displays as last settled. Never empty once the tracker has started. */
    get displays() { return current },

    /**
     * The display the pointer is on, falling back to the main display. The overlay shows
     * this one first, because it is the only screen the user is looking at when the
     * hotkey fires; the rest can be frozen a frame later.
     * @returns {Display | null}
     */
    activeDisplay() {
      const point = native.cursorPoint()
      if (point) {
        const hit = current.find(d =>
          point.x >= d.x && point.x < d.x + d.width &&
          point.y >= d.y && point.y < d.y + d.height)
        if (hit) return hit
      }
      return current.find(d => d.main) ?? current[0] ?? null
    },

    /**
     * Re-read the topology now instead of waiting for an event.
     * A capture calls this first: a change that arrived without a notification, or one
     * still inside its settle window, would otherwise place the overlay on stale bounds.
     * @returns {boolean} true when the topology differed and listeners were told.
     */
    refresh() {
      const next = native.listDisplays()
      if (next.length === 0) return false
      const nextKey = topologyKey(next)
      if (nextKey === key) return false
      clearTimeout(timer)
      timer = null
      const previous = current
      current = next
      key = nextKey
      log?.('info', 'display topology changed (polled)', { from: previous.length, to: next.length })
      onChange(next, previous)
      return true
    },

    dispose() {
      disposed = true
      clearTimeout(timer)
      stop()
    },
  }
}
