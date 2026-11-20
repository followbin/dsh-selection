// Whether a person pressed the modifier of a shortcut a page could not vouch for itself.

/**
 * Whether a person holds the modifier a page's `shortcut-check` carries (see ui/capture/keys.js).
 * A platform layer without `heldModifiers` cannot tell, and the answer is no: its pages see the
 * modifier key themselves and only ask about keystrokes that carry the flag alone.
 * @param {{ heldModifiers?: () => { meta: boolean, ctrl: boolean } }} native the platform layer.
 * @param {{ meta?: boolean, ctrl?: boolean }} check the page's message.
 * @returns {boolean}
 */
export function personHolds(native, check) {
  const held = native.heldModifiers?.()
  return Boolean(held && ((check.meta && held.meta) || (check.ctrl && held.ctrl)))
}

/**
 * The key and Shift state to hand back to the page that asked.
 * @param {{ key?: unknown, shift?: unknown }} check the page's message.
 * @returns {[string, boolean]}
 */
export function shortcutArgs(check) {
  return [String(check.key ?? '').slice(0, 8), Boolean(check.shift)]
}
