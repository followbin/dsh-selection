// The magnifier shown while picking a region: the backing pixels around the pointer,
// enlarged without smoothing on a pixel grid, the pointer's pixel marked, and a panel
// under it with the position, the colour, and the keys that act on them.
//
// It is built from layers in the overlay window itself, reading the same frozen frame the
// window already shows, so nothing is copied and it moves in the same transaction as the
// pointer. The web view could not draw it: it never holds the whole frozen screen.

/** Backing pixels across; odd, so the pointer's pixel is the centre one. */
const CELLS = 19
/** Points per enlarged pixel. */
const CELL = 8
const MAG = CELLS * CELL
const LINE = 18
const PANEL = 4 * LINE + 10
const CARD_H = MAG + PANEL
/** Gap between the pointer and the card, and between the card and the screen edge. */
const OFFSET = 20
const EDGE = 4
const RADIUS = 6
const COPIED_MS = 1200

/** The copy shortcut as each platform writes it. */
const COPY_KEYS = process.platform === 'darwin' ? '⌘+C' : 'Ctrl+C'
const STRINGS = {
  zh: { position: '坐标：', copyHint: `按 ${COPY_KEYS} 复制颜色值`, formatHint: '按 Shift 切换 RGB/HEX', copied: '已复制 ' },
  en: { position: 'Position: ', copyHint: `${COPY_KEYS}  copy the colour`, formatHint: 'Shift  RGB / HEX', copied: 'Copied ' },
}

const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
/** The colour as text in a format: what is shown and what the copy shortcut copies. */
export const colourText = (rgb, format) => (format === 'hex' ? hex(rgb) : rgb.join(', '))

/**
 * @param {{ native: any, window: any, locale: () => string, format: () => 'rgb' | 'hex' }} options
 */
export function createLoupe({ native, window: hosted, locale, format }) {
  const { createLayer, createTextLayer, createGridLayer, color, instantly } = native
  const root = hosted.rootLayer()

  // The shell carries the shadow; the clip rounds and crops. One layer cannot do both,
  // because cropping also crops its own shadow.
  const shell = createLayer(), clip = createLayer()
  const mag = createLayer(), pixels = createLayer()
  const grid = createGridLayer({ count: CELLS, cell: CELL, ink: color(0.5, 0.5, 0.5, 0.28), width: 0.5 })
  const bandH = createLayer(), bandV = createLayer()
  const centreOuter = createLayer(), centreInner = createLayer()
  const panel = createLayer(), swatch = createLayer(), ring = createLayer()
  let lines = null
  let frame = null
  let shown = false
  let last = ''
  let rgb = [0, 0, 0]
  let copiedUntil = 0
  let copiedText = ''

  const c = (CELLS - 1) / 2
  instantly(() => {
    shell.z(1000)
    shell.shadow({ radius: 12, opacity: 0.38, offsetY: 4 })
    clip.radius(RADIUS); clip.clip(true)
    clip.frame({ x: 0, y: 0, width: MAG, height: CARD_H })
    // Beyond the screen's edge the magnifier shows this, not stretched edge pixels.
    mag.background(color(0.12, 0.12, 0.13, 1))
    mag.frame({ x: 0, y: PANEL, width: MAG, height: MAG })
    pixels.nearest()
    grid.frame({ x: 0, y: 0, width: MAG, height: MAG })
    const blue = color(0.29, 0.58, 1, 0.78)
    bandH.background(blue); bandV.background(blue)
    bandH.frame({ x: 0, y: c * CELL, width: MAG, height: CELL })
    bandV.frame({ x: c * CELL, y: 0, width: CELL, height: MAG })
    centreOuter.border(1, color(0, 0, 0, 0.9))
    centreOuter.frame({ x: c * CELL - 1, y: c * CELL - 1, width: CELL + 2, height: CELL + 2 })
    centreInner.border(1, color(1, 1, 1, 1))
    centreInner.frame({ x: c * CELL, y: c * CELL, width: CELL, height: CELL })
    for (const l of [pixels, grid, bandH, bandV, centreOuter, centreInner]) mag.add(l)
    panel.background(color(0.17, 0.17, 0.18, 0.95))
    panel.frame({ x: 0, y: 0, width: MAG, height: PANEL })
    swatch.radius(2); swatch.border(1, color(1, 1, 1, 0.8))
    panel.add(swatch)
    clip.add(mag); clip.add(panel)
    // An edge drawn over everything, so light content does not bleed into the background.
    ring.radius(RADIUS); ring.border(0.5, color(0, 0, 0, 0.45))
    ring.frame({ x: 0, y: 0, width: MAG, height: CARD_H })
    clip.add(ring)
    shell.add(clip)
    shell.hidden(true)
    root.add(shell)
  })

  function ensureLines(scale) {
    if (lines) return
    lines = [0, 1, 2, 3].map((i) => {
      const t = createTextLayer({ size: 12, align: 'left', scale })
      t.ink(color(1, 1, 1, i >= 2 ? 0.78 : 0.97))
      panel.add(t)
      return t
    })
  }

  function render(p) {
    const s = STRINGS[locale()] ?? STRINGS.en
    const copying = Date.now() < copiedUntil
    lines[0].text(`${s.position}${Math.round(p.x)}, ${Math.round(p.y)}`)
    lines[1].text(colourText(rgb, format()))
    lines[2].text(copying ? s.copied + copiedText : s.copyHint)
    lines[3].text(s.formatHint)
    // Layer coordinates have their origin at the bottom-left: line 0 is the top one.
    lines.forEach((t, i) => {
      const x = i === 1 ? 26 : 10
      t.frame({ x, y: PANEL - 6 - (i + 1) * LINE + 2, width: MAG - x - 6, height: LINE })
    })
    swatch.background(color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1))
    swatch.frame({ x: 10, y: PANEL - 6 - 2 * LINE + 5, width: 11, height: 11 })
  }

  let lastPoint = null
  let lastDisplay = null

  return {
    /** The frozen frame to magnify; null when the overlay hides. */
    setFrame(f) { frame = f; last = '' },
    get visible() { return shown },
    /** The colour under the pointer, as [r, g, b]. */
    get colour() { return rgb },

    /**
     * Place the magnifier for a pointer position in this display's points (top-left origin).
     * @param {{ x: number, y: number }} p
     * @param {{ width: number, height: number }} display
     */
    update(p, display) {
      if (!frame) return
      const scale = frame.scale
      const cx = Math.floor(p.x * scale), cy = Math.floor(p.y * scale)
      const key = `${cx},${cy},${format()},${Date.now() < copiedUntil}`
      lastPoint = p; lastDisplay = display
      if (key === last && shown) return
      last = key
      const sx0 = cx - c, sy0 = cy - c
      // Only the part of that square that lies on the screen is sampled; the rest of the
      // magnifier stays empty instead of repeating the edge pixels.
      const vx0 = Math.max(0, sx0), vy0 = Math.max(0, sy0)
      const vx1 = Math.min(frame.width, sx0 + CELLS), vy1 = Math.min(frame.height, sy0 + CELLS)
      const vw = Math.max(0, vx1 - vx0), vh = Math.max(0, vy1 - vy0)
      rgb = native.pixelAt(frame, Math.min(Math.max(cx, 0), frame.width - 1), Math.min(Math.max(cy, 0), frame.height - 1)) ?? [0, 0, 0]
      ensureLines(scale)

      // Below-right of the pointer, flipping to the other side of an edge.
      let bx = p.x + OFFSET
      if (bx + MAG > display.width - EDGE) bx = p.x - OFFSET - MAG
      bx = Math.min(Math.max(bx, EDGE), display.width - MAG - EDGE)
      let by = p.y + OFFSET
      if (by + CARD_H > display.height - EDGE) by = p.y - OFFSET - CARD_H
      by = Math.min(Math.max(by, EDGE), display.height - CARD_H - EDGE)

      const viewH = hosted.contentHeight()
      instantly(() => {
        if (!shown) { shell.hidden(false); shown = true }
        shell.frame({ x: bx, y: viewH - by - CARD_H, width: MAG, height: CARD_H })
        if (vw > 0 && vh > 0) {
          pixels.hidden(false)
          pixels.contents(frame.handle)
          // contentsRect is in unit coordinates of the image, y measured from the bottom.
          pixels.contentsRect({ x: vx0 / frame.width, y: 1 - vy1 / frame.height, width: vw / frame.width, height: vh / frame.height })
          const left = (vx0 - sx0) * CELL, top = (vy0 - sy0) * CELL
          pixels.frame({ x: left, y: MAG - top - vh * CELL, width: vw * CELL, height: vh * CELL })
        } else {
          pixels.hidden(true)
        }
        render(p)
      })
    },

    /** Note that the colour was copied; the panel says so for a moment. */
    copied(text) {
      copiedText = text
      copiedUntil = Date.now() + COPIED_MS
      if (lastPoint) { last = ''; this.update(lastPoint, lastDisplay) }
      setTimeout(() => { if (lastPoint && shown) { last = ''; this.update(lastPoint, lastDisplay) } }, COPIED_MS + 20)
    },

    /** Redraw at the same position, after the format changed. */
    refresh() { if (lastPoint && shown) { last = ''; this.update(lastPoint, lastDisplay) } },

    hide() {
      if (!shown) return
      instantly(() => shell.hidden(true))
      shown = false
      last = ''
    },

    dispose() {
      instantly(() => shell.remove())
    },
  }
}
