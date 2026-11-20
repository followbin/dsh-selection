// Command and Control shortcuts count only when a person pressed the modifier.
//
// Selection tools such as selection-hook watch every drag and, when they cannot read the
// selection through Accessibility, post a copy keystroke into the frontmost window. That
// keystroke carries the Command flag with no Command key down. A modifier press this page
// sees settles it (Windows web views report Control). macOS web views never report the
// Command key itself, so the page asks its process, which reads the keyboard's own state and
// calls the page's `shortcut(key, shift)` back when a person holds the key. Every surface
// loads this before its own script, so the check is the same everywhere.
'use strict'

const DSH_HELD_MODIFIERS = new Set()
// Capture phase, so the set is current before any page handler sees the key.
addEventListener('keydown', (e) => { if (e.key === 'Meta' || e.key === 'Control') DSH_HELD_MODIFIERS.add(e.key) }, true)
addEventListener('keyup', (e) => { if (e.key === 'Meta' || e.key === 'Control') DSH_HELD_MODIFIERS.delete(e.key) }, true)
addEventListener('blur', () => DSH_HELD_MODIFIERS.clear())

/**
 * Hand a Command or Control shortcut to `run` when this page saw its modifier pressed, or ask
 * the process with a `shortcut-check` message otherwise.
 * @param {KeyboardEvent} e a keydown carrying Command or Control.
 * @param {(key: string, shift: boolean) => void} run the page's shortcut handler.
 * @param {(message: object) => void} post the page's channel to its process.
 */
function routeShortcut(e, run, post) {
  const key = e.key.toLowerCase()
  if (DSH_HELD_MODIFIERS.has('Meta') || DSH_HELD_MODIFIERS.has('Control')) return run(key, e.shiftKey)
  post({ type: 'shortcut-check', key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey })
}
