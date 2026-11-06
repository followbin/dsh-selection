import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { browserRejection, createHttpHandler, localRejection } from '../src/host/http.mjs'
import { BadRequest } from '../src/host/service.mjs'

function request({ method = 'GET', url = '/dsh-selection/api/state', headers = {}, body }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:4100', ...headers } })
  return req
}

function response() {
  const res = { status: 0, headers: {}, body: '', chunks: [] }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body ?? ''; res.ended = true }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.on = () => res
  return res
}

const fakeService = (overrides = {}) => ({
  getState: () => ({ settings: { ok: true }, status: { worker: 'running' } }),
  saveSettings: (input) => ({ saved: input }),
  resetSettings: () => ({ reset: true }),
  listModels: async () => ({ routes: [] }),
  testModel: async () => ({ ok: true }),
  testSkill: async () => ({ ok: true }),
  restartWorker: () => {},
  openPermissionSettings: () => {},
  subscribe: () => () => {},
  ...overrides,
})

async function call(service, options, connection) {
  const res = response()
  await createHttpHandler(service, { log: () => {}, connection })(request(options), res)
  return { ...res, json: res.body ? JSON.parse(res.body) : null }
}

describe('request gates', () => {
  test("DSH's connection service decides first", async () => {
    let touched = false
    const service = fakeService({ getState: () => { touched = true; return {} } })
    const unauthorized = await call(service, {}, { requestRejection: () => 401 })
    assert.equal(unauthorized.status, 401)
    assert.equal(touched, false)
    const allowed = await call(fakeService(), { headers: { host: 'dsh.example.com' } }, { requestRejection: () => undefined })
    assert.equal(allowed.status, 200, 'a remote Host admitted by DSH is not second-guessed')
  })

  test('without the connection service only loopback passes', () => {
    assert.equal(localRejection({ headers: { host: '127.0.0.1:4100' } }), undefined)
    assert.equal(localRejection({ headers: { host: 'localhost:4100' } }), undefined)
    assert.equal(localRejection({ headers: { host: '[::1]:4100' } }), undefined)
    assert.equal(localRejection({ headers: { host: 'evil.example:4100' } }), 403)
  })

  test('cross-site browser requests are refused even when admitted', async () => {
    assert.equal(browserRejection({ headers: { host: '127.0.0.1:4100', 'sec-fetch-site': 'cross-site' } }), true)
    assert.equal(browserRejection({ headers: { host: '127.0.0.1:4100', origin: 'https://evil.example' } }), true)
    assert.equal(browserRejection({ headers: { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100', 'sec-fetch-site': 'same-origin' } }), false)
    const res = await call(fakeService(), { method: 'PUT', url: '/dsh-selection/api/settings', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }, { requestRejection: () => undefined })
    assert.equal(res.status, 403)
  })
})

describe('HTTP API', () => {
  test('serves state', async () => {
    const res = await call(fakeService(), {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.settings, { ok: true })
    assert.equal(res.headers['cache-control'], 'no-store')
  })

  test('writes need JSON bodies', async () => {
    const res = await call(fakeService(), { method: 'PUT', url: '/dsh-selection/api/settings', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(res.status, 415)
  })

  test('saves settings', async () => {
    const res = await call(fakeService(), { method: 'PUT', url: '/dsh-selection/api/settings', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { settings: { saved: { enabled: false } } })
  })

  test('bad input is a 400, unknown paths a 404, failures a 500', async () => {
    const json = { 'content-type': 'application/json' }
    assert.equal((await call(fakeService(), { method: 'PUT', url: '/dsh-selection/api/settings', headers: json, body: '{oops' })).status, 400)
    assert.equal((await call(fakeService({ testSkill: async () => { throw new BadRequest('prompt and text are required') } }), { method: 'POST', url: '/dsh-selection/api/skills/test', headers: json, body: '{}' })).status, 400)
    assert.equal((await call(fakeService(), { url: '/dsh-selection/api/nope' })).status, 404)
    const failed = await call(fakeService({ listModels: async () => { throw new Error('boom') } }), { url: '/dsh-selection/api/models' })
    assert.equal(failed.status, 500)
    assert.equal(failed.json.error, 'internal error', 'internal errors are not echoed')
  })

  test('the event stream starts with status and settings and ends when the service closes', async () => {
    let listener = null
    const service = fakeService({ subscribe: (fn) => { listener = fn; return () => { listener = null } } })
    const res = response()
    await createHttpHandler(service, { log: () => {} })(request({ url: '/dsh-selection/api/events' }), res)
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.match(res.chunks[0], /^event: status\n/)
    assert.match(res.chunks[1], /^event: settings\n/)
    listener('closing', {})
    assert.equal(res.ended, true)
    assert.equal(listener, null)
  })
})
