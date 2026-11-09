// The toolbar page as one HTML string: the web view loads it with no file or network access.
// Kept apart from overlay.mjs, which loads the native web view, so tests can load the same page.
import { readFileSync } from 'node:fs'
import { ICONS, brandIcon } from '../shared/icons.mjs'

/** Inlines the page's stylesheet, scripts and icon table. */
export function pageHtml() {
  const read = (name) => readFileSync(new URL(`../../ui/${name}`, import.meta.url), 'utf8')
  return read('toolbar.html')
    .replace('<link rel="stylesheet" href="toolbar.css">', () => `<style>${read('toolbar.css')}</style>`)
    .replace('<script src="icons.js"></script>', () => `<script>window.DSH_ICONS = ${JSON.stringify(ICONS)}; window.DSH_BRAND = ${JSON.stringify(brandIcon('brand', '5 5 26 26'))}</script>`)
    .replace('<script src="markdown.js"></script>', () => `<script>${read('markdown.js')}</script>`)
    .replace('<script src="toolbar.js"></script>', () => `<script>${read('toolbar.js')}</script>`)
}
