// Writes a file so that readers see either the old or the new content, never half of it.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  try {
    replaceFile(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* already gone */ }
    throw error
  }
}

// Windows refuses to replace a file another process has open (antivirus, indexer, sync clients),
// usually for a few milliseconds.
function replaceFile(source, target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (process.platform !== 'win32' || attempt === 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt)
    }
  }
}
