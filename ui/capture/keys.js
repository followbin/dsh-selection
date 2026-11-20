// Command and Control shortcuts count only when a person pressed the modifier.
//
// Selection tools such as selection-hook watch every drag and, when they cannot read the
// selection through Accessibility, post a copy keystroke into the frontmost window. That
// keystroke carries the Command flag, but no Command key ever goes down in this page,
// whereas a person always presses Command before C. Every surface loads this before its
// own script, so the check is the same everywhere.
'use strict'

const DSH_HELD_MODIFIERS = new Set()
// Capture phase, so the set is current before any page handler sees the key.
addEventListener('keydown', (e) => { if (e.key === 'Meta' || e.key === 'Control') DSH_HELD_MODIFIERS.add(e.key) }, true)
addEventListener('keyup', (e) => { if (e.key === 'Meta' || e.key === 'Control') DSH_HELD_MODIFIERS.delete(e.key) }, true)
addEventListener('blur', () => DSH_HELD_MODIFIERS.clear())

/** A shortcut whose modifier flag no key press in this page accounts for. */
function isSyntheticShortcut(e) {
  return (e.metaKey || e.ctrlKey) && !DSH_HELD_MODIFIERS.has('Meta') && !DSH_HELD_MODIFIERS.has('Control')
}
