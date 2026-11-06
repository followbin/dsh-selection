// HTTP API for the settings page, mounted on DSH's web server under /dsh-selection.
// DSH's `connection` service is the gate: it fences Host/Origin (cross-site calls, DNS rebinding) and
// requires the signed-in browser session, the same check DSH's own routes run. Writes must be JSON,
// which keeps simple cross-site form posts out even before that check.
import { BadRequest } from './service.mjs'

export const ROUTE = '/dsh-selection'
const MAX_BODY_BYTES = 256 * 1024
const KEEPALIVE_MS = 25_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * @param {ReturnType<import('./service.mjs').createSelectionService>} service
 * @param {{
 *   log: (level: string, message: string, fields?: object) => void,
 *   connection?: { requestRejection: (req: import('node:http').IncomingMessage) => number | undefined },
 * }} options Without `connection` (tests, the dev runner) only loopback same-origin requests pass.
 */
export function createHttpHandler(service, { log, connection }) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const status = connection ? connection.requestRejection(req) : localRejection(req)
    if (status !== undefined) return sendJson(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden' })
    if (browserRejection(req)) return sendJson(res, 403, { error: 'forbidden' })
    const writes = req.method === 'POST' || req.method === 'PUT'
    if (writes && !isJson(req)) return sendJson(res, 415, { error: 'expected application/json' })
    try {
      switch (`${req.method} ${path}`) {
        case 'GET /api/state':
          return sendJson(res, 200, service.getState())
        case 'GET /api/models':
          return sendJson(res, 200, await service.listModels())
        case 'GET /api/events':
          return openEventStream(req, res, service)
        case 'PUT /api/settings':
          return sendJson(res, 200, { settings: service.saveSettings(await readJson(req)) })
        case 'POST /api/settings/reset':
          return sendJson(res, 200, { settings: service.resetSettings() })
        case 'POST /api/models/test':
          return sendJson(res, 200, await service.testModel())
        case 'POST /api/skills/test':
          return sendJson(res, 200, await service.testSkill(await readJson(req)))
        case 'GET /api/usage':
          return sendJson(res, 200, service.getUsage())
        case 'POST /api/usage/reset':
          return sendJson(res, 200, service.resetUsage())
        case 'POST /api/worker/restart':
          service.restartWorker()
          return sendJson(res, 200, { ok: true })
        case 'POST /api/permission/open':
          service.openPermissionSettings()
          return sendJson(res, 200, { ok: true })
        default:
          return sendJson(res, 404, { error: 'not found' })
      }
    } catch (error) {
      if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message })
      log('error', 'request failed', { method: req.method, path, error: String(error?.message ?? error) })
      return sendJson(res, 500, { error: 'internal error' })
    }
  }
}

/** Fetch metadata and Origin say the request comes from another site. Cheap, and true for any Host. */
export function browserRejection(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

/** Fallback gate when DSH's connection service is absent: loopback only. */
export function localRejection(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0].toLowerCase()
  return LOOPBACK_HOSTS.has(hostname) ? undefined : 403
}

function isJson(req) {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
      } catch {
        reject(new BadRequest('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Server-sent events: `status`, `settings` and `navigate` (open the settings page). Every connection
 * starts with the current status and settings, so a page that reconnects never edits stale values.
 */
function openEventStream(req, res, service) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  let unsubscribe = () => {}
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
  const close = () => {
    clearInterval(keepalive)
    unsubscribe()
  }
  const write = (event, data) => {
    if (event === 'closing') {
      close()
      res.end()
      return
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const { status, settings } = service.getState()
  write('status', status)
  write('settings', settings)
  unsubscribe = service.subscribe(write)
  req.on('close', close)
  res.on('error', close)
}
