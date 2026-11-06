// Calls models through DSH's own `llm` service, so requests use whatever account or API key the user
// already configured in DSH. Each skill click is one request with no tools and thinking off; Ask DSH
// carries the earlier turns of its panel in that request.

const PREFERRED_ROUTES = [
  ['deepseek-account', 'deepseek-flash'],
  ['deepseek-official', 'deepseek-flash'],
]
const MAX_OUTPUT_TOKENS = 4096
// Silence limits rather than a total limit: a long, healthy answer keeps streaming as long as it needs.
const FIRST_TOKEN_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 45_000
const ROUTE_CACHE_MS = 5 * 60_000

/** @typedef {{ provider: string, providerName: string, model: string, modelName: string }} Route */

export class ModelError extends Error {
  /**
   * @param {'NO_LLM' | 'NO_MODEL' | 'MODEL_FAILED' | 'EMPTY' | 'TIMEOUT'} code Stable code the UI translates.
   * @param {string} [detail] Provider message, shown as a secondary line.
   */
  constructor(code, detail = '') {
    super(detail || code)
    this.code = code
    this.detail = detail
  }
}

/**
 * @param {{ getLlm: () => any, log?: (level: string, message: string, fields?: object) => void }} options
 */
export function createModelClient({ getLlm, log }) {
  let cache = null
  let listing = null
  // Routes that reject an "off" reasoning level; without this every click would prepare the call twice.
  const withoutOff = new Set()

  function llmService() {
    const llm = getLlm()
    if (!llm) throw new ModelError('NO_LLM')
    return llm
  }

  /** Every provider/model pair DSH can currently call. Concurrent callers share one listing. */
  function listRoutes({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < ROUTE_CACHE_MS) return Promise.resolve(cache.routes)
    if (!fresh && listing) return listing
    const current = readRoutes().finally(() => {
      if (listing === current) listing = null
    })
    listing = current
    return current
  }

  async function readRoutes() {
    const llm = llmService()
    const providers = llm.listProviders()
    // Each provider looks up its credentials and may fetch its model list, so ask them all at once.
    const results = await Promise.allSettled(providers.map((provider) => llm.listModels(provider.id)))
    const routes = []
    let complete = true
    results.forEach((result, index) => {
      const provider = providers[index]
      if (result.status === 'rejected') {
        complete = false
        log?.('warn', 'listing models failed', { provider: provider.id, error: String(result.reason?.message ?? result.reason) })
        return
      }
      for (const model of result.value ?? []) {
        routes.push({
          provider: provider.id,
          providerName: provider.displayName ?? provider.name ?? provider.label ?? provider.id,
          model: model.id,
          modelName: model.displayName ?? model.name ?? model.id,
        })
      }
    })
    // An empty or partial list is often minutes from being fixed (a sign-in, a provider hiccup);
    // caching it would keep answering NO_MODEL, or a fallback route, after that.
    cache = complete && routes.length ? { at: Date.now(), routes } : null
    return routes
  }

  /** The configured route if it still exists, otherwise DeepSeek Flash, otherwise the first route. */
  async function resolveRoute(settings) {
    const routes = await listRoutes()
    if (routes.length === 0) throw new ModelError('NO_MODEL')
    const { provider, model } = settings.model
    const pick = (p, m) => routes.find((route) => route.provider === p && route.model === m)
    if (provider && model && pick(provider, model)) return pick(provider, model)
    for (const [p, m] of PREFERRED_ROUTES) if (pick(p, m)) return pick(p, m)
    return routes[0]
  }

  /**
   * Streams the reply text.
   * @param {{
   *   settings: import('./settings.mjs').Settings,
   *   prompt: (route: Route) => { system: string, user: string },
   *   signal: AbortSignal,
   *   onUsage?: (usage: object) => void,
   * }} request `prompt` runs once the route is known, so the request can name the model answering it.
   *   `onUsage` receives DSH's token counts for the request, also when it fails or is cancelled.
   * @returns {AsyncGenerator<string>}
   */
  async function* stream({ settings, prompt, signal, onUsage }) {
    const llm = llmService()
    const silence = new AbortController()
    let timer = setTimeout(() => silence.abort(), FIRST_TOKEN_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, silence.signal])
    const failed = (error) => {
      if (signal.aborted) return signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (silence.signal.aborted) return new ModelError('TIMEOUT')
      return error instanceof ModelError ? error : new ModelError('MODEL_FAILED', String(error?.message ?? error))
    }
    let usage = null
    try {
      const route = await abortable(resolveRoute(settings), combined)
      const { system, user } = prompt(route)
      const prepare = (effort) => llm.prepareCall({
        provider: route.provider,
        model: route.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        ...effort ? { reasoningEffort: effort } : {},
      }, combined)
      const key = `${route.provider}\u0000${route.model}`
      let prepared
      if (withoutOff.has(key)) prepared = await prepare(null)
      else {
        try {
          prepared = await prepare('off')
        } catch (error) {
          if (combined.aborted) throw error
          // Routes without an "off" reasoning level reject it; their own default is the next best choice.
          prepared = await prepare(null)
          if (error?.code === 'UNSUPPORTED_REASONING_EFFORT') withoutOff.add(key)
          log?.('info', 'reasoning effort off unavailable, using route default', { provider: route.provider, model: route.model, error: String(error?.message ?? error) })
        }
      }
      const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
      let produced = false
      for await (const chunk of prepared.stream({ ...prepared.config, system, messages, signal: combined })) {
        clearTimeout(timer)
        timer = setTimeout(() => silence.abort(), IDLE_TIMEOUT_MS)
        if (chunk.type === 'text-delta' && chunk.text) {
          produced = true
          yield chunk.text
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error') throw new ModelError('MODEL_FAILED', chunk.reason.failure?.message ?? '')
          if (chunk.reason?.kind === 'aborted') throw new DOMException('Aborted', 'AbortError')
        }
      }
      if (!produced) throw new ModelError('EMPTY')
    } catch (error) {
      throw failed(error)
    } finally {
      clearTimeout(timer)
      if (usage) {
        try {
          onUsage?.(usage)
        } catch (error) {
          log?.('warn', 'recording usage failed', { error: String(error?.message ?? error) })
        }
      }
    }
  }

  /** Forgets what was learned about the routes, after DSH's providers or the chosen model change. */
  function invalidate() {
    cache = null
    withoutOff.clear()
  }

  return { listRoutes, resolveRoute, stream, invalidate }
}

/** Rejects as soon as the signal aborts, even if the work itself cannot be cancelled. */
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
