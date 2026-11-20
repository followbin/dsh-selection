// Asks a model about one screenshot, through DSH's own `llm` service and `attachments`
// store, so the request uses whatever account or API key the user already configured.
//
// A screenshot is useless to a text-only route: DSH replaces an image block it cannot send
// with a deterministic placeholder, so the answer would be about nothing. Routes are
// therefore filtered on declared image input, and a deployment with none fails loudly.
import { createHash } from 'node:crypto'

/** A dense full-screen OCR runs to a few thousand tokens. */
const MAX_OUTPUT_TOKENS = 4096
const FIRST_TOKEN_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 45_000
const ROUTE_CACHE_MS = 5 * 60_000
/** Attachment references by image hash, so follow-ups do not re-normalize the same PNG. */
const REF_CACHE_SIZE = 24

/** Media type from the file signature; captures are PNG, trial images from the page may not be. */
function mediaTypeOf(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  return null
}

export class VisionError extends Error {
  /** @param {'NO_LLM' | 'NO_VISION_MODEL' | 'NO_ATTACHMENTS' | 'MODEL_FAILED' | 'EMPTY' | 'TIMEOUT'} code */
  constructor(code, detail = '') {
    super(detail || code)
    this.code = code
    this.detail = detail
  }
}

/**
 * @typedef {{ provider: string, providerName: string, model: string, modelName: string }} Route
 * @typedef {{ role: 'user' | 'assistant', text: string }} Turn
 */

/**
 * @param {{
 *   getLlm: () => any,
 *   getAttachments: () => any,
 *   log: (level: string, message: string, fields?: object) => void,
 * }} options
 */
export function createVisionClient({ getLlm, getAttachments, log }) {
  let cache = null
  let generation = 0
  /** Routes that reject reasoning effort "off"; their default is used without asking twice. */
  const withoutOff = new Set()
  /** @type {Map<string, any>} */
  const refs = new Map()

  function llmService() {
    const llm = getLlm()
    if (!llm) throw new VisionError('NO_LLM')
    return llm
  }

  /** Provider/model pairs that declare image input. */
  async function imageRoutes({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < ROUTE_CACHE_MS) return cache.routes
    const started = generation
    const llm = llmService()
    const providers = llm.listProviders()
    const listings = await Promise.allSettled(providers.map((p) => llm.listModels(p.id)))
    const routes = []
    listings.forEach((result, index) => {
      const provider = providers[index]
      if (result.status === 'rejected') {
        log('warn', 'listing models failed', { provider: provider.id, error: String(result.reason?.message ?? result.reason) })
        return
      }
      for (const model of result.value ?? []) {
        // Absent metadata means unknown, not "yes": sending an image to a route that turns
        // out to be text-only silently answers about a placeholder.
        if (!model.inputModalities?.includes('image')) continue
        routes.push({
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          model: model.id,
          modelName: model.name ?? model.id,
        })
      }
    })
    if (started === generation) cache = { at: Date.now(), routes }
    return routes
  }

  /** @param {{ provider: string, model: string } | null} preferred */
  async function resolveRoute(preferred) {
    const routes = await imageRoutes()
    if (routes.length === 0) throw new VisionError('NO_VISION_MODEL')
    return (preferred && routes.find((r) => r.provider === preferred.provider && r.model === preferred.model)) || routes[0]
  }

  async function imageRef(png) {
    const key = createHash('sha256').update(png).digest('hex')
    const known = refs.get(key)
    if (known) return known
    const attachments = getAttachments()
    if (!attachments) throw new VisionError('NO_ATTACHMENTS')
    // The store normalizes and verifies before returning a reference; a refused image
    // throws here rather than reaching the model as something unreadable.
    const mediaType = mediaTypeOf(png)
    if (!mediaType) throw new VisionError('MODEL_FAILED', 'the image is not a PNG, JPEG, WebP or GIF')
    const [ref] = await attachments.saveImages([
      { data: new Uint8Array(png), mediaType, name: `screenshot.${mediaType.slice(6)}` },
    ])
    refs.set(key, ref)
    if (refs.size > REF_CACHE_SIZE) refs.delete(refs.keys().next().value)
    return ref
  }

  async function prepare(llm, route, signal) {
    const key = `${route.provider}\u0000${route.model}`
    const call = (effort) => llm.prepareCall({
      provider: route.provider,
      model: route.model,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...effort ? { reasoningEffort: effort } : {},
    }, signal)
    if (withoutOff.has(key)) return call(null)
    try {
      return await call('off')
    } catch (error) {
      if (signal.aborted) throw error
      if (error?.code === 'UNSUPPORTED_REASONING_EFFORT') withoutOff.add(key)
      log('info', 'reasoning effort off unavailable, using route default', { provider: route.provider, model: route.model })
      return call(null)
    }
  }

  return {
    imageRoutes,
    resolveRoute,
    invalidate() {
      generation += 1
      cache = null
      withoutOff.clear()
    },

    /**
     * Stream one reply. The image goes with the first user turn; later turns are the
     * conversation so far, so a follow-up is answered with the earlier answers in view.
     * @param {{
     *   png: Buffer,
     *   system: string,
     *   turns: Turn[],
     *   model: { provider: string, model: string } | null,
     *   signal?: AbortSignal,
     *   onUsage?: (route: Route, usage: object) => void,
     * }} input `turns` alternates user/assistant and ends with a user turn.
     * @returns {AsyncGenerator<string>} reply text, piece by piece.
     */
    async *ask({ png, system, turns, model, signal, onUsage }) {
      const silence = new AbortController()
      const combined = signal ? AbortSignal.any([signal, silence.signal]) : silence.signal
      let timer = setTimeout(() => silence.abort(), FIRST_TOKEN_TIMEOUT_MS)
      let route = null
      let usage = null
      let produced = false
      try {
        route = await resolveRoute(model)
        const ref = await imageRef(png)
        const llm = llmService()
        const prepared = await prepare(llm, route, combined)
        // DSH messages name their producer: the user, or the route that wrote an answer.
        // Earlier answers are attributed to the route answering now; this panel never
        // keeps a provider's replay state, so none is claimed.
        const messages = turns.map((turn, index) => ({
          id: `m${index}`,
          role: turn.role,
          source: turn.role === 'assistant'
            ? { kind: 'model', provider: route.provider, model: route.model }
            : { kind: 'user' },
          content: index === 0
            ? [{ type: 'image', attachment: ref }, { type: 'text', text: turn.text }]
            : [{ type: 'text', text: turn.text }],
        }))
        for await (const chunk of prepared.stream({ ...prepared.config, system, messages, signal: combined })) {
          clearTimeout(timer)
          timer = setTimeout(() => silence.abort(), IDLE_TIMEOUT_MS)
          // Reasoning arrives as its own deltas, also carrying `text`; only the reply is shown.
          if (chunk.type === 'text-delta' && chunk.text) {
            produced = true
            yield chunk.text
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
            throw new VisionError('MODEL_FAILED', chunk.reason.failure?.message ?? '')
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (silence.signal.aborted) throw new VisionError('TIMEOUT')
        if (error instanceof VisionError) throw error
        throw new VisionError('MODEL_FAILED', String(error?.message ?? error))
      } finally {
        clearTimeout(timer)
        if (route && usage) {
          try { onUsage?.(route, usage) } catch (error) {
            log('warn', 'recording usage failed', { error: String(error?.message ?? error) })
          }
        }
      }
      if (!produced) throw new VisionError('EMPTY')
    },
  }
}
