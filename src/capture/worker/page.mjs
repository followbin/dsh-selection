// Pages as single HTML strings: each web view loads one with no file or network access.
import { readFileSync } from 'node:fs'

// The capture pages live in ui/capture; the Markdown renderer is the toolbar's own (ui/markdown.js).
const ui = (name) => readFileSync(new URL(name === 'markdown.js' ? `../../../ui/${name}` : `../../../ui/capture/${name}`, import.meta.url), 'utf8')

/**
 * Inline a page's stylesheet and script so it has no external references.
 * @param {'overlay' | 'pin' | 'answer'} name
 */
export function pageHtml(name) {
  return ui(`${name}.html`)
    .replace(`<link rel="stylesheet" href="${name}.css">`, () => `<style>${ui(`${name}.css`)}</style>`)
    .replace(/<script src="([\w-]+\.js)"><\/script>/g, (_, file) => `<script>${ui(file)}</script>`)
}
