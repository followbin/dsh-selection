// One capture, from hotkey to result. Owns the frozen frames for its lifetime and is the
// only thing that releases them, so a cancelled or failed capture cannot leak a CGImage.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCKED } from '../shared/protocol.mjs'

/** Base64 payload of a `data:image/png;base64,...` URL, or null. */
function pngFromDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
  return match ? Buffer.from(match[1], 'base64') : null
}

/**
 * @param {{
 *   native: any,
 *   overlay: any,
 *   tracker: any,
 *   dataDir: string,
 *   onActive?: (active: boolean) => void,
 *   log: (level: string, message: string, fields?: object) => void,
 *   onResult: (result: object) => void,
 *   onBlocked: (reason: string) => void,
 * }} options
 */
export function createCaptureSession({ native, overlay, tracker, dataDir, log, onResult, onBlocked, onActive = () => {} }) {
  const tmpDir = join(dataDir, 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  /** @type {{ frames: Map<number, any>, startedAt: bigint, round: number } | null} */
  let active = null
  let cropSeq = 0

  function releaseFrames() {
    if (!active) return
    for (const frame of active.frames.values()) native.releaseFrame(frame)
    active.frames.clear()
  }

  function finish(reason) {
    if (!active) return
    overlay.hide(reason)
    releaseFrames()
    active = null
    onActive(false)
  }

  return {
    get busy() { return active !== null },

    /** Freeze every display and raise the overlay. */
    begin() {
      if (active) { onBlocked(BLOCKED.BUSY); return false }
      if (native.screenPermission() !== 'granted') { onBlocked(BLOCKED.NO_PERMISSION); return false }
      if (native.displaysAsleep?.()) { onBlocked(BLOCKED.ASLEEP); return false }

      // A display may have changed without a settled notification, or inside the settle
      // window; placing the overlay on stale bounds would miss a screen entirely.
      if (tracker.refresh()) overlay.retopology(tracker.displays)
      const displays = tracker.displays
      if (displays.length === 0) { onBlocked(BLOCKED.NO_DISPLAY); return false }

      const startedAt = process.hrtime.bigint()
      const activeDisplay = tracker.activeDisplay()
      // The display under the pointer is the only one the user is looking at when the
      // hotkey fires, so it is frozen first and the rest follow in the same tick.
      const ordered = activeDisplay
        ? [activeDisplay, ...displays.filter((d) => d.id !== activeDisplay.id)]
        : displays
      const frames = new Map()
      for (const display of ordered) {
        const frame = native.captureDisplay(display)
        if (frame) frames.set(display.id, frame)
        else log('warn', 'display capture returned nothing', { display: display.id })
      }
      if (frames.size === 0) {
        for (const f of frames.values()) native.releaseFrame(f)
        onBlocked(BLOCKED.NO_DISPLAY)
        return false
      }
      active = { frames, startedAt, round: 0 }
      active.round = overlay.show({ frames, keyDisplay: activeDisplay?.id ?? displays[0].id })
      onActive(true)
      log('info', 'capture began', {
        displays: frames.size,
        grabMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      })
      return true
    },

    /** Route one message from an overlay page. */
    handle(displayId, message) {
      if (!active) return
      switch (message?.type) {
        case 'shortcut-ignored':
          log('info', 'ignored a shortcut with no physical modifier', { display: displayId, key: message.key, meta: message.meta, ctrl: message.ctrl, sincePickMs: message.sincePickMs })
          return

        case 'crop-ok':
          log('info', 'crop delivered', { display: displayId, size: `${message.w}x${message.h}`, via: message.via })
          return

        case 'crop-failed':
          log('error', 'crop could not be loaded by the page', { display: displayId, via: message.via })
          return

        case 'painted':
          if (message.round === active.round) {
            log('info', 'overlay painted', {
              totalMs: Number(process.hrtime.bigint() - active.startedAt) / 1e6,
            })
          }
          return

        case 'pick': {
          const frame = overlay.frameOf(displayId)
          const display = overlay.displayOf(displayId)
          if (!frame || !display || !message.rect) return
          // The page reports the region in its own CSS pixels, which are this display's
          // logical points; the crop is cut from the frame at backing resolution.
          const path = join(tmpDir, `crop-${process.pid}-${cropSeq++}.png`)
          try {
            native.writeCropPng(frame, {
              x: message.rect.x, y: message.rect.y,
              width: message.rect.width, height: message.rect.height,
            }, path)
            overlay.sendCrop(displayId, readFileSync(path), frame.scale, Number.isInteger(message.seq) ? message.seq : null)
          } catch (error) {
            log('error', 'crop failed', { display: displayId, error: String(error?.message ?? error) })
          } finally {
            rmSync(path, { force: true })
          }
          return
        }

        case 'cancel':
          log('info', 'capture cancelled by the page')
          finish('page cancelled')
          onResult({ kind: 'cancelled' })
          return

        case 'copy':
        case 'save':
        case 'pin':
        case 'done':
        case 'ai': {
          const png = pngFromDataUrl(message.image)
          if (!png) {
            log('error', 'overlay sent an unreadable image', { kind: message.type })
            finish('unreadable image')
            onResult({ kind: 'failed', reason: 'bad-image' })
            return
          }
          // The page measures the region in its own display's points, origin at that
          // display's top-left. Anything placed from here on (a pin, an answer panel) is a
          // window in global coordinates, so the display's origin is added; without it a
          // region on a display above or left of the main one opened on the main one.
          const display = overlay.displayOf(displayId)
          const rect = message.rect && display
            ? { ...message.rect, x: message.rect.x + display.x, y: message.rect.y + display.y }
            : (message.rect ?? null)
          const prompt = typeof message.prompt === 'string' ? message.prompt : ''
          log('info', 'terminal action from page', { action: message.type, display: displayId, cause: message.cause ?? null })
          // 'pin' keeps nothing of this capture here: the host owns the pinned window, so
          // the session still ends and its frames are released.
          finish(message.type)
          onResult({
            kind: message.type,
            png,
            rect,
            prompt,
            action: typeof message.action === 'string' ? message.action : null,
            shapes: Number.isInteger(message.shapes) ? message.shapes : 0,
          })
          return
        }

        default:
          return
      }
    },

    /** Drop a capture that is still on screen (shutdown, topology change, Host asked). */
    abort(reason = 'aborted') {
      if (!active) return
      log('info', 'capture aborted', { reason })
      finish(`aborted: ${reason}`)
      onResult({ kind: 'cancelled' })
    },

    dispose() {
      finish('disposed')
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
