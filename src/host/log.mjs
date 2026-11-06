// Small JSON-lines log under the plugin's data directory. It never records selected text or model
// output, only events, counts and errors, so it is safe to attach to bug reports.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 1024 * 1024

/**
 * @param {string} file
 * @param {{ echo?: boolean }} [options] Also print to stderr (useful when running outside DSH).
 * @returns {(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: object) => void}
 */
export function createLogger(file, { echo = false } = {}) {
  let ready = false
  return (level, message, fields = {}) => {
    const record = { time: new Date().toISOString(), level, message }
    // A field never replaces the record's own time, level or message.
    for (const [key, value] of Object.entries(fields)) record[key in record ? `_${key}` : key] = value
    const line = JSON.stringify(record)
    if (echo) console.error(`[dsh-selection] ${line}`)
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true })
        ready = true
      }
      if (statSize(file) > MAX_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // Logging must never take the plugin down.
    }
  }
}

function statSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
