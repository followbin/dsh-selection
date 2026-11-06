import { homedir } from 'node:os'
import { join } from 'node:path'

/** `$DSH_HOME/selection` (usually `~/.dsh/selection`), next to DSH's own data. */
export function dataDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'selection')
}
