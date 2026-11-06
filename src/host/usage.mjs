// Token usage per day, model and skill, for the settings page. Only counts are kept, never text.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './files.mjs'

const KEEP_DAYS = 90
// Several answers in a row should cost one write.
const WRITE_DELAY_MS = 2000
const PERIODS = { today: 1, week: 7, month: 30, all: KEEP_DAYS }

/** @typedef {{ requests: number, input: number, output: number, cacheRead: number, reasoning: number }} Counts */

/**
 * @param {{ file: string, log?: (level: string, message: string, fields?: object) => void, now?: () => Date }} options
 */
export function createUsageStore({ file, log, now = () => new Date() }) {
  let data = load()
  let timer = null

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version === 1 && parsed.days && parsed.routes) return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.('warn', 'usage file unreadable, starting over', { error: String(error?.message ?? error) })
    }
    return { version: 1, days: {}, routes: {} }
  }

  function write() {
    clearTimeout(timer)
    timer = null
    try {
      writeFileAtomic(file, JSON.stringify(data))
    } catch (error) {
      log?.('warn', 'saving usage failed', { error: String(error?.message ?? error) })
    }
  }

  /**
   * @param {{ skill: string, route: { provider: string, providerName: string, model: string, modelName: string }, usage: object }} entry
   *   `usage` is DSH's TokenUsage for one request.
   */
  function record({ skill, route, usage }) {
    if (!route || !usage) return
    const key = `${route.provider}\u0000${route.model}`
    data.routes[key] = { provider: route.provider, providerName: route.providerName, model: route.model, modelName: route.modelName }
    const today = dayOf(now())
    const counts = (((data.days[today] ??= {})[key] ??= {})[skill] ??= empty())
    counts.requests += 1
    counts.input += number(usage.inputTokens)
    counts.output += number(usage.outputTokens)
    counts.cacheRead += number(usage.cacheReadTokens)
    counts.reasoning += number(usage.reasoningTokens)
    const oldest = dayOf(addDays(now(), -(KEEP_DAYS - 1)))
    for (const day of Object.keys(data.days)) if (day < oldest) delete data.days[day]
    timer ??= setTimeout(write, WRITE_DELAY_MS)
  }

  /** Totals, and the same split by model and by skill, for each period. */
  function summary() {
    const today = now()
    const periods = {}
    for (const [name, length] of Object.entries(PERIODS)) {
      const from = dayOf(addDays(today, -(length - 1)))
      const totals = empty()
      const models = new Map()
      const skills = new Map()
      for (const [day, routes] of Object.entries(data.days)) {
        if (day < from) continue
        for (const [key, bySkill] of Object.entries(routes)) {
          for (const [skill, counts] of Object.entries(bySkill)) {
            add(totals, counts)
            add(models.get(key) ?? models.set(key, empty()).get(key), counts)
            add(skills.get(skill) ?? skills.set(skill, empty()).get(skill), counts)
          }
        }
      }
      periods[name] = {
        totals,
        models: sorted(models).map(([key, counts]) => ({ ...data.routes[key], ...counts })),
        skills: sorted(skills).map(([skill, counts]) => ({ skill, ...counts })),
      }
    }
    const since = Object.keys(data.days).sort()[0] ?? null
    return { periods, since }
  }

  return {
    record,
    summary,
    reset() {
      data = { version: 1, days: {}, routes: {} }
      write()
    },
    /** Writes what is still waiting for the debounce. */
    flush() {
      if (timer) write()
    },
  }
}

function empty() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0 }
}

function add(target, counts) {
  for (const key of Object.keys(target)) target[key] += number(counts[key])
}

function number(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function sorted(map) {
  return [...map].sort(([, a], [, b]) => b.input + b.output - (a.input + a.output))
}

/** The local calendar day, so "today" matches the user's clock. */
function dayOf(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}
