import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, test } from 'node:test'
import * as plugin from '../index.js'
import { ROUTE } from '../src/host/http.mjs'

// The plugin writes its settings and log under $DSH_HOME/selection.
const home = mkdtempSync(join(tmpdir(), 'dsh-selection-plugin-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

function fakeContext() {
  const ctx = {
    llm: undefined,
    effects: [],
    routes: [],
    get: (name) => (name === 'llm' ? ctx.llm : undefined),
    effect(setup, label) {
      ctx.effects.push({ label, dispose: setup() })
    },
    webServer: {
      register(route) {
        ctx.routes.push(route)
        return () => { route.unmounted = true }
      },
    },
    connection: { requestRejection: () => undefined },
    listeners: {},
    on(name, listener) {
      ctx.listeners[name] = listener
      return () => delete ctx.listeners[name]
    },
  }
  return ctx
}

function fakeLlm(models) {
  return {
    listProviders: () => [{ id: 'deepseek-account' }],
    listModels: async () => models.map((id) => ({ id })),
    prepareCall: async (options) => ({
      config: options,
      async *stream() {
        yield { type: 'text-delta', index: 0, text: `answer from ${options.model}` }
      },
    }),
  }
}

async function get(route, path, method = 'GET') {
  const req = Readable.from(method === 'POST' ? [Buffer.from('{}')] : [])
  const headers = { host: '127.0.0.1:4100', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }
  Object.assign(req, { method, url: `${ROUTE}${path}`, headers })
  const res = { status: 0, body: '' }
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = body ?? '' }
  res.write = () => true
  res.on = () => res
  await route.handler(req, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

describe('plugin entry', () => {
  test('declares its name and the DSH services it needs', () => {
    assert.equal(plugin.name, 'dsh-selection')
    assert.deepEqual(plugin.inject, ['webServer', 'connection'])
  })

  test('the bundle patch loads the plugin by its npm package name', () => {
    const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(patch, new RegExp(`^\\s+name: '${name}'$`, 'm'))
  })

  test('mounts the settings API under its route, outside DSH Desktop without the toolbar', async () => {
    const ctx = fakeContext()
    plugin.apply(ctx)
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].kind, 'prefix')
    assert.equal(ctx.routes[0].path, ROUTE)
    const { status, json } = await get(ctx.routes[0], '/api/state')
    assert.equal(status, 200)
    assert.equal(json.status.supported, false, 'plain Node is not DSH Desktop')
    assert.ok(existsSync(join(home, 'selection', 'host.log')))
    for (const effect of ctx.effects.reverse()) await effect.dispose()
    assert.equal(ctx.routes[0].unmounted, true)
  })

  test('looks the model service up per request, so it may load after the plugin', async () => {
    const ctx = fakeContext()
    plugin.apply(ctx)
    assert.equal((await get(ctx.routes[0], '/api/models')).json.error.code, 'NO_LLM')
    ctx.llm = {
      listProviders: () => [{ id: 'deepseek-account' }],
      listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
    }
    const { json } = await get(ctx.routes[0], '/api/models')
    assert.equal(json.selected.modelName, 'DeepSeek-V4.1-Flash')
    for (const effect of ctx.effects.reverse()) await effect.dispose()
  })

  test('forgets the cached routes when DSH announces new model providers', async () => {
    const ctx = fakeContext()
    plugin.apply(ctx)
    ctx.llm = fakeLlm(['deepseek-flash'])
    assert.equal((await get(ctx.routes[0], '/api/models/test', 'POST')).json.route.model, 'deepseek-flash')
    ctx.llm = fakeLlm(['other-model'])
    assert.equal((await get(ctx.routes[0], '/api/models/test', 'POST')).json.route.model, 'deepseek-flash', 'still cached')
    ctx.listeners['llm/adapters-updated']()
    assert.equal((await get(ctx.routes[0], '/api/models/test', 'POST')).json.route.model, 'other-model')
    for (const effect of ctx.effects.reverse()) await effect.dispose()
  })
})
