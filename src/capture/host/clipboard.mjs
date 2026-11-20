// Putting an image on the clipboard has no portable Node API, so each platform's own
// tool does it. The PNG goes through a file because both tools read a path, not stdin.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 5000

/** A PowerShell single-quoted literal: nothing inside is interpreted, quotes are doubled. */
const psLiteral = (text) => `'${String(text).replace(/'/g, "''")}'`

/**
 * Put plain text on the clipboard. Text goes in on stdin, so it never becomes part of a
 * command line and needs no escaping.
 * @param {string} text
 * @returns {Promise<void>}
 */
export function copyText(text) {
  const [command, args] = process.platform === 'darwin'
    ? ['pbcopy', []]
    // PowerShell reads stdin in the console's legacy code page unless told otherwise, which
    // turns Chinese text into question marks.
    : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error) reject(new Error(`clipboard copy failed: ${error.message}`))
      else resolve()
    })
    child.stdin.end(text, 'utf8')
  })
}

/**
 * @param {Buffer} png
 * @returns {Promise<void>}
 */
export function copyImage(png) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
  const file = join(dir, 'shot.png')
  writeFileSync(file, png)
  const [command, args] = process.platform === 'darwin'
    ? ['osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`]]
    : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; `
        + `$image = [System.Drawing.Image]::FromFile(${psLiteral(file)}); `
        + `[System.Windows.Forms.Clipboard]::SetImage($image); $image.Dispose()`]]
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error) => {
      rmSync(dir, { recursive: true, force: true })
      if (error) reject(new Error(`clipboard copy failed: ${error.message}`))
      else resolve()
    })
  })
}
