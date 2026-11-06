// User settings: the defaults, a normalizer that turns any input into a valid value,
// and a file-backed store. Everything the settings page sends goes through normalizeSettings.
import { readFileSync, renameSync } from 'node:fs'
import { writeFileAtomic } from './files.mjs'
import { CUSTOM_SKILL_ICONS, ICONS } from '../shared/icons.mjs'

/** Built-in skills in their default order. `kind` decides who handles a click. */
export const BUILTIN_SKILLS = Object.freeze([
  { id: 'translate', kind: 'prompt', icon: 'translate', name: { zh: '翻译', en: 'Translate' } },
  { id: 'summarize', kind: 'prompt', icon: 'summarize', name: { zh: '总结', en: 'Summarize' } },
  { id: 'explain', kind: 'prompt', icon: 'explain', name: { zh: '解释', en: 'Explain' } },
  { id: 'ask', kind: 'ask', icon: 'ask', name: { zh: '问问 DSH', en: 'Ask DSH' } },
  { id: 'speak', kind: 'speak', icon: 'speak', name: { zh: '朗读', en: 'Read aloud' } },
  { id: 'copy', kind: 'copy', icon: 'copy', name: { zh: '复制', en: 'Copy' } },
  { id: 'polish', kind: 'prompt', icon: 'polish', name: { zh: '润色', en: 'Polish' } },
  { id: 'search', kind: 'search', icon: 'search', name: { zh: '搜索', en: 'Search' } },
])

export const LANGUAGES = Object.freeze([
  { code: 'zh-CN', name: '简体中文', english: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', english: 'Traditional Chinese' },
  { code: 'en', name: 'English', english: 'English' },
  { code: 'ja', name: '日本語', english: 'Japanese' },
  { code: 'ko', name: '한국어', english: 'Korean' },
  { code: 'fr', name: 'Français', english: 'French' },
  { code: 'de', name: 'Deutsch', english: 'German' },
  { code: 'es', name: 'Español', english: 'Spanish' },
  { code: 'ru', name: 'Русский', english: 'Russian' },
  { code: 'pt', name: 'Português', english: 'Portuguese' },
])

export const SEARCH_ENGINES = Object.freeze({
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  baidu: 'https://www.baidu.com/s?wd=%s',
  duckduckgo: 'https://duckduckgo.com/?q=%s',
})

export const LIMITS = Object.freeze({
  toolbarSize: { min: 1, max: 8 },
  maxTextLength: { min: 200, max: 20000 },
  customSkills: 30,
  customName: 16,
  customPrompt: 4000,
  disabledApps: 200,
  appName: 200,
})

const LANGUAGE_CODES = new Set(LANGUAGES.map((language) => language.code))
const BUILTIN_IDS = new Set(BUILTIN_SKILLS.map((skill) => skill.id))
const CUSTOM_ID = /^custom-[a-z0-9]{4,24}$/

/** @returns {Settings} */
export function defaultSettings() {
  return {
    version: 1,
    enabled: true,
    trigger: 'auto',
    toolbarSize: 5,
    skills: BUILTIN_SKILLS.map((skill) => ({ id: skill.id, enabled: true })),
    disabledApps: [],
    nativeLanguage: 'zh-CN',
    translateTarget: 'auto',
    answerLanguage: 'native',
    model: { provider: '', model: '' },
    maxTextLength: 4000,
    clipboardFallback: true,
    searchEngine: 'google',
    customSearchUrl: '',
  }
}

/**
 * Coerces any value into valid settings. Unknown fields are dropped, bad values fall back to defaults.
 * @param {unknown} input
 * @returns {Settings}
 */
export function normalizeSettings(input) {
  const defaults = defaultSettings()
  const value = isObject(input) ? input : {}
  const settings = {
    version: 1,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    trigger: value.trigger === 'modifier' ? 'modifier' : 'auto',
    toolbarSize: clampInt(value.toolbarSize, LIMITS.toolbarSize, defaults.toolbarSize),
    skills: normalizeSkills(value.skills),
    disabledApps: normalizeApps(value.disabledApps),
    nativeLanguage: LANGUAGE_CODES.has(value.nativeLanguage) ? value.nativeLanguage : defaults.nativeLanguage,
    translateTarget: value.translateTarget === 'auto' || LANGUAGE_CODES.has(value.translateTarget) ? value.translateTarget : 'auto',
    answerLanguage: ['native', 'source'].includes(value.answerLanguage) || LANGUAGE_CODES.has(value.answerLanguage) ? value.answerLanguage : 'native',
    model: {
      provider: shortString(value.model?.provider, 100),
      model: shortString(value.model?.model, 200),
    },
    maxTextLength: clampInt(value.maxTextLength, LIMITS.maxTextLength, defaults.maxTextLength),
    clipboardFallback: typeof value.clipboardFallback === 'boolean' ? value.clipboardFallback : defaults.clipboardFallback,
    searchEngine: value.searchEngine === 'custom' || Object.hasOwn(SEARCH_ENGINES, value.searchEngine) ? value.searchEngine : 'google',
    customSearchUrl: isSearchTemplate(value.customSearchUrl) ? value.customSearchUrl.trim() : '',
  }
  if (settings.searchEngine === 'custom' && !settings.customSearchUrl) settings.searchEngine = 'google'
  return settings
}

/** URL template for the search skill; `%s` is replaced by the encoded selection. */
export function searchTemplate(settings) {
  return settings.searchEngine === 'custom' ? settings.customSearchUrl : SEARCH_ENGINES[settings.searchEngine]
}

/** Enabled skills in toolbar order, with what the toolbar needs to draw them. */
export function enabledSkills(settings) {
  const builtins = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]))
  return settings.skills.filter((entry) => entry.enabled).map((entry) => {
    if (entry.custom) return { id: entry.id, kind: 'prompt', icon: entry.icon, name: entry.name, custom: true }
    const builtin = builtins.get(entry.id)
    return { id: builtin.id, kind: builtin.kind, icon: builtin.icon, name: builtin.name, custom: false }
  })
}

/** Looks a skill up by id, including disabled ones (a click may race a settings change). */
export function findSkill(settings, id) {
  const entry = settings.skills.find((skill) => skill.id === id)
  if (!entry) return null
  if (entry.custom) return { ...entry, kind: 'prompt' }
  return { ...BUILTIN_SKILLS.find((skill) => skill.id === id), enabled: entry.enabled }
}

/**
 * File-backed settings. Writes are atomic (temp file + rename). A file that is not valid JSON is moved
 * aside and replaced by defaults instead of blocking startup.
 * @param {{ file: string, log?: (level: string, message: string, fields?: object) => void }} options
 */
export function createSettingsStore({ file, log }) {
  const listeners = new Set()
  // The file exists but could not be read (locked, out of descriptors). Until a read succeeds the
  // defaults stand in, and every access tries again, so a passing error never replaces the user's settings.
  let unread = false
  let current = load()

  function load() {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultSettings()
      if (!unread) log?.('warn', 'settings file could not be read, using defaults for now', { error: String(error?.message ?? error) })
      unread = true
      return defaultSettings()
    }
    unread = false
    try {
      return normalizeSettings(JSON.parse(text))
    } catch (error) {
      log?.('warn', 'settings file is not valid JSON, moved aside', { error: String(error?.message ?? error) })
      try { renameSync(file, `${file}.broken-${Date.now()}`) } catch { /* nothing left to preserve */ }
      return defaultSettings()
    }
  }

  function latest() {
    if (unread) current = load()
    return current
  }

  function save(next) {
    const normalized = normalizeSettings(next)
    // A change that normalization undid, or no change at all: nothing to write or announce.
    if (!unread && JSON.stringify(normalized) === JSON.stringify(current)) return current
    writeFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`)
    unread = false
    current = normalized
    for (const listener of listeners) listener(current)
    return current
  }

  return {
    get: latest,
    save,
    update: (change) => save(change(structuredClone(latest()))),
    reset: () => save(defaultSettings()),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function normalizeSkills(input) {
  const skills = []
  const seen = new Set()
  let customCount = 0
  for (const entry of Array.isArray(input) ? input : []) {
    if (!isObject(entry) || typeof entry.id !== 'string' || seen.has(entry.id)) continue
    const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : true
    if (BUILTIN_IDS.has(entry.id)) {
      skills.push({ id: entry.id, enabled })
      seen.add(entry.id)
      continue
    }
    if (!CUSTOM_ID.test(entry.id) || customCount >= LIMITS.customSkills) continue
    const name = shortString(entry.name, LIMITS.customName)
    const prompt = shortString(entry.prompt, LIMITS.customPrompt)
    if (!name || !prompt) continue
    const icon = CUSTOM_SKILL_ICONS.includes(entry.icon) && Object.hasOwn(ICONS, entry.icon) ? entry.icon : 'sparkles'
    skills.push({ id: entry.id, custom: true, enabled, name, icon, prompt })
    seen.add(entry.id)
    customCount += 1
  }
  // Skills added in a newer release show up enabled at the end of an existing list.
  for (const builtin of BUILTIN_SKILLS) {
    if (!seen.has(builtin.id)) skills.push({ id: builtin.id, enabled: true })
  }
  return skills
}

function normalizeApps(input) {
  const apps = new Set()
  for (const entry of Array.isArray(input) ? input : []) {
    const app = shortString(entry, LIMITS.appName)
    if (app) apps.add(app)
    if (apps.size >= LIMITS.disabledApps) break
  }
  return [...apps]
}

function isSearchTemplate(value) {
  if (typeof value !== 'string' || value.length > 500 || !value.includes('%s')) return false
  try {
    const url = new URL(value.trim().replace('%s', 'x'))
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function clampInt(value, { min, max }, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function shortString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @typedef {object} Settings
 * @property {1} version
 * @property {boolean} enabled Show the toolbar when text is selected.
 * @property {'auto' | 'modifier'} trigger `modifier` shows it only while ⌥ / Alt is held.
 * @property {number} toolbarSize How many enabled skills sit on the toolbar; the rest go to the ⋯ menu.
 * @property {Array<{ id: string, enabled: boolean, custom?: true, name?: string, icon?: string, prompt?: string }>} skills
 * @property {string[]} disabledApps Program names (as reported by the OS) where the toolbar never shows.
 * @property {string} nativeLanguage Language the user reads best; auto translation flips around it.
 * @property {string} translateTarget `auto` or a language code.
 * @property {string} answerLanguage `native`, `source` or a language code, for summaries, explanations and answers.
 * @property {{ provider: string, model: string }} model Empty strings pick a route automatically.
 * @property {number} maxTextLength Longer selections are cut before being sent anywhere.
 * @property {boolean} clipboardFallback Simulate a copy when accessibility APIs cannot read the selection.
 * @property {string} searchEngine A key of SEARCH_ENGINES or `custom`.
 * @property {string} customSearchUrl http(s) URL containing `%s`.
 */
