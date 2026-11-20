// The plugin's own icon set, shared by every surface. Drawn on a 24-unit grid with the
// ink filling roughly 4.5-19.5, at one stroke weight, so glyphs fill their buttons and
// read as one family. Placeholders are `<i data-icon="name">`; this swaps them for SVG.
'use strict'

const DSH_ICONS = {
  // Tools
  square: '<rect x="5" y="5" width="14" height="14" rx="2.25"/>',
  circle: '<circle cx="12" cy="12" r="7.25"/>',
  arrow: '<path d="M6 18 17.25 6.75"/><path d="M10.25 6.25h7.5v7.5"/>',
  line: '<path d="M6 18 18 6"/>',
  pen: '<path d="M15.6 5.15a1.9 1.9 0 0 1 2.7 2.7L8.6 17.55 5 18.75l1.2-3.6z"/><path d="M14 6.75l3 3"/>',
  text: '<path d="M6 6.5h12"/><path d="M12 6.5v11.5"/><path d="M9.75 18h4.5"/>',
  number: '<circle cx="12" cy="12" r="7.25"/><path d="M10.25 9.6 12.4 8.1v7.9"/>',
  // A 2x2 checkerboard: the outline, the centre cross, and two diagonal quadrants filled.
  blur: '<rect x="5" y="5" width="14" height="14" rx="2.25"/><path d="M12 5v14M5 12h14"/><path d="M7.25 5H12v7H5V7.25A2.25 2.25 0 0 1 7.25 5z" fill="currentColor" stroke="none"/><path d="M12 12h7v4.75A2.25 2.25 0 0 1 16.75 19H12z" fill="currentColor" stroke="none"/>',
  fill: '<rect x="5" y="5" width="14" height="14" rx="2.25"/><rect x="7.75" y="7.75" width="8.5" height="8.5" rx="1" fill="currentColor" stroke="none"/>',
  // Actions
  pin: '<path d="M9.25 4.75h5.5"/><path d="M10.25 4.75v4.9L7.75 13.5h8.5l-2.5-3.85v-4.9"/><path d="M12 13.5v5.75"/>',
  undo: '<path d="M9 14 4.75 9.75 9 5.5"/><path d="M4.75 9.75h9.25a5 5 0 0 1 0 10H11.5"/>',
  redo: '<path d="M15 14l4.25-4.25L15 5.5"/><path d="M19.25 9.75H10a5 5 0 0 0 0 10h2.5"/>',
  copy: '<rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2"/><path d="M15.25 8.75V6.75a2 2 0 0 0-2-2h-6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h2"/>',
  save: '<path d="M12 4.75v10"/><path d="M7.75 10.75 12 15l4.25-4.25"/><path d="M5.25 19.25h13.5"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  check: '<path d="M5.5 12.75 9.75 17 18.5 7.5"/>',
  // AI
  ocr: '<path d="M5 8.75V7a2 2 0 0 1 2-2h1.75M15.25 5H17a2 2 0 0 1 2 2v1.75M19 15.25V17a2 2 0 0 1-2 2h-1.75M8.75 19H7a2 2 0 0 1-2-2v-1.75"/><path d="M8.75 9.75h6.5M8.75 12.25h6.5M8.75 14.75h4"/>',
  translate: '<path d="M4.75 6.75h7.5"/><path d="M8.5 5.25v1.5c0 2.85-1.5 5.1-3.75 6.5"/><path d="M6.6 9.5c1 2 2.7 3.45 4.75 4.2"/><path d="M12.75 19.25 16 11.5l3.25 7.75M13.9 16.6h4.2"/>',
  explain: '<path d="M9.5 17.25h5M10.25 19.75h3.5"/><path d="M9 14.6a5.1 5.1 0 1 1 6 0c-.55.4-.75.95-.75 1.6v.55h-4.5v-.55c0-.65-.2-1.2-.75-1.6z"/>',
  ask: '<path d="M5.25 7a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-3.75 3v-3H7.25a2 2 0 0 1-2-2z"/><path d="M9.25 10.5h.01M12 10.5h.01M14.75 10.5h.01" stroke-width="2.4"/>',
  // Pin and answer panels
  fade: '<circle cx="12" cy="12" r="7.25"/><path d="M12 4.75a7.25 7.25 0 0 1 0 14.5z" fill="currentColor" stroke="none"/>',
  send: '<path d="M5.5 12h12.25M13 7l5 5-5 5"/>',
  up: '<path d="M12 18.5V5.75M6.5 11.25 12 5.75l5.5 5.5"/>',
  again: '<path d="M18.75 5.5v4.25H14.5"/><path d="M18.5 9.5A7 7 0 1 0 19 14"/>',
}

/** Replace every `<i data-icon>` under `root` with its SVG. */
function renderIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const body = DSH_ICONS[el.dataset.icon]
    if (!body) continue
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = body
    el.replaceWith(svg)
  }
}
renderIcons()
