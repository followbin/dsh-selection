import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ModelError, createModelClient } from '../src/host/llm.mjs'
import { normalizeSettings } from '../src/host/settings.mjs'

function fakeLlm({ routes = { 'deepseek-account': ['deepseek-pro', 'deepseek-flash'], other: ['m1'] }, chunks = [], rejectOff = false, calls = [] } = {}) {
  return {
    listProviders: () => Object.keys(routes).map((id) => ({ id })),
    listModels: async (provider) => routes[provider].map((id) => ({ id })),
    prepareCall: async (options) => {
      calls.push(options)
      if (rejectOff && options.reasoningEffort === 'off') throw new Error('unsupported effort')
      return {
        config: { ...options },
        async *stream(request) {
          calls.push(request)
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
}

const settings = normalizeSettings({})
const collect = async (iterable) => {
  let text = ''
  for await (const chunk of iterable) text += chunk
  return text
}

describe('model client', () => {
  test('prefers DeepSeek Flash, honours an explicit route, falls back to the first one', async () => {
    const client = createModelClient({ getLlm: () => fakeLlm() })
    assert.deepEqual(await client.resolveRoute(settings).then(({ provider, model }) => [provider, model]), ['deepseek-account', 'deepseek-flash'])
    const chosen = normalizeSettings({ model: { provider: 'other', model: 'm1' } })
    assert.equal((await client.resolveRoute(chosen)).model, 'm1')
    const gone = normalizeSettings({ model: { provider: 'other', model: 'deleted' } })
    assert.equal((await client.resolveRoute(gone)).model, 'deepseek-flash')
    const plain = createModelClient({ getLlm: () => fakeLlm({ routes: { a: ['x'], b: ['y'] } }) })
    assert.equal((await plain.resolveRoute(settings)).model, 'x')
  })

  test('streams text deltas with thinking off and the system prompt attached', async () => {
    const calls = []
    const client = createModelClient({ getLlm: () => fakeLlm({ calls, chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] }) })
    const text = await collect(client.stream({ settings, prompt: () => ({ system: 'S', user: 'U' }), signal: new AbortController().signal }))
    assert.equal(text, 'Hello')
    assert.equal(calls[0].reasoningEffort, 'off')
    assert.equal(calls[1].system, 'S')
    assert.deepEqual(calls[1].messages, [{ role: 'user', content: [{ type: 'text', text: 'U' }] }])
  })

  test('builds the prompt for the route that will answer', async () => {
    const calls = []
    const seen = []
    const client = createModelClient({ getLlm: () => fakeLlm({ calls, chunks: [{ type: 'text-delta', index: 0, text: 'ok' }] }) })
    const prompt = (route) => {
      seen.push([route.provider, route.model])
      return { system: `S ${route.modelName}`, user: 'U' }
    }
    await collect(client.stream({ settings, prompt, signal: new AbortController().signal }))
    assert.deepEqual(seen, [['deepseek-account', 'deepseek-flash']])
    assert.equal(calls[1].system, 'S deepseek-flash')
  })

  test('providers are listed at once, and callers waiting together share one listing', async () => {
    let calls = 0
    let open = 0
    let most = 0
    const llm = {
      listProviders: () => [{ id: 'a' }, { id: 'b' }],
      listModels: async (provider) => {
        calls += 1
        most = Math.max(most, ++open)
        await new Promise((resolve) => setTimeout(resolve, 10))
        open -= 1
        return [{ id: `${provider}-model` }]
      },
    }
    const client = createModelClient({ getLlm: () => llm })
    const [first, second] = await Promise.all([client.listRoutes(), client.listRoutes()])
    assert.equal(first, second)
    assert.equal(calls, 2, 'one listing for both callers')
    assert.equal(most, 2, 'both providers at the same time')
    assert.deepEqual(first.map((route) => route.model), ['a-model', 'b-model'])
  })

  test('an empty or partial list is not cached, so a sign-in shows up on the next click', async () => {
    let routes = {}
    let failing = false
    const llm = {
      listProviders: () => Object.keys(routes).map((id) => ({ id })),
      listModels: async (provider) => {
        if (failing && provider === 'b') throw new Error('offline')
        return routes[provider].map((id) => ({ id }))
      },
    }
    const client = createModelClient({ getLlm: () => llm, log: () => {} })
    assert.deepEqual(await client.listRoutes(), [])
    routes = { a: ['m1'], b: ['m2'] }
    failing = true
    assert.deepEqual((await client.listRoutes()).map((route) => route.model), ['m1'])
    failing = false
    assert.deepEqual((await client.listRoutes()).map((route) => route.model), ['m1', 'm2'])
  })

  test('only an unsupported-effort rejection is remembered, and invalidate forgets it', async () => {
    const calls = []
    let reason = 'UNSUPPORTED_REASONING_EFFORT'
    const llm = fakeLlm({ calls, chunks: [{ type: 'text-delta', index: 0, text: 'ok' }] })
    llm.prepareCall = async (options) => {
      calls.push(options.reasoningEffort ?? 'default')
      if (options.reasoningEffort === 'off') throw Object.assign(new Error('no'), { code: reason })
      return { config: options, async *stream() { yield { type: 'text-delta', index: 0, text: 'ok' } } }
    }
    const client = createModelClient({ getLlm: () => llm, log: () => {} })
    const run = () => collect(client.stream({ settings, prompt: () => ({ system: '', user: '' }), signal: new AbortController().signal }))
    await run()
    await run()
    assert.deepEqual(calls, ['off', 'default', 'default'], 'the second click skips "off"')
    client.invalidate()
    calls.length = 0
    reason = 'NETWORK'
    await run()
    await run()
    assert.deepEqual(calls, ['off', 'default', 'off', 'default'], 'a passing failure is not remembered')
  })

  test('routes without an "off" effort use their default', async () => {
    const calls = []
    const client = createModelClient({ getLlm: () => fakeLlm({ calls, rejectOff: true, chunks: [{ type: 'text-delta', index: 0, text: 'ok' }] }), log: () => {} })
    assert.equal(await collect(client.stream({ settings, prompt: () => ({ system: '', user: '' }), signal: new AbortController().signal })), 'ok')
    assert.equal(calls[1].reasoningEffort, undefined)
  })

  test('failures map to stable codes', async () => {
    const signal = new AbortController().signal
    const code = (getLlm, chunks) => collect(createModelClient({ getLlm }).stream({ settings, prompt: () => ({ system: '', user: '' }), signal, chunks }))
      .then(() => 'none', (error) => (error instanceof ModelError ? error.code : String(error)))
    assert.equal(await code(() => undefined), 'NO_LLM')
    assert.equal(await code(() => fakeLlm({ routes: {} })), 'NO_MODEL')
    assert.equal(await code(() => fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }] })), 'MODEL_FAILED')
    assert.equal(await code(() => fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })), 'EMPTY')
  })

  test('a cancelled request rejects with the caller’s reason', async () => {
    const controller = new AbortController()
    const llm = fakeLlm({ chunks: [{ type: 'text-delta', index: 0, text: 'a' }] })
    llm.prepareCall = async (options, signal) => {
      controller.abort(new Error('user dismissed'))
      signal.throwIfAborted()
    }
    await assert.rejects(collect(createModelClient({ getLlm: () => llm }).stream({ settings, prompt: () => ({ system: '', user: '' }), signal: controller.signal })), /user dismissed/)
  })
})
