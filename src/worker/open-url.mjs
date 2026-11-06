// Opens a URL with the system handler. Only web links and DSH's own scheme are accepted, because the
// URL can come from model output or from a page the user selected text in.
import { openWithSystem } from '../shared/open-with-system.mjs'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'dsh:'])

/** The URL to hand to the system, or null when it must not be opened. */
export function openableUrl(url) {
  try {
    const parsed = new URL(url)
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

export function openUrl(url, log) {
  const href = openableUrl(url)
  if (href) openWithSystem(href, log)
}
