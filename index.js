// DSH plugin entry (Host side). Starts the selection service and mounts its HTTP API.
// The settings page lives in client.js; the toolbar runs in a worker process (src/worker).
import { join } from 'node:path'
import { createHttpHandler, ROUTE } from './src/host/http.mjs'
import { createLogger } from './src/host/log.mjs'
import { createSelectionService } from './src/host/service.mjs'
import { dataDirectory } from './src/shared/paths.mjs'

export const name = 'dsh-selection'
export const inject = ['webServer', 'connection']

/**
 * @param {any} ctx Cordis Host context.
 * @param {{ promptForPermission?: boolean, force?: boolean }} [config] Row config from cordis.patch.yml.
 *   `force` starts the toolbar outside DSH Desktop (only for a web Host on the user's own machine).
 */
export function apply(ctx, config = {}) {
  const dataDir = dataDirectory()
  const log = createLogger(join(dataDir, 'host.log'))
  // The toolbar must appear on the user's screen, so it only runs where the Host shares their desktop.
  const desktop = Boolean(process.versions.electron) || config.force === true
  const service = createSelectionService({
    // Looked up per request: the llm service may load after this plugin, or be swapped at runtime.
    getLlm: () => ctx.get('llm'),
    log,
    dataDir,
    desktop,
    promptForPermission: config.promptForPermission !== false,
  })
  log('info', 'plugin started', { platform: process.platform, desktop })
  ctx.effect(() => () => service.dispose(), 'dsh-selection: service')
  ctx.on('llm/adapters-updated', () => service.invalidateModels())
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: createHttpHandler(service, { log, connection: ctx.connection }),
    }),
    'dsh-selection: http routes',
  )
}
