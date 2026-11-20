// Developer tool: runs the AI actions against sample screenshots through the real DSH model
// route and writes each reply to disk, so prompt changes can be judged on actual output.
//
// Active only when `<dataDir>/prompt-lab/` exists when the plugin starts. A run starts each
// time a file named `run` appears there; prompts.mjs and vision.mjs are re-imported per
// run, so edits to either are picked up without restarting DSH. Input is `cases.json`:
//   { "settings": { "language": "zh-CN" }, "cases": [{ "name", "image", "action", "question"?, "followUps"?: string[] }] }
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PARALLEL = 4

/**
 * @param {{ dir: string, getLlm: () => any, getAttachments: () => any, log: Function, settings: () => object }} options
 * @returns {() => void} stops watching.
 */
export function startPromptLab({ dir, getLlm, getAttachments, log, settings }) {
  let running = false
  const flag = join(dir, 'run')
  const poke = () => {
    if (running || !existsSync(flag)) return
    running = true
    try { unlinkSync(flag) } catch { /* another poke already took it */ }
    run().catch((error) => log('error', 'prompt lab failed', { error: String(error?.stack ?? error) }))
      .finally(() => { running = false; poke() })
  }

  async function run() {
    const spec = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'))
    const version = Date.now()
    const prompts = await import(`./prompts.mjs?v=${version}`)
    const { createVisionClient } = await import(`./vision.mjs?v=${version}`)
    const vision = createVisionClient({ getLlm, getAttachments, log })
    const config = { ...settings(), ...spec.settings }
    const out = join(dir, 'out', new Date().toISOString().replace(/[:.]/g, '-'))
    mkdirSync(out, { recursive: true })
    log('info', 'prompt lab run', { cases: spec.cases.length, out })
    const results = []
    const queue = spec.cases.map((c, index) => ({ ...c, index }))
    async function one(c) {
      const png = readFileSync(join(dir, c.image))
      const cfg = { ...config, ...c.settings }
      const system = prompts.systemPrompt(cfg)
      const turns = [{ role: 'user', text: prompts.actionPrompt(c.action, cfg, c.question) }]
      const exchanges = []
      for (const followUp of [null, ...(c.followUps ?? [])]) {
        if (followUp !== null) turns.push({ role: 'user', text: followUp })
        const started = Date.now()
        let first = null
        let text = ''
        let failure = null
        try {
          for await (const piece of vision.ask({ png, system, turns, model: cfg.model ?? null, signal: AbortSignal.timeout(120_000) })) {
            first ??= Date.now() - started
            text += piece
          }
        } catch (error) {
          failure = `${error?.code ?? 'ERROR'} ${error?.detail ?? error?.message ?? error}`
        }
        exchanges.push({ ask: turns.at(-1).text, firstMs: first, totalMs: Date.now() - started, text, failure })
        turns.push({ role: 'assistant', text })
      }
      const name = `${String(c.index).padStart(2, '0')}-${c.name}-${c.action}`
      const md = [`# ${name}`, '', `image: ${c.image}  language: ${cfg.language}  translateTarget: ${cfg.translateTarget}`, '', '## system', '', system, '']
      for (const e of exchanges) md.push('## ask', '', e.ask, '', `## reply (first ${e.firstMs} ms, total ${e.totalMs} ms)`, '', e.failure ? `FAILED: ${e.failure}` : e.text, '')
      writeFileSync(join(out, `${name}.md`), md.join('\n'))
      results.push({ name, exchanges: exchanges.map(({ firstMs, totalMs, failure, text }) => ({ firstMs, totalMs, failure, chars: text.length })) })
    }
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await one(c)
    }))
    writeFileSync(join(out, 'summary.json'), JSON.stringify(results.sort((a, b) => a.name.localeCompare(b.name)), null, 2))
    writeFileSync(join(dir, 'last-run'), out + '\n')
    log('info', 'prompt lab done', { out })
  }

  const watcher = watch(dir, (_event, file) => { if (file === 'run') poke() })
  poke()
  return () => watcher.close()
}
