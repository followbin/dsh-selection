// macOS system shortcuts (System Settings → Keyboard → Keyboard Shortcuts), read from the
// user's own com.apple.symbolichotkeys preferences, so a shortcut they turned off or moved is
// judged as it is now. Registering a global hot key does not check these, so the settings page
// asks here before the user keeps a chord the system also answers.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseHotkey } from '../worker/hotkey.mjs'

const PLIST = join(homedir(), 'Library/Preferences/com.apple.symbolichotkeys.plist')
const CACHE_MS = 30_000
/** NSEvent modifier flags as stored in the preferences; the function-key flag is ignored. */
const FLAGS = { Shift: 0x20000, Control: 0x40000, Alt: 0x80000, Meta: 0x100000 }
const MODIFIER_MASK = 0x1e0000
const FN = 0x800000

/**
 * System shortcuts that are on unless the preferences say otherwise, by their symbolic id:
 * [key code, modifier flags, Chinese name, English name].
 */
const DEFAULTS = {
  28: [20, FLAGS.Shift | FLAGS.Meta, '截屏（全屏）', 'Screenshot of the screen'],
  29: [20, FLAGS.Control | FLAGS.Shift | FLAGS.Meta, '截屏（全屏）到剪贴板', 'Screenshot of the screen to the clipboard'],
  30: [21, FLAGS.Shift | FLAGS.Meta, '截屏（所选区域）', 'Screenshot of a selected area'],
  31: [21, FLAGS.Control | FLAGS.Shift | FLAGS.Meta, '截屏（所选区域）到剪贴板', 'Screenshot of a selected area to the clipboard'],
  184: [23, FLAGS.Shift | FLAGS.Meta, '截屏和录制选项', 'Screenshot and recording options'],
  64: [49, FLAGS.Meta, '聚焦搜索', 'Spotlight search'],
  65: [49, FLAGS.Alt | FLAGS.Meta, '访达搜索窗口', 'Finder search window'],
  60: [49, FLAGS.Control, '选择上一个输入法', 'Select the previous input source'],
  61: [49, FLAGS.Control | FLAGS.Alt, '选择输入法菜单中的下一个输入法', 'Select the next input source'],
  52: [2, FLAGS.Alt | FLAGS.Meta, '打开/关闭程序坞隐藏', 'Turn Dock hiding on or off'],
}

let cache = null

function readPreferences() {
  return new Promise((resolve) => {
    execFile('plutil', ['-convert', 'json', '-o', '-', PLIST], { timeout: 3000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) return resolve({})
      try { resolve(JSON.parse(stdout).AppleSymbolicHotKeys ?? {}) } catch { resolve({}) }
    })
  })
}

/** Enabled system shortcuts as { code, flags, name: { zh, en } }. */
async function systemShortcuts() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list
  const prefs = await readPreferences()
  const list = []
  const ids = new Set([...Object.keys(DEFAULTS), ...Object.keys(prefs)])
  for (const id of ids) {
    const known = DEFAULTS[id]
    const entry = prefs[id]
    const enabled = entry ? entry.enabled !== false && entry.enabled !== 0 : Boolean(known)
    if (!enabled) continue
    const params = entry?.value?.parameters
    const code = Array.isArray(params) ? params[1] : known?.[0]
    const flags = Array.isArray(params) ? params[2] : known?.[1]
    if (!Number.isInteger(code) || code === 65535 || !Number.isInteger(flags)) continue
    list.push({ code, flags: flags & ~FN & MODIFIER_MASK, name: known ? { zh: known[2], en: known[3] } : null })
  }
  cache = { at: Date.now(), list }
  return list
}

/**
 * The enabled macOS system shortcut that uses the same keys, or null. Always null elsewhere.
 * @param {string} spec stored shortcut, e.g. "Alt+D".
 * @returns {Promise<{ zh: string, en: string } | null>} its name; unnamed ones read "系统快捷键".
 */
export async function systemShortcutFor(spec) {
  if (process.platform !== 'darwin' || !spec) return null
  const chord = parseHotkey(spec)
  if (!chord || chord.code === undefined) return null
  const flags = [...chord.modifiers].reduce((sum, name) => sum | (FLAGS[name] ?? 0), 0)
  const hit = (await systemShortcuts()).find((entry) => entry.code === chord.code && entry.flags === flags)
  if (!hit) return null
  return hit.name ?? { zh: '系统快捷键', en: 'a system shortcut' }
}
