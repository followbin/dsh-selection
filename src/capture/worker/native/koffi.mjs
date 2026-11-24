// koffi for the native layers, loaded from its platform package.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Loads koffi's platform package directly. The `koffi` meta package runs an install
 * script that DSH's pnpm refuses by default; the platform packages carry the same
 * native API with no script.
 */
function loadKoffi() {
  const name = `@koromix/koffi-${process.platform}-${process.arch}`
  try {
    return require(name)
  } catch (error) {
    throw new Error(`${name} is missing; reinstall the plugin for this platform (${error.message})`)
  }
}

/** koffi's native API for this platform. */
export const koffi = loadKoffi()
