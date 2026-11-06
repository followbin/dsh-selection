import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  BUILTIN_SKILLS, LIMITS, createSettingsStore, defaultSettings, enabledSkills, findSkill, normalizeSettings, searchTemplate,
} from '../src/host/settings.mjs'

describe('normalizeSettings', () => {
  test('defaults survive a round trip unchanged', () => {
    assert.deepEqual(normalizeSettings(defaultSettings()), defaultSettings())
  })

  test('anything that is not an object becomes the defaults', () => {
    for (const input of [null, undefined, 42, 'x', [], true]) assert.deepEqual(normalizeSettings(input), defaultSettings())
  })

  test('numbers are clamped and rounded, bad values fall back', () => {
    const settings = normalizeSettings({ toolbarSize: 99, maxTextLength: 12.7 })
    assert.equal(settings.toolbarSize, LIMITS.toolbarSize.max)
    assert.equal(settings.maxTextLength, LIMITS.maxTextLength.min)
    assert.equal(normalizeSettings({ toolbarSize: 'many' }).toolbarSize, 5)
    assert.equal(normalizeSettings({ toolbarSize: '3' }).toolbarSize, 3)
  })

  test('unknown enum values fall back', () => {
    const settings = normalizeSettings({ trigger: 'always', nativeLanguage: 'xx', translateTarget: 'klingon', answerLanguage: 'nope', searchEngine: 'altavista' })
    assert.equal(settings.trigger, 'auto')
    assert.equal(settings.nativeLanguage, 'zh-CN')
    assert.equal(settings.translateTarget, 'auto')
    assert.equal(settings.answerLanguage, 'native')
    assert.equal(settings.searchEngine, 'google')
  })

  test('built-in skills keep the given order, drop duplicates and unknown ids, and come back when missing', () => {
    const settings = normalizeSettings({ skills: [{ id: 'copy', enabled: false }, { id: 'copy' }, { id: 'translate' }, { id: 'teleport' }] })
    assert.deepEqual(settings.skills.slice(0, 2), [{ id: 'copy', enabled: false }, { id: 'translate', enabled: true }])
    assert.equal(settings.skills.length, BUILTIN_SKILLS.length)
    assert.deepEqual(new Set(settings.skills.map((skill) => skill.id)), new Set(BUILTIN_SKILLS.map((skill) => skill.id)))
  })

  test('custom skills are validated', () => {
    const settings = normalizeSettings({
      skills: [
        { id: 'custom-abcd1234', custom: true, name: '  Make a table that is far too long  ', icon: 'star', prompt: ' Tabulate it ' },
        { id: 'custom-bad id', custom: true, name: 'x', prompt: 'y' },
        { id: 'custom-empty12', custom: true, name: '', prompt: 'y' },
        { id: 'custom-noprompt', custom: true, name: 'x', prompt: '   ' },
        { id: 'custom-iconbad1', custom: true, name: 'x', prompt: 'y', icon: 'grip' },
      ],
    })
    const custom = settings.skills.filter((skill) => skill.custom)
    assert.equal(custom.length, 2)
    assert.equal(custom[0].name, 'Make a table tha')
    assert.equal(custom[0].prompt, 'Tabulate it')
    assert.equal(custom[0].icon, 'star')
    assert.equal(custom[1].icon, 'sparkles', 'icons outside the custom set fall back')
  })

  test('custom search needs an http(s) URL with %s', () => {
    assert.equal(normalizeSettings({ searchEngine: 'custom', customSearchUrl: 'javascript:alert(1)%s' }).searchEngine, 'google')
    assert.equal(normalizeSettings({ searchEngine: 'custom', customSearchUrl: 'https://example.com/?q=' }).searchEngine, 'google')
    const settings = normalizeSettings({ searchEngine: 'custom', customSearchUrl: ' https://example.com/?q=%s ' })
    assert.equal(settings.searchEngine, 'custom')
    assert.equal(searchTemplate(settings), 'https://example.com/?q=%s')
  })

  test('disabled apps are trimmed and unique', () => {
    assert.deepEqual(normalizeSettings({ disabledApps: [' Terminal ', 'Terminal', '', 3, 'Code'] }).disabledApps, ['Terminal', 'Code'])
  })
})

describe('skill lookup', () => {
  test('enabledSkills follows order and skips disabled ones', () => {
    const settings = normalizeSettings({ skills: [{ id: 'explain' }, { id: 'translate', enabled: false }, { id: 'custom-abcd1234', custom: true, name: 'Table', prompt: 'p', icon: 'list' }] })
    const ids = enabledSkills(settings).map((skill) => skill.id)
    assert.deepEqual(ids.slice(0, 2), ['explain', 'custom-abcd1234'])
    assert.ok(!ids.includes('translate'))
    assert.equal(enabledSkills(settings)[1].kind, 'prompt')
  })

  test('findSkill returns built-ins with their kind and custom skills as prompts', () => {
    const settings = normalizeSettings({ skills: [{ id: 'custom-abcd1234', custom: true, name: 'T', prompt: 'p' }] })
    assert.equal(findSkill(settings, 'speak').kind, 'speak')
    assert.equal(findSkill(settings, 'custom-abcd1234').kind, 'prompt')
    assert.equal(findSkill(settings, 'missing'), null)
  })
})

describe('createSettingsStore', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-selection-settings-'))
  after(() => rmSync(directory, { recursive: true, force: true }))

  test('starts from defaults, saves normalized settings and notifies listeners', () => {
    const file = join(directory, 'a', 'settings.json')
    const store = createSettingsStore({ file })
    assert.deepEqual(store.get(), defaultSettings())
    const seen = []
    store.onChange((settings) => seen.push(settings.toolbarSize))
    store.update((settings) => ({ ...settings, toolbarSize: 50 }))
    assert.deepEqual(seen, [LIMITS.toolbarSize.max])
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).toolbarSize, LIMITS.toolbarSize.max)
    assert.equal(createSettingsStore({ file }).get().toolbarSize, LIMITS.toolbarSize.max)
    assert.deepEqual(readdirSync(join(directory, 'a')), ['settings.json'], 'no temp files left behind')
  })

  test('a file that is not JSON is moved aside instead of blocking startup', () => {
    const file = join(directory, 'broken.json')
    writeFileSync(file, '{not json')
    const warnings = []
    const store = createSettingsStore({ file, log: (level, message) => warnings.push([level, message]) })
    assert.deepEqual(store.get(), defaultSettings())
    assert.equal(warnings[0][0], 'warn')
    assert.ok(readdirSync(directory).some((name) => name.startsWith('broken.json.broken-')))
  })

  test('a file that cannot be read right now is read again, never moved aside or overwritten', () => {
    const folder = join(directory, 'locked')
    const file = join(folder, 'settings.json')
    // Reading a directory fails with EISDIR, like a file another process holds locked.
    mkdirSync(file, { recursive: true })
    const store = createSettingsStore({ file, log: () => {} })
    assert.deepEqual(store.get(), defaultSettings())
    rmSync(file, { recursive: true })
    writeFileSync(file, JSON.stringify({ ...defaultSettings(), toolbarSize: 3, disabledApps: ['Terminal'] }))
    const saved = store.update((settings) => ({ ...settings, enabled: false }))
    assert.equal(saved.toolbarSize, 3)
    assert.deepEqual(saved.disabledApps, ['Terminal'])
    assert.equal(saved.enabled, false)
    assert.deepEqual(readdirSync(folder), ['settings.json'])
  })

  test('a file without read permission is never written over, and comes back to everyone once readable', {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  }, () => {
    const folder = join(directory, 'denied')
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'settings.json')
    writeFileSync(file, JSON.stringify({ ...defaultSettings(), enabled: false, disabledApps: ['Terminal'] }))
    chmodSync(file, 0o000)
    try {
      const store = createSettingsStore({ file, log: () => {} })
      assert.equal(store.get().enabled, true, 'defaults stand in')
      assert.throws(() => store.update((settings) => ({ ...settings, toolbarSize: 3 })), /cannot be read/)
      assert.throws(() => store.reset(), /cannot be read/)
      chmodSync(file, 0o600)
      const seen = []
      store.onChange((settings) => seen.push(settings.enabled))
      assert.equal(store.get().enabled, false, 'read again once it can be')
      assert.deepEqual(seen, [false], 'and the worker is told')
      assert.deepEqual(store.get().disabledApps, ['Terminal'], 'nothing was lost')
    } finally {
      chmodSync(file, 0o600)
    }
  })
})
