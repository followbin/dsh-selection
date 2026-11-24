// Windows native layer: the same operations darwin.mjs provides, through koffi into user32,
// gdi32, shcore, dwmapi and advapi32, so nothing is compiled or signed separately.
//
// What differs from macOS:
//   - No native layers. macOS draws the frozen frame, the magnifier, a pin's image and its
//     size badge on a window's own CALayer; here `nativeLayers` is false and the pages draw
//     those from images served over each window's protocol (`frameBmp`, `pngSize`).
//   - Coordinates. Each monitor's logical rectangle is its physical rectangle divided by its
//     own scale, so a page's CSS pixels are that monitor's logical units, as on macOS. A
//     logical point maps back to physical pixels through the monitor whose logical rectangle
//     contains it; mixed-DPI layouts leave small gaps between monitors in logical space.
//   - The windows are the toolkit's own (wry/tao with WebView2); this module only adjusts
//     them through their HWND: topmost, no taskbar button, rounded corners, foreground.
//   - Capture is GDI BitBlt per monitor, which needs no permission on Windows.
import { writeFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { koffi } from './koffi.mjs'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')
const shcore = koffi.load('shcore.dll')
const dwmapi = koffi.load('dwmapi.dll')
const advapi32 = koffi.load('advapi32.dll')

// Handles travel as pointer-sized integers: the toolkit hands out HWNDs as BigInt, and
// HWND_TOPMOST and HKEY_CURRENT_USER are small negative values, not addresses.
const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' })
const MONITORINFOEXW = koffi.struct('MONITORINFOEXW', {
  cbSize: 'uint32_t', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32_t', szDevice: koffi.array('char16_t', 32, 'String'),
})
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
  biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t',
  biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32_t', 3) })
const MonitorEnumProc = koffi.proto('bool __stdcall MonitorEnumProc(intptr_t monitor, intptr_t hdc, RECT *rect, intptr_t data)')
const WndProc = koffi.proto('intptr_t __stdcall WndProc(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
  cbSize: 'uint32_t', style: 'uint32_t', lpfnWndProc: koffi.pointer(WndProc), cbClsExtra: 'int32_t', cbWndExtra: 'int32_t',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
})

const setDpiContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t context)')
const enumMonitors = user32.func('bool __stdcall EnumDisplayMonitors(intptr_t hdc, RECT *clip, MonitorEnumProc *proc, intptr_t data)')
const getMonitorInfo = user32.func('bool __stdcall GetMonitorInfoW(intptr_t monitor, _Inout_ MONITORINFOEXW *info)')
const getDpiForMonitor = shcore.func('int32_t __stdcall GetDpiForMonitor(intptr_t monitor, int32_t type, void *x, void *y)')
const getCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *point)')
const getAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int32_t key)')
const getSystemMetrics = user32.func('int32_t __stdcall GetSystemMetrics(int32_t index)')
const getDC = user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)')
const releaseDC = user32.func('int32_t __stdcall ReleaseDC(intptr_t hwnd, intptr_t hdc)')
const createCompatibleDC = gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)')
const createCompatibleBitmap = gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int32_t width, int32_t height)')
const selectObject = gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t object)')
const bitBlt = gdi32.func('bool __stdcall BitBlt(intptr_t dst, int32_t x, int32_t y, int32_t cx, int32_t cy, intptr_t src, int32_t x1, int32_t y1, uint32_t rop)')
// `bits` is a Node Buffer passed as plain memory, so 30+ MB of pixels land in it directly.
const getDIBits = gdi32.func('int32_t __stdcall GetDIBits(intptr_t hdc, intptr_t bitmap, uint32_t start, uint32_t lines, void *bits, _Inout_ BITMAPINFO *info, uint32_t usage)')
const deleteObject = gdi32.func('bool __stdcall DeleteObject(intptr_t object)')
const deleteDC = gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)')
const getModuleHandle = kernel32.func('intptr_t __stdcall GetModuleHandleW(str16 name)')
const getLastError = kernel32.func('uint32_t __stdcall GetLastError(void)')
const getCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId(void)')
const registerClass = user32.func('uint16_t __stdcall RegisterClassExW(WNDCLASSEXW *wc)')
const createWindow = user32.func('intptr_t __stdcall CreateWindowExW(uint32_t exStyle, str16 className, str16 title, uint32_t style, int32_t x, int32_t y, int32_t w, int32_t h, intptr_t parent, intptr_t menu, intptr_t instance, intptr_t param)')
const defWindowProc = user32.func('intptr_t __stdcall DefWindowProcW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
const registerHotKeyW = user32.func('bool __stdcall RegisterHotKey(intptr_t hwnd, int32_t id, uint32_t mods, uint32_t vk)')
const unregisterHotKeyW = user32.func('bool __stdcall UnregisterHotKey(intptr_t hwnd, int32_t id)')
const setWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int32_t x, int32_t y, int32_t cx, int32_t cy, uint32_t flags)')
const showWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int32_t cmd)')
const getWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)')
const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)')
const getWindowLong = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int32_t index)')
const setWindowLong = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int32_t index, intptr_t value)')
const setLayeredAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(intptr_t hwnd, uint32_t key, uint8_t alpha, uint32_t flags)')
const getForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow(void)')
const getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, intptr_t pid)')
const attachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t attach, uint32_t to, bool on)')
const setForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)')
const bringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)')
const setFocus = user32.func('intptr_t __stdcall SetFocus(intptr_t hwnd)')
const dwmSetAttribute = dwmapi.func('int32_t __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attribute, void *value, uint32_t size)')
const regGetValue = advapi32.func('int32_t __stdcall RegGetValueW(intptr_t key, str16 subKey, str16 value, uint32_t flags, intptr_t type, void *data, void *size)')

const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
const MONITORINFOF_PRIMARY = 1
const SM_SWAPBUTTON = 23
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const SRCCOPY = 0x00cc0020
const CAPTUREBLT = 0x40000000
const HWND_TOP = 0
const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
const SWP_NOSIZE = 0x1
const SWP_NOMOVE = 0x2
const SWP_NOZORDER = 0x4
const SWP_NOACTIVATE = 0x10
const SWP_SHOWWINDOW = 0x40
const SW_HIDE = 0
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_LAYERED = 0x80000
const WS_POPUP = 0x80000000
const LWA_ALPHA = 0x2
const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_DONOTROUND = 1
const DWMWCP_ROUND = 2
const DWMWCP_ROUNDSMALL = 3
const WM_DISPLAYCHANGE = 0x007e
const WM_SETTINGCHANGE = 0x001a
const WM_DPICHANGED = 0x02e0
const WM_HOTKEY = 0x0312
const MOD = { Alt: 0x1, Control: 0x2, Shift: 0x4, Meta: 0x8 }
const MOD_NOREPEAT = 0x4000
const ERROR_HOTKEY_ALREADY_REGISTERED = 1409
/** HKEY_CURRENT_USER is (HKEY)(LONG)0x80000001, sign-extended on 64-bit. */
const HKEY_CURRENT_USER = -2147483647
const RRF_RT_REG_DWORD = 0x10

// Every coordinate below assumes per-monitor DPI awareness: without it Windows scales and
// lies about positions on any monitor that is not at 100%. The toolkit asks for the same
// context when it starts; whichever call comes first wins, and both ask for V2.
try { setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } catch { /* pre-1703 Windows: the toolkit's own setting stands */ }

export const platform = 'win32'
/** Windows windows have no CALayer: pages draw the frame, magnifier, pin image and badge. */
export const nativeLayers = false

/**
 * A URL a window's page can load from that window's own custom protocol. WebView2 cannot
 * register a scheme of its own, so wry serves `scheme://host/path` at `http://scheme.host/path`.
 * @param {string} scheme
 * @param {string} hostAndPath e.g. "crop/c1".
 */
export function protocolUrl(scheme, hostAndPath) {
  return `http://${scheme}.${hostAndPath}`
}

// --- displays ----------------------------------------------------------------

/** @type {{ id: number, physical: { x: number, y: number, width: number, height: number }, scale: number, primary: boolean }[]} */
let monitors = []

function readMonitors() {
  const found = []
  enumMonitors(0, null, (monitor) => {
    const empty = { left: 0, top: 0, right: 0, bottom: 0 }
    const info = { cbSize: koffi.sizeof(MONITORINFOEXW), rcMonitor: { ...empty }, rcWork: { ...empty }, dwFlags: 0, szDevice: '' }
    if (!getMonitorInfo(monitor, info)) return true
    const dpiX = new Uint32Array([96])
    const dpiY = new Uint32Array([96])
    const scale = getDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, dpiX, dpiY) === 0 && dpiX[0] > 0 ? dpiX[0] / 96 : 1
    const r = info.rcMonitor
    const number = Number(/(\d+)\s*$/.exec(String(info.szDevice ?? ''))?.[1])
    found.push({
      id: Number.isFinite(number) && number > 0 ? number : found.length + 1,
      physical: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top },
      scale,
      primary: Boolean(info.dwFlags & MONITORINFOF_PRIMARY),
    })
    return true
  }, 0)
  monitors = found
  return found
}

const logicalOf = (m) => ({
  x: m.physical.x / m.scale, y: m.physical.y / m.scale,
  width: m.physical.width / m.scale, height: m.physical.height / m.scale,
})

/** Every monitor in top-left logical coordinates, with its scale. */
export function listDisplays() {
  return readMonitors().map((m) => ({ id: m.id, ...logicalOf(m), scale: m.scale, main: m.primary }))
}

/** Windows keeps capturing a monitor that is asleep, and there is nothing to refuse. */
export function displaysAsleep() { return false }

function monitorAtPhysical(px, py) {
  const list = monitors.length ? monitors : readMonitors()
  return list.find((m) => px >= m.physical.x && px < m.physical.x + m.physical.width && py >= m.physical.y && py < m.physical.y + m.physical.height)
    ?? list.find((m) => m.primary) ?? list[0]
}

function monitorAtLogical(x, y) {
  const list = monitors.length ? monitors : readMonitors()
  const inside = list.find((m) => {
    const l = logicalOf(m)
    return x >= l.x && x < l.x + l.width && y >= l.y && y < l.y + l.height
  })
  if (inside) return inside
  // In a gap between monitors of different scales: the nearest monitor decides.
  let best = null
  let bestDistance = Infinity
  for (const m of list) {
    const l = logicalOf(m)
    const dx = Math.max(l.x - x, 0, x - (l.x + l.width))
    const dy = Math.max(l.y - y, 0, y - (l.y + l.height))
    const d = dx * dx + dy * dy
    if (d < bestDistance) { bestDistance = d; best = m }
  }
  return best
}

function toLogical(px, py) {
  const m = monitorAtPhysical(px, py)
  const s = m?.scale ?? 1
  return { x: px / s, y: py / s }
}

/** A logical rectangle in physical pixels, scaled by the monitor its top-left lands on. */
function toPhysicalRect(rect) {
  const m = monitorAtLogical(rect.x, rect.y)
  const s = m?.scale ?? 1
  return {
    x: Math.round(rect.x * s), y: Math.round(rect.y * s),
    width: Math.max(1, Math.round(rect.width * s)), height: Math.max(1, Math.round(rect.height * s)),
  }
}

/** Whether the primary mouse button is down, from input state (works over any window). */
export function leftButtonDown() {
  const swapped = getSystemMetrics(SM_SWAPBUTTON) !== 0
  return (getAsyncKeyState(swapped ? VK_RBUTTON : VK_LBUTTON) & 0x8000) !== 0
}

/** Pointer position in top-left logical coordinates, or null. */
export function cursorPoint() {
  const p = { x: 0, y: 0 }
  if (!getCursorPos(p)) return null
  return toLogical(p.x, p.y)
}

// --- message window: display changes and the global hot key ----------------------------
// One hidden top-level window: WM_DISPLAYCHANGE is broadcast only to top-level windows, and
// RegisterHotKey posts WM_HOTKEY to the window it names. The toolkit's event pump dispatches
// both on this thread, inside app.pumpEvents().

let messageWindow = 0
let wndProc = null
const hotkeys = new Map()
const displayListeners = new Set()
let hotkeySeq = 0

function ensureMessageWindow() {
  if (messageWindow) return messageWindow
  const instance = getModuleHandle(null)
  wndProc = koffi.register((hwnd, msg, wParam, lParam) => {
    if (msg === WM_HOTKEY) {
      const handler = hotkeys.get(Number(wParam))
      try { handler?.() } catch { /* the hot key owner logs its own failures */ }
      return 0
    }
    if (msg === WM_DISPLAYCHANGE || msg === WM_DPICHANGED || msg === WM_SETTINGCHANGE) {
      monitors = []
      for (const listener of displayListeners) {
        try { listener() } catch { /* a listener failing must not stop the others */ }
      }
    }
    return defWindowProc(hwnd, msg, wParam, lParam)
  }, koffi.pointer(WndProc))
  const className = 'DshShotMessages'
  registerClass({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: wndProc, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: instance, hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: className, hIconSm: 0,
  })
  messageWindow = createWindow(WS_EX_TOOLWINDOW, className, 'dsh-shot', WS_POPUP, 0, 0, 0, 0, 0, 0, instance, 0)
  if (!messageWindow) throw new Error(`CreateWindowExW failed (${getLastError()})`)
  return messageWindow
}

/**
 * Fire `onChange` when monitors are added, removed, rearranged or rescaled.
 * @param {() => void} onChange
 * @returns {() => void} disposer
 */
export function onDisplaysChanged(onChange) {
  ensureMessageWindow()
  displayListeners.add(onChange)
  return () => displayListeners.delete(onChange)
}

/**
 * Hold one global hot key until disposed (RegisterHotKey). Windows delivers the chord to
 * this process only, and refuses a chord another process already holds.
 * @param {{ code: number, modifiers: Iterable<string> }} chord virtual-key code and modifier names.
 * @param {() => void} onPress runs inside app.pumpEvents(); it must return quickly.
 * @returns {{ ok: true, dispose: () => void } | { ok: false, reason: 'taken' | 'failed', status: number }}
 */
export function registerHotkey(chord, onPress) {
  const hwnd = ensureMessageWindow()
  const mods = [...chord.modifiers].reduce((sum, name) => sum | (MOD[name] ?? 0), MOD_NOREPEAT)
  const id = ++hotkeySeq
  if (!registerHotKeyW(hwnd, id, mods, chord.code)) {
    const status = getLastError()
    return { ok: false, reason: status === ERROR_HOTKEY_ALREADY_REGISTERED || status === 0 ? 'taken' : 'failed', status }
  }
  hotkeys.set(id, onPress)
  let disposed = false
  return {
    ok: true,
    dispose() {
      if (disposed) return
      disposed = true
      unregisterHotKeyW(hwnd, id)
      hotkeys.delete(id)
    },
  }
}

// --- capture -----------------------------------------------------------------

/**
 * One frame of a monitor: top-down BGRA bytes at physical resolution.
 * @typedef {{ data: Buffer | null, width: number, height: number, scale: number }} Frame
 */

/**
 * Capture one monitor with GDI. CAPTUREBLT includes layered (translucent) windows.
 * @param {{ id: number, width: number }} display
 * @returns {Frame | null}
 */
export function captureDisplay(display) {
  const m = (monitors.length ? monitors : readMonitors()).find((entry) => entry.id === display.id)
  if (!m) return null
  const { x, y, width, height } = m.physical
  const screen = getDC(0)
  if (!screen) return null
  const memory = createCompatibleDC(screen)
  const bitmap = createCompatibleBitmap(screen, width, height)
  try {
    const previous = selectObject(memory, bitmap)
    const copied = bitBlt(memory, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT)
    selectObject(memory, previous)
    if (!copied) return null
    const data = Buffer.alloc(width * height * 4)
    const info = {
      bmiHeader: {
        biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
        biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
      },
      bmiColors: [0, 0, 0],
    }
    if (getDIBits(memory, bitmap, 0, height, data, info, 0 /* DIB_RGB_COLORS */) !== height) return null
    return { data, width, height, scale: display.width > 0 ? width / display.width : m.scale }
  } finally {
    deleteObject(bitmap)
    deleteDC(memory)
    releaseDC(0, screen)
  }
}

/** @param {Frame | null} frame */
export function releaseFrame(frame) {
  if (frame) frame.data = null
}

/**
 * Colour of one physical pixel of a frame as [r, g, b], or null outside it.
 * @param {Frame} frame
 * @param {number} px
 * @param {number} py
 */
export function pixelAt(frame, px, py) {
  if (!frame?.data || px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null
  const i = (Math.floor(py) * frame.width + Math.floor(px)) * 4
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]]
}

/**
 * The whole frame as an uncompressed 32-bit BMP, for a page to show as the frozen screen.
 * Encoding is a header and a copy; the page decodes it in a few tens of milliseconds.
 * @param {Frame} frame
 * @returns {Buffer}
 */
export function frameBmp(frame) {
  const size = frame.width * frame.height * 4
  const out = Buffer.alloc(54 + size)
  out.write('BM', 0, 'latin1')
  out.writeUInt32LE(54 + size, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(frame.width, 18)
  out.writeInt32LE(-frame.height, 22) // top-down rows
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(32, 28)
  out.writeUInt32LE(0, 30) // BI_RGB: the fourth byte is ignored
  out.writeUInt32LE(size, 34)
  out.writeInt32LE(2835, 38)
  out.writeInt32LE(2835, 42)
  frame.data.copy(out, 54)
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(bytes) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(bytes) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * Write a crop of one frame to a PNG file (8-bit RGB, no filtering).
 * @param {Frame} frame
 * @param {{ x: number, y: number, width: number, height: number }} rect logical, frame-relative.
 * @param {string} path
 * @returns {{ width: number, height: number }}
 */
export function writeCropPng(frame, rect, path) {
  if (!frame?.data) throw new Error('crop of a released frame')
  const s = frame.scale
  const x0 = Math.max(0, Math.min(frame.width - 1, Math.round(rect.x * s)))
  const y0 = Math.max(0, Math.min(frame.height - 1, Math.round(rect.y * s)))
  const width = Math.max(1, Math.min(frame.width - x0, Math.round(rect.width * s)))
  const height = Math.max(1, Math.min(frame.height - y0, Math.round(rect.height * s)))
  const raw = Buffer.alloc(height * (1 + width * 3))
  let o = 0
  for (let row = 0; row < height; row++) {
    raw[o++] = 0
    let i = ((y0 + row) * frame.width + x0) * 4
    for (let col = 0; col < width; col++, i += 4) {
      raw[o++] = frame.data[i + 2]
      raw[o++] = frame.data[i + 1]
      raw[o++] = frame.data[i]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(path, png)
  return { width, height }
}

/**
 * PNG dimensions from its header; pages draw the image itself on Windows.
 * @param {Uint8Array} bytes
 * @returns {{ handle: null, width: number, height: number, scale: number } | null}
 */
export function imageFromPng(bytes) {
  if (bytes.length < 24) return null
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { handle: null, width: view.readUInt32BE(16), height: view.readUInt32BE(20), scale: 1 }
}

// --- app behaviour -----------------------------------------------------------

/** Windows has no screen-capture consent gate. */
export function screenAccess() { return { state: 'granted', live: true } }
export function processCanCapture() { return true }
export function requestScreenPermission() { return true }

/** Apps light or dark, from AppsUseLightTheme. */
export function systemTheme() {
  const data = new Uint32Array([1])
  const size = new Uint32Array([4])
  const status = regGetValue(HKEY_CURRENT_USER, 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'AppsUseLightTheme', RRF_RT_REG_DWORD, 0, data, size)
  return status === 0 && data[0] === 0 ? 'dark' : 'light'
}

/** No Dock and no activation policy on Windows; each window opts out of the taskbar itself. */
export function preventAppActivation() {}
export function hideFromDock() {}
export function activateApp() {}

/** Logical global coordinates are already top-left on Windows. */
export function primaryHeight() { return 0 }

/** Above everything (topmost) or ordinary; Windows has no level between. */
export const LEVEL = { overlay: 2, float: 1, normal: 0 }

/** Bring a window to the foreground even when another app owns it, so it gets the keyboard. */
function forceForeground(hwnd) {
  const foreground = getForegroundWindow()
  const theirs = foreground ? getWindowThreadProcessId(foreground, 0) : 0
  const ours = getCurrentThreadId()
  const attach = theirs && theirs !== ours
  if (attach) attachThreadInput(ours, theirs, true)
  try {
    bringWindowToTop(hwnd)
    setForegroundWindow(hwnd)
    setFocus(hwnd)
  } finally {
    if (attach) attachThreadInput(ours, theirs, false)
  }
}

/**
 * Adjust one toolkit window: no taskbar button, topmost by level, placed in logical
 * coordinates. The object matches darwin.mjs's hosted window, minus the layer operations.
 * @param {{ bounds: object, taoWindow: any, level?: number, shadow?: boolean }} options
 */
export function createHostedWindow({ bounds, taoWindow, level = LEVEL.float, shadow = true }) {
  const hwnd = taoWindow.getNativeHandle()
  setWindowLong(hwnd, GWL_EXSTYLE, Number(getWindowLong(hwnd, GWL_EXSTYLE)) | WS_EX_TOOLWINDOW)
  try { taoWindow.setUndecoratedShadow?.(shadow) } catch { /* older toolkit: no undecorated shadow */ }
  let topmost = level > LEVEL.normal
  let alpha = 1
  let shown = false

  const place = (rect, flags = 0) => {
    const p = toPhysicalRect(rect)
    setWindowPos(hwnd, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, p.x, p.y, p.width, p.height, SWP_NOACTIVATE | flags)
  }
  place(bounds)

  const api = {
    rootLayer: () => null,
    contentHeight: () => api.bounds().height,
    /** Windows 11 rounds the window itself; earlier versions keep square corners. */
    setCornerRadius(r) {
      const preference = r <= 0 ? DWMWCP_DONOTROUND : r <= 5 ? DWMWCP_ROUNDSMALL : DWMWCP_ROUND
      try { dwmSetAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, new Uint32Array([preference]), 4) } catch { /* Windows 10 */ }
    },
    setFrameImage() {},
    setBounds(next) { place(next) },
    moveTopLeft(x, y) {
      const m = monitorAtLogical(x, y)
      const s = m?.scale ?? 1
      setWindowPos(hwnd, 0, Math.round(x * s), Math.round(y * s), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
    },
    show({ key = false } = {}) {
      setWindowPos(hwnd, topmost ? HWND_TOPMOST : HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | (key ? 0 : SWP_NOACTIVATE))
      if (key) forceForeground(hwnd)
      shown = true
    },
    hide() {
      showWindow(hwnd, SW_HIDE)
      shown = false
    },
    get visible() { return shown },
    invalidateShadow() {},
    /** Window-wide opacity through a layered window; 1 removes the layering again. */
    setAlpha(value) {
      const next = Math.max(0, Math.min(1, value))
      if (next === alpha) return
      alpha = next
      const style = Number(getWindowLong(hwnd, GWL_EXSTYLE))
      if (alpha >= 1) {
        setWindowLong(hwnd, GWL_EXSTYLE, style & ~WS_EX_LAYERED)
        return
      }
      setWindowLong(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED)
      setLayeredAttributes(hwnd, 0, Math.round(alpha * 255), LWA_ALPHA)
    },
    setLevel(next) {
      topmost = next > LEVEL.normal
      setWindowPos(hwnd, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    },
    /** Current frame in top-left logical coordinates. */
    bounds() {
      const r = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!getWindowRect(hwnd, r)) return { ...bounds }
      const m = monitorAtPhysical(r.left, r.top)
      const s = m?.scale ?? 1
      return { x: r.left / s, y: r.top / s, width: (r.right - r.left) / s, height: (r.bottom - r.top) / s }
    },
    dispose() {
      showWindow(hwnd, SW_HIDE)
      try { taoWindow.close() } catch { /* already closed */ }
    },
    inspect: () => ({ level: topmost ? LEVEL.float : LEVEL.normal, visible: isWindowVisible(hwnd), key: getForegroundWindow() === hwnd }),
  }
  return api
}

/**
 * The capture surface for one monitor: topmost, covering it exactly in physical pixels.
 * @param {{ bounds: object, taoWindow: any }} options
 */
export function createOverlayWindow({ bounds, taoWindow }) {
  const hosted = createHostedWindow({ bounds, taoWindow, level: LEVEL.overlay, shadow: false })
  hosted.setCornerRadius(0)
  return hosted
}
