import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createModelClient } from '../src/host/llm.mjs'
import { createSelectionService } from '../src/host/service.mjs'
import { normalizeSettings } from '../src/host/settings.mjs'
import { createUsageStore } from '../src/host/usage.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-selection-usage-'))
after(() => rmSync(directory, { recursive: true, force: true }))

const FLASH = { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash' }
const PRO = { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-pro', modelName: 'DeepSeek-V4.1-Pro' }
const tokens = (input, output, extra = {}) => ({ inputTokens: input, outputTokens: output, ...extra })

function at(day) {
  let current = new Date(`${day}T12:00:00`)
  return { now: () => current, set: (next) => { current = new Date(`${next}T12:00:00`) } }
}

describe('usage store', () => {
  test('adds up requests and tokens per period, model and skill', () => {
    const clock = at('2026-11-06')
    const store = createUsageStore({ file: join(directory, 'a.json'), now: clock.now })
    clock.set('2026-10-01')
    store.record({ skill: 'explain', route: PRO, usage: tokens(500, 500) })
    clock.set('2026-11-01')
    store.record({ skill: 'translate', route: FLASH, usage: tokens(100, 20) })
    clock.set('2026-11-06')
    store.record({ skill: 'translate', route: FLASH, usage: tokens(40, 10, { cacheReadTokens: 30, reasoningTokens: 5 }) })
    store.record({ skill: 'ask', route: FLASH, usage: tokens(60, 30) })
    const { periods, since } = store.summary()
    assert.deepEqual(periods.today.totals, { requests: 2, input: 100, output: 40, cacheRead: 30, reasoning: 5 })
    assert.equal(periods.week.totals.requests, 3)
    assert.equal(periods.month.totals.requests, 3, 'October 1st is more than 30 days back')
    assert.equal(periods.all.totals.requests, 4)
    assert.deepEqual(periods.all.models.map((row) => [row.modelName, row.requests]), [['DeepSeek-V4.1-Pro', 1], ['DeepSeek-V4.1-Flash', 3]])
    assert.deepEqual(periods.week.skills.map((row) => [row.skill, row.input + row.output]), [['translate', 170], ['ask', 90]])
    assert.equal(since, '2026-10-01')
  })

  test('keeps 90 days, ignores missing or broken counts', () => {
    const clock = at('2026-01-01')
    const store = createUsageStore({ file: join(directory, 'b.json'), now: clock.now })
    store.record({ skill: 'translate', route: FLASH, usage: tokens(10, 10) })
    clock.set('2026-04-15')
    store.record({ skill: 'translate', route: FLASH, usage: { inputTokens: Number.NaN, outputTokens: -3 } })
    store.record({ skill: 'translate', route: FLASH, usage: null })
    const { periods, since } = store.summary()
    assert.equal(since, '2026-04-15', 'January is gone')
    assert.deepEqual(periods.all.totals, { requests: 1, input: 0, output: 0, cacheRead: 0, reasoning: 0 })
  })

  test('is written after a pause, read back, reset, and starts over from a broken file', () => {
    const file = join(directory, 'c.json')
    const store = createUsageStore({ file })
    store.record({ skill: 'translate', route: FLASH, usage: tokens(1, 2) })
    assert.equal(existsSync(file), false, 'nothing written at once')
    store.flush()
    assert.equal(createUsageStore({ file }).summary().periods.today.totals.output, 2)
    store.reset()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
    assert.equal(createUsageStore({ file }).summary().periods.all.totals.requests, 0)
    writeFileSync(file, '{broken')
    const warnings = []
    assert.equal(createUsageStore({ file, log: (level) => warnings.push(level) }).summary().since, null)
    assert.deepEqual(warnings, ['warn'])
  })
})

describe('usage reporting', () => {
  const settings = normalizeSettings({})
  const llmWith = (chunks) => ({
    listProviders: () => [{ id: 'deepseek-account', displayName: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
    prepareCall: async (options) => ({ config: options, async *stream() { yield* chunks } }),
  })

  test('the model client reports usage, also for a failed answer', async () => {
    const seen = []
    const client = createModelClient({ getLlm: () => llmWith([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'usage', usage: tokens(7, 3) },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'cut off' } } },
    ]) })
    const run = async () => {
      for await (const chunk of client.stream({ settings, prompt: () => ({ system: '', user: '' }), signal: new AbortController().signal, onUsage: (usage) => seen.push(usage) })) void chunk
    }
    await assert.rejects(run, /cut off/)
    assert.deepEqual(seen, [tokens(7, 3)])
  })

  test('a settings-page test run shows up in the usage summary and event', async () => {
    const llm = llmWith([{ type: 'text-delta', index: 0, text: 'Hello' }, { type: 'usage', usage: tokens(12, 4) }, { type: 'finish', reason: { kind: 'stop' } }])
    const service = createSelectionService({ getLlm: () => llm, log: () => {}, dataDir: join(directory, 'service'), desktop: false })
    const events = []
    service.subscribe((event, data) => events.push([event, data]))
    await service.testModel()
    const summary = service.getUsage()
    assert.deepEqual(summary.periods.today.skills.map((row) => [row.skill, row.input, row.output]), [['model-test', 12, 4]])
    assert.equal(summary.periods.today.models[0].modelName, 'DeepSeek-V4.1-Flash')
    assert.equal(events.find(([event]) => event === 'usage')[1].periods.today.totals.requests, 1)
    assert.equal(service.resetUsage().periods.all.totals.requests, 0)
    await service.dispose()
  })
})
