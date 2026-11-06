// Runs the plugin outside DSH for UI work: the real worker and toolbar, a demo model instead of DSH's.
// Settings live in ~/.dsh/selection-dev so they never touch the installed plugin's.
// Run with DSH's Electron in Node mode: `pnpm dev`. On macOS the accessibility grant goes to your terminal app.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../src/host/log.mjs'
import { createSelectionService } from '../src/host/service.mjs'

const dataDir = join(homedir(), '.dsh', 'selection-dev')

const demoLlm = {
  listProviders: () => [{ id: 'demo', displayName: 'Demo' }],
  listModels: async () => [{ id: 'echo', displayName: 'Echo' }],
  async prepareCall(options) {
    return {
      config: options,
      async *stream({ system, messages }) {
        const text = messages[0].content[0].text
        const quoted = system.split('\n').map((line) => `> ${line}`).join('\n')
        const reply = `**Demo model** — DSH is not connected, so this echoes the request.\n\n${quoted}\n\n${text}`
        for (const piece of reply.match(/[\s\S]{1,8}/gu) ?? []) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const service = createSelectionService({
  getLlm: () => demoLlm,
  log: createLogger(join(dataDir, 'host.log'), { echo: true }),
  dataDir,
  desktop: true,
  promptForPermission: !process.argv.includes('--no-prompt'),
})
service.subscribe((event, data) => {
  if (event === 'status') console.error(`[dev-host] status ${JSON.stringify(data)}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await service.dispose()
    process.exit(0)
  })
}
