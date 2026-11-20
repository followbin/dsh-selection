// Global hotkey. The chord is registered with the system (see native registerHotkey), which
// keeps it from the front app; selection-hook, which already reports every key down/up
// system-wide under the Accessibility grant, listens alongside it as a fallback.
//
// Two things the obvious listener implementation gets wrong, both observed on macOS:
//
//   - `uniKey` is the *produced character*, not the key. Shift+2 arrives as "@", and a
//     plain letter arrives lowercase while a shifted one arrives uppercase. Matching on it
//     makes any chord with Shift unreachable. The physical `vkCode` is matched instead.
//   - Tracking modifiers from their own key events drifts whenever a key-up is missed,
//     which happens as soon as focus moves mid-chord. On macOS every event already carries
//     the live modifier state in `flags` (CGEventFlags), so that is read directly and no
//     state is kept.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** macOS CGEventFlags. Confirmed against captured events, where the idle base is 0x100. */
const MAC_FLAGS = { Shift: 0x20000, Control: 0x40000, Alt: 0x80000, Meta: 0x100000 }

const MODIFIERS = new Set(['Meta', 'Shift', 'Control', 'Alt'])
/** A held modifier with no key traffic for this long is treated as released (non-macOS path). */
const STUCK_MODIFIER_MS = 5000

/** Physical key codes. macOS: kVK_* from HIToolbox/Events.h. Windows: VK_*. */
const KEY_CODES = {
  darwin: {
    A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13,
    E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
    1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29,
    SPACE: 49, ESCAPE: 53, ENTER: 36, TAB: 48, BACKSPACE: 51,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
    F9: 101, F10: 109, F11: 103, F12: 111,
    LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126,
  },
  win32: {
    ...Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [c, 0x41 + i])),
    ...Object.fromEntries([...'0123456789'].map((c, i) => [c, 0x30 + i])),
    SPACE: 0x20, ESCAPE: 0x1b, ENTER: 0x0d, TAB: 0x09, BACKSPACE: 0x08,
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0x70 + i])),
    LEFT: 0x25, RIGHT: 0x27, DOWN: 0x28, UP: 0x26,
  },
}

const ALIASES = {
  cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
  ctrl: 'Control', option: 'Alt', opt: 'Alt',
}

/**
 * Parse `"Control+Alt+S"` into its modifier set and physical key.
 * @param {string} spec
 * @param {string} [platform]
 * @returns {{ modifiers: Set<string>, key: string, code: number | undefined } | null}
 */
export function parseHotkey(spec, platform = process.platform) {
  const parts = String(spec || '').split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const key = parts.pop().toUpperCase()
  const modifiers = new Set()
  for (const part of parts) {
    const name = ALIASES[part.toLowerCase()] ?? part[0].toUpperCase() + part.slice(1).toLowerCase()
    if (!MODIFIERS.has(name)) return null
    modifiers.add(name)
  }
  return { modifiers, key, code: KEY_CODES[platform]?.[key] }
}

/** Modifier set the event itself reports, or null when this platform does not carry it. */
function modifiersFromFlags(flags) {
  if (process.platform !== 'darwin' || typeof flags !== 'number') return null
  const set = new Set()
  for (const [name, mask] of Object.entries(MAC_FLAGS)) if ((flags & mask) !== 0) set.add(name)
  return set
}

const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v))

/** Both paths can report the same press; the later report within this window is the echo. */
const ECHO_MS = 600

/**
 * The capture shortcut. It is registered with the system first (`native.registerHotkey`), so
 * the chord reaches only us and the front app does not also act on it; selection-hook keeps
 * listening as well, which still triggers when registration is unavailable or another app
 * holds the chord, and may report a registered press before the event loop delivers it.
 * @param {{
 *   spec: string,
 *   onTrigger: () => void,
 *   log: (level: string, message: string, fields?: object) => void,
 *   native?: { registerHotkey?: (chord: { code: number, modifiers: Set<string> }, onPress: () => void) => any },
 *   onStatus?: (status: { spec: string | null, registered: boolean, reason: string | null, listening: boolean }) => void,
 *   load?: () => any,
 *   debugKeys?: boolean,
 * }} options `load` is injected by tests; by default the vendored selection-hook is used.
 * @returns {{ setSpec: (spec: string) => boolean, status: () => object, dispose: () => void, available: boolean }}
 */
export function createHotkey({ spec, onTrigger, log, native, onStatus, load, debugKeys = false }) {
  let current = spec || null
  let chord = parseHotkey(current)
  if (!chord && current) log('warn', 'unparseable hotkey; capture can still be triggered from DSH', { spec: current })
  else if (chord && chord.code === undefined) log('warn', 'hotkey key is not in the code table; matching falls back to the typed character', { spec: current, key: chord.key })

  let lastFire = 0
  let lastSource = null
  function fire(source) {
    const now = Date.now()
    if (now - lastFire < ECHO_MS && source !== lastSource) {
      log('info', 'hotkey echo ignored', { source, afterMs: now - lastFire, first: lastSource })
      return
    }
    lastFire = now
    lastSource = source
    log('info', 'hotkey pressed', { source })
    try { onTrigger() } catch (error) {
      log('error', 'hotkey handler failed', { error: String(error?.message ?? error) })
    }
  }

  // --- system registration ----------------------------------------------------------
  let registration = null
  let registered = false
  let reason = null
  function register() {
    registration?.dispose?.()
    registration = null
    registered = false
    reason = null
    if (!chord) { reason = current ? 'invalid' : 'off'; return }
    if (typeof native?.registerHotkey !== 'function' || chord.code === undefined) { reason = 'unsupported'; return }
    // Delivered inside app.pumpEvents(); the capture opens windows, so it runs after the pump returns.
    const result = native.registerHotkey({ code: chord.code, modifiers: chord.modifiers }, () => setImmediate(() => fire('system')))
    if (result.ok) { registration = result; registered = true; return }
    reason = result.reason
    log(result.reason === 'taken' ? 'warn' : 'error', 'hotkey registration failed', { spec: current, reason: result.reason, status: result.status })
  }

  // --- selection-hook listener ------------------------------------------------------------
  let hook = null
  let listening = false
  // Only used where the event carries no modifier state of its own.
  const held = new Set()
  let lastEventAt = 0

  function onDown(data) {
    if (held.size > 0 && Date.now() - lastEventAt > STUCK_MODIFIER_MS) held.clear()
    lastEventAt = Date.now()
    const key = data?.uniKey
    if (debugKeys) log('info', 'key-down', { uniKey: key, vkCode: data?.vkCode, flags: data?.flags })
    if (!key) return
    if (MODIFIERS.has(key)) { held.add(key); return }
    if (!chord) return

    // The character is unreliable (Shift+2 is "@"); the physical key is not. Only a key
    // outside the table falls back to comparing what was typed.
    const hit = chord.code !== undefined
      ? data.vkCode === chord.code
      : key.toUpperCase() === chord.key
    if (!hit) return

    const live = modifiersFromFlags(data.flags) ?? held
    if (!sameSet(chord.modifiers, live)) return
    fire('listener')
  }

  function onUp(data) {
    lastEventAt = Date.now()
    if (debugKeys) log('info', 'key-up', { uniKey: data?.uniKey, vkCode: data?.vkCode, flags: data?.flags })
    if (data?.uniKey && MODIFIERS.has(data.uniKey)) held.delete(data.uniKey)
  }

  try {
    const SelectionHook = (load ?? (() => require('../../../vendor/selection-hook/index.js')))()
    hook = new (SelectionHook.default ?? SelectionHook)()
    hook.on('key-down', onDown)
    hook.on('key-up', onUp)
    // This hook exists for key events only. selection-hook's defaults also watch every
    // drag for a text selection and, when Accessibility cannot read it, synthesize a copy
    // keystroke into the frontmost app. Inside the capture overlay that drag is the
    // region pick, so the synthetic copy landed in the page and ended the capture.
    hook.start({ debug: false, enableClipboard: false, selectionPassiveMode: true })
    listening = true
  } catch (error) {
    log('warn', 'selection-hook unavailable; the shortcut relies on system registration', { error: String(error?.message ?? error) })
    try { hook?.off?.('key-down', onDown); hook?.off?.('key-up', onUp) } catch { /* never started */ }
    hook = null
  }

  const status = () => ({ spec: current, registered, reason, listening })
  register()
  log('info', 'global hotkey armed', { spec: current, key: chord?.key, code: chord?.code, registered, reason, listening })
  onStatus?.(status())

  return {
    get available() { return registered || listening },
    status,
    /** An empty spec turns the shortcut off; an unparseable one keeps the current chord. */
    setSpec(next) {
      const parsed = parseHotkey(next)
      if (!parsed && next) return false
      current = next || null
      chord = parsed
      held.clear()
      register()
      log('info', 'hotkey changed', { spec: current, key: parsed?.key, code: parsed?.code, registered, reason })
      onStatus?.(status())
      return true
    },
    dispose() {
      registration?.dispose?.()
      registration = null
      try { hook?.off('key-down', onDown); hook?.off('key-up', onUp); hook?.stop() } catch { /* already down */ }
    },
  }
}
