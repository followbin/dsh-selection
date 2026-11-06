// Hands a URL to the operating system's default handler. Callers decide which URLs may be opened;
// the log never carries the URL, which can come from model output.
import { spawn } from 'node:child_process'

export function openWithSystem(href, log) {
  try {
    const child = process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', href], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('open', [href], { detached: true, stdio: 'ignore' })
    child.on('error', (error) => log?.('warn', 'opening a URL failed', { error: error.message }))
    child.unref()
  } catch (error) {
    log?.('warn', 'opening a URL failed', { error: String(error?.message ?? error) })
  }
}
