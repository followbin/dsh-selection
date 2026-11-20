// macOS native layer: screen-recording access, display topology, frame capture,
// and the overlay window that pins a captured frame straight onto a CALayer.
// Everything goes through koffi, so nothing in this plugin is compiled or signed
// separately; it inherits DeepSeek Harness's own signature and TCC identity.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Loads koffi's platform package directly. The `koffi` meta package runs an install
 * script that DSH's pnpm refuses by default; the platform packages carry the same
 * native API with no script.
 */
function loadKoffi() {
  const name = `@koromix/koffi-${process.platform}-${process.arch}`
  try {
    return require(name)
  } catch (error) {
    throw new Error(`${name} is missing; reinstall the plugin for this platform (${error.message})`)
  }
}

const koffi = loadKoffi()
const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
const IIO = koffi.load('/System/Library/Frameworks/ImageIO.framework/ImageIO')
const objc = koffi.load('/usr/lib/libobjc.A.dylib')
koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')

const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })
const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' })
const CGRect = koffi.struct('CGRect', { origin: CGPoint, size: CGSize })

// --- CoreGraphics ------------------------------------------------------------
const cgPreflight = CG.func('bool CGPreflightScreenCaptureAccess(void)')
const cgRequest = CG.func('bool CGRequestScreenCaptureAccess(void)')
const cgActiveList = CG.func('int32_t CGGetActiveDisplayList(uint32_t max, _Out_ uint32_t *displays, _Out_ uint32_t *count)')
const cgOnlineList = CG.func('int32_t CGGetOnlineDisplayList(uint32_t max, _Out_ uint32_t *displays, _Out_ uint32_t *count)')
const cgDisplayBounds = CG.func('CGRect CGDisplayBounds(uint32_t display)')
const cgMainDisplay = CG.func('uint32_t CGMainDisplayID(void)')
const cgDisplayCreateImage = CG.func('void *CGDisplayCreateImage(uint32_t display)')
const cgImageCreateWithRect = CG.func('void *CGImageCreateWithImageInRect(void *image, CGRect rect)')
const cgImageRelease = CG.func('void CGImageRelease(void *image)')
const cgImageWidth = CG.func('unsigned long CGImageGetWidth(void *image)')
const cgImageHeight = CG.func('unsigned long CGImageGetHeight(void *image)')
const cgImageBytesPerRow = CG.func('unsigned long CGImageGetBytesPerRow(void *image)')
const cgImageBitmapInfo = CG.func('uint32_t CGImageGetBitmapInfo(void *image)')
const cgImageProvider = CG.func('void *CGImageGetDataProvider(void *image)')
const cgProviderCopyData = CG.func('void *CGDataProviderCopyData(void *provider)')
const cgColorSRGB = CG.func('void *CGColorCreateSRGB(double r, double g, double b, double a)')
const cgPathCreate = CG.func('void *CGPathCreateMutable(void)')
const cgPathMove = CG.func('void CGPathMoveToPoint(void *path, void *transform, double x, double y)')
const cgPathLine = CG.func('void CGPathAddLineToPoint(void *path, void *transform, double x, double y)')
const cgEventCreate = CG.func('void *CGEventCreate(void *source)')
const cgEventLocation = CG.func('CGPoint CGEventGetLocation(void *event)')
const cgDisplayIsAsleep = CG.func('bool CGDisplayIsAsleep(uint32_t display)')
const cgButtonState = CG.func('bool CGEventSourceButtonState(int32_t stateID, uint32_t button)')
const cgFlagsState = CG.func('uint64_t CGEventSourceFlagsState(int32_t stateID)')
const cgSecondsSince = CG.func('double CGEventSourceSecondsSinceLastEventType(int32_t stateID, uint32_t eventType)')

const ReconfigCb = koffi.proto('void ReconfigCb(uint32_t display, uint32_t flags, void *userInfo)')
const cgRegisterReconfig = CG.func('int32_t CGDisplayRegisterReconfigurationCallback(ReconfigCb *cb, void *userInfo)')
const cgRemoveReconfig = CG.func('int32_t CGDisplayRemoveReconfigurationCallback(ReconfigCb *cb, void *userInfo)')

// --- CoreFoundation / ImageIO ------------------------------------------------
const cfRelease = CF.func('void CFRelease(void *cf)')
const CFRange = koffi.struct('CFRange', { location: 'long', length: 'long' })
const cfDataGetBytes = CF.func('void CFDataGetBytes(void *data, CFRange range, _Out_ uint8_t *buffer)')
const cfDataCreate = CF.func('void *CFDataCreate(void *alloc, const uint8_t *bytes, long length)')
const cfStringFromC = CF.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t encoding)')
const cfUrlFromPath = CF.func('void *CFURLCreateFromFileSystemRepresentation(void *alloc, const char *path, long len, bool isDir)')
const destCreateWithUrl = IIO.func('void *CGImageDestinationCreateWithURL(void *url, void *type, unsigned long count, void *options)')
const destAdd = IIO.func('void CGImageDestinationAddImage(void *dst, void *image, void *properties)')
const destFinalize = IIO.func('bool CGImageDestinationFinalize(void *dst)')
const sourceCreateWithData = IIO.func('void *CGImageSourceCreateWithData(void *data, void *options)')
const sourceCreateImage = IIO.func('void *CGImageSourceCreateImageAtIndex(void *source, unsigned long index, void *options)')
const CT = koffi.load('/System/Library/Frameworks/CoreText.framework/CoreText')
const ctFontWithName = CT.func('void *CTFontCreateWithName(void *name, double size, void *matrix)')
const UTF8 = 0x08000100

// --- Objective-C -------------------------------------------------------------
const getClass = objc.func('void *objc_getClass(const char *name)')
const sel = objc.func('void *sel_registerName(const char *name)')
const classOf = objc.func('void *object_getClass(void *obj)')
const allocateClassPair = objc.func('void *objc_allocateClassPair(void *superclass, const char *name, size_t extraBytes)')
const registerClassPair = objc.func('void objc_registerClassPair(void *cls)')
const send = {
  id: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
  idIndex: objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'unsigned long']),
  initWin: objc.func('objc_msgSend', 'void *', ['void *', 'void *', CGRect, 'unsigned long', 'unsigned long', 'bool']),
  bool: objc.func('objc_msgSend', 'bool', ['void *', 'void *']),
  boolId: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']),
  boolLong: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'long']),
  ulong: objc.func('objc_msgSend', 'unsigned long', ['void *', 'void *']),
  long: objc.func('objc_msgSend', 'long', ['void *', 'void *']),
  void: objc.func('objc_msgSend', 'void', ['void *', 'void *']),
  voidId: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']),
  voidBool: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']),
  voidLong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']),
  voidUlong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'unsigned long']),
  voidDouble: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double']),
  rect: objc.func('objc_msgSend', CGRect, ['void *', 'void *']),
  voidRect: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGRect]),
  voidRectBool: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGRect, 'bool']),
  voidPoint: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGPoint]),
  voidSize: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGSize]),
  voidIdId: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'void *']),
  size: objc.func('objc_msgSend', CGSize, ['void *', 'void *']),
}
/** `-UTF8String` returns a C string owned by the receiver; koffi copies it out. */
const sendStr = objc.func('objc_msgSend', 'const char *', ['void *', 'void *'])
const S = (n) => sel(n)
const boolType = process.arch === 'arm64' ? 'B' : 'c'
const NoArgBool = koffi.proto('bool NoArgBool(void *self, void *cmd)')
const EventBool = koffi.proto('bool EventBool(void *self, void *cmd, void *event)')
const BoolArgVoid = koffi.proto('void BoolArgVoid(void *self, void *cmd, bool flag)')
const NoArgVoid = koffi.proto('void NoArgVoid(void *self, void *cmd)')
const ConstrainRect = koffi.proto('CGRect ConstrainRect(void *self, void *cmd, CGRect rect, void *screen)')
const replace = {
  noArgBool: objc.func('void *class_replaceMethod(void *cls, void *name, NoArgBool *imp, const char *types)'),
  eventBool: objc.func('void *class_replaceMethod(void *cls, void *name, EventBool *imp, const char *types)'),
  boolArgVoid: objc.func('void *class_replaceMethod(void *cls, void *name, BoolArgVoid *imp, const char *types)'),
  noArgVoid: objc.func('void *class_replaceMethod(void *cls, void *name, NoArgVoid *imp, const char *types)'),
  constrainRect: objc.func('void *class_replaceMethod(void *cls, void *name, ConstrainRect *imp, const char *types)'),
}
// Registered implementations must outlive every object that may call them.
const imps = {
  yes: koffi.register(() => true, koffi.pointer(NoArgBool)),
  yesEvent: koffi.register(() => true, koffi.pointer(EventBool)),
  noopFlag: koffi.register(() => {}, koffi.pointer(BoolArgVoid)),
  noop: koffi.register(() => {}, koffi.pointer(NoArgVoid)),
  unconstrained: koffi.register((_self, _cmd, rect) => rect, koffi.pointer(ConstrainRect)),
}

const nsApp = () => send.id(getClass('NSApplication'), S('sharedApplication'))

export const platform = 'darwin'
/** Windows here can hold layers: the frame, magnifier, pin image and badge are drawn natively. */
export const nativeLayers = true

/**
 * A URL a window's page can load from that window's own custom protocol.
 * @param {string} scheme
 * @param {string} hostAndPath e.g. "crop/c1".
 */
export function protocolUrl(scheme, hostAndPath) {
  return `${scheme}://${hostAndPath}`
}

// --- permission --------------------------------------------------------------

/**
 * Current screen-recording access.
 *
 * macOS answers this from a snapshot taken when the process started: a grant made
 * while this process is running is NOT observed here. The caller must re-exec (the
 * worker exits with RESTART_NOW) before a fresh grant becomes visible.
 * @returns {'granted' | 'denied'}
 */
export function screenPermission() {
  return cgPreflight() ? 'granted' : 'denied'
}

/**
 * Shows the system prompt once, if it has never been answered for this app.
 * Returns immediately; the grant only takes effect in a later process.
 * @returns {boolean} true when access was already present.
 */
export function requestScreenPermission() {
  return cgRequest()
}

// --- displays ----------------------------------------------------------------

/**
 * Every active display in top-left logical coordinates.
 * `scale` is left undefined here on purpose: CGDisplayPixelsWide reports the current
 * display *mode*, not the backing store, and disagrees with the captured image on
 * Retina panels. Real scale is derived from a captured frame in {@link captureDisplay}.
 * @returns {{ id: number, x: number, y: number, width: number, height: number, main: boolean }[]}
 */
export function listDisplays() {
  const ids = new Uint32Array(32)
  const count = new Uint32Array(1)
  if (cgActiveList(32, ids, count) !== 0) return []
  // A sleeping display is online but not active, and while every display sleeps the
  // active list is empty. Falling back to the online list keeps the topology known, so
  // the overlay windows already exist when the screen wakes instead of being built
  // during the hotkey. Capture still refuses: a sleeping display has nothing to capture.
  if (count[0] === 0 && cgOnlineList(32, ids, count) !== 0) return []
  const main = cgMainDisplay()
  const out = []
  for (let i = 0; i < count[0]; i++) {
    const id = ids[i]
    const b = cgDisplayBounds(id)
    out.push({ id, x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height, main: id === main })
  }
  return out
}

/**
 * True while every display is asleep. Capture is refused then: the frame a sleeping
 * display returns is not what the user believes is on screen.
 */
export function displaysAsleep() {
  const ids = new Uint32Array(32)
  const count = new Uint32Array(1)
  if (cgOnlineList(32, ids, count) !== 0 || count[0] === 0) return false
  for (let i = 0; i < count[0]; i++) if (!cgDisplayIsAsleep(ids[i])) return false
  return true
}

/**
 * Whether the left mouse button is down right now, read from the session's input state
 * rather than from events, so it is true even while the pointer is outside every window
 * of this process.
 */
export function leftButtonDown() {
  return cgButtonState(0 /* kCGEventSourceStateCombinedSessionState */, 0 /* kCGMouseButtonLeft */)
}

/** Pointer position in top-left logical screen coordinates, or null. */
export function cursorPoint() {
  const event = cgEventCreate(null)
  if (!event) return null
  const p = cgEventLocation(event)
  cfRelease(event)
  return { x: p.x, y: p.y }
}

const HID_STATE = 1 // kCGEventSourceStateHIDSystemState: keyboards and mice only
const LEFT_MOUSE_UP = 2 // kCGEventLeftMouseUp
const KEY_DOWN = 10 // kCGEventKeyDown
const FLAGS_CHANGED = 12 // kCGEventFlagsChanged
const MASK_COMMAND = 0x100000n
const MASK_CONTROL = 0x40000n
/** How long a modifier let go of still counts; a page's question arrives within a few tens of milliseconds. */
const RELEASE_GRACE_S = 0.3

/**
 * The Command and Control keys a person is pressing, read from the hardware state table, which
 * keystrokes posted by other processes never change. A modifier let go of within RELEASE_GRACE_S
 * still counts when a key was pressed on the keyboard in that time and after the last mouse
 * release, so a quick ⌘C is not lost on its way here, while the copy another app posts right
 * after a drag has no key press of its own behind it.
 * @returns {{ meta: boolean, ctrl: boolean }}
 */
export function heldModifiers() {
  const flags = BigInt(cgFlagsState(HID_STATE))
  const sinceKey = cgSecondsSince(HID_STATE, KEY_DOWN)
  const justTyped = sinceKey < RELEASE_GRACE_S
    && cgSecondsSince(HID_STATE, FLAGS_CHANGED) < RELEASE_GRACE_S
    && sinceKey < cgSecondsSince(HID_STATE, LEFT_MOUSE_UP)
  return { meta: justTyped || Boolean(flags & MASK_COMMAND), ctrl: justTyped || Boolean(flags & MASK_CONTROL) }
}

// --- Global hot key -----------------------------------------------------------
// Registered with the system (Carbon's hot key service, which needs no Accessibility grant),
// so the chord is delivered to this process only and the front app never sees it. Exclusive
// registration also tells us when another app already holds the chord exclusively.
const HI = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon')
const EventTypeSpec = koffi.struct('EventTypeSpec', { eventClass: 'uint32_t', eventKind: 'uint32_t' })
const EventHotKeyID = koffi.struct('EventHotKeyID', { signature: 'uint32_t', id: 'uint32_t' })
const HotKeyHandler = koffi.proto('int32_t HotKeyHandler(void *callRef, void *event, void *userData)')
const hiDispatcher = HI.func('void *GetEventDispatcherTarget(void)')
const hiInstallHandler = HI.func('int32_t InstallEventHandler(void *target, HotKeyHandler *handler, unsigned long count, EventTypeSpec *types, void *userData, _Out_ void **outRef)')
const hiRemoveHandler = HI.func('int32_t RemoveEventHandler(void *ref)')
const hiRegisterHotKey = HI.func('int32_t RegisterEventHotKey(uint32_t code, uint32_t mods, EventHotKeyID id, void *target, uint32_t options, _Out_ void **outRef)')
const hiUnregisterHotKey = HI.func('int32_t UnregisterEventHotKey(void *ref)')
const K_EVENT_CLASS_KEYBOARD = 0x6b657962 // 'keyb'
const K_EVENT_HOTKEY_PRESSED = 5
const K_EVENT_HOTKEY_EXCLUSIVE = 1
/** eventHotKeyExistsErr: another process holds the chord exclusively. */
const HOTKEY_TAKEN = -9878
const CARBON_MODIFIERS = { Meta: 0x100, Shift: 0x200, Alt: 0x800, Control: 0x1000 }

/**
 * Hold one global hot key until disposed.
 * @param {{ code: number, modifiers: Iterable<string> }} chord virtual key code (kVK_*) and
 *   modifier names (Meta, Shift, Alt, Control).
 * @param {() => void} onPress runs on the main thread inside the AppKit event loop, that is
 *   inside app.pumpEvents(); it must return quickly and must not touch the toolkit.
 * @returns {{ ok: true, dispose: () => void } | { ok: false, reason: 'taken' | 'failed', status: number }}
 */
export function registerHotkey(chord, onPress) {
  const mods = [...chord.modifiers].reduce((sum, name) => sum | (CARBON_MODIFIERS[name] ?? 0), 0)
  const callback = koffi.register(() => {
    try { onPress() } catch { /* the caller logs its own failures; the event loop must not unwind */ }
    return 0
  }, koffi.pointer(HotKeyHandler))
  const target = hiDispatcher()
  const handlerRef = [null]
  const installed = hiInstallHandler(target, callback, 1, [{ eventClass: K_EVENT_CLASS_KEYBOARD, eventKind: K_EVENT_HOTKEY_PRESSED }], null, handlerRef)
  if (installed !== 0) {
    koffi.unregister(callback)
    return { ok: false, reason: 'failed', status: installed }
  }
  const hotKeyRef = [null]
  const status = hiRegisterHotKey(chord.code, mods, { signature: 0x44534853, id: 1 }, target, K_EVENT_HOTKEY_EXCLUSIVE, hotKeyRef)
  if (status !== 0) {
    hiRemoveHandler(handlerRef[0])
    koffi.unregister(callback)
    return { ok: false, reason: status === HOTKEY_TAKEN ? 'taken' : 'failed', status }
  }
  let disposed = false
  return {
    ok: true,
    dispose() {
      if (disposed) return
      disposed = true
      hiUnregisterHotKey(hotKeyRef[0])
      hiRemoveHandler(handlerRef[0])
      koffi.unregister(callback)
    },
  }
}

/**
 * Subscribe to display add/remove/resize/rearrange.
 * The callback fires on the run loop this process pumps, after the change settled.
 * @param {() => void} onChange
 * @returns {() => void} disposer
 */
export function onDisplaysChanged(onChange) {
  // kCGDisplayBeginConfigurationFlag (1<<0) marks the *start* of a change; acting on it
  // would read a half-applied topology, so only the settled callbacks are forwarded.
  const BEGIN = 1
  const cb = koffi.register((_display, flags) => {
    if ((flags & BEGIN) !== 0) return
    try { onChange() } catch { /* a listener fault must not unwind into CoreGraphics */ }
  }, koffi.pointer(ReconfigCb))
  cgRegisterReconfig(cb, null)
  return () => {
    cgRemoveReconfig(cb, null)
    koffi.unregister(cb)
  }
}

// --- capture -----------------------------------------------------------------

/**
 * One frame of a display.
 * @typedef {object} Frame
 * @property {unknown} handle Opaque CGImageRef; pass to {@link releaseFrame}.
 * @property {number} width Backing-store pixels.
 * @property {number} height Backing-store pixels.
 * @property {number} scale Backing pixels per logical point, derived from this frame.
 */

/**
 * Capture one display. Without screen-recording access this still succeeds but
 * returns only the desktop picture and this process's own windows, so callers must
 * check {@link screenPermission} first rather than inferring failure from a null.
 * @param {{ id: number, width: number }} display
 * @returns {Frame | null}
 */
export function captureDisplay(display) {
  const handle = cgDisplayCreateImage(display.id)
  if (!handle) return null
  const width = Number(cgImageWidth(handle))
  const height = Number(cgImageHeight(handle))
  return { handle, width, height, scale: display.width > 0 ? width / display.width : 1 }
}

/** @param {Frame | null} frame */
export function releaseFrame(frame) {
  if (!frame?.handle) return
  if (frame.pixels) { cfRelease(frame.pixels.data); frame.pixels = null }
  cgImageRelease(frame.handle)
}

/**
 * Colour of one backing pixel of a frame, as [r, g, b] 0-255, or null outside it.
 * The frame's bytes are copied once, on the first read (the copy is mapped, not
 * duplicated), and each read is a four-byte fetch: about 0.2 microseconds.
 * @param {Frame} frame
 * @param {number} px backing-pixel column.
 * @param {number} py backing-pixel row, top first.
 */
export function pixelAt(frame, px, py) {
  if (!frame?.handle || px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null
  if (!frame.pixels) {
    const info = cgImageBitmapInfo(frame.handle)
    frame.pixels = {
      data: cgProviderCopyData(cgImageProvider(frame.handle)),
      stride: Number(cgImageBytesPerRow(frame.handle)),
      // 32-bit little-endian with alpha first lays bytes out B, G, R, A; big-endian with
      // alpha first is A, R, G, B; alpha last is R, G, B, A.
      order: (info & 0x7000) === 0x2000 ? 'bgra' : ((info & 0x1f) === 1 || (info & 0x1f) === 3) ? 'rgba' : 'argb',
      buffer: new Uint8Array(4),
    }
  }
  const { data, stride, order, buffer } = frame.pixels
  cfDataGetBytes(data, { location: py * stride + px * 4, length: 4 }, buffer)
  if (order === 'bgra') return [buffer[2], buffer[1], buffer[0]]
  if (order === 'rgba') return [buffer[0], buffer[1], buffer[2]]
  return [buffer[1], buffer[2], buffer[3]]
}

/**
 * Decode PNG bytes into an image a layer can show directly.
 * @param {Uint8Array} bytes
 * @returns {Frame | null} release with {@link releaseFrame}; `scale` is 1.
 */
export function imageFromPng(bytes) {
  const data = cfDataCreate(null, bytes, bytes.length)
  if (!data) return null
  const source = sourceCreateWithData(data, null)
  cfRelease(data)
  if (!source) return null
  const handle = sourceCreateImage(source, 0, null)
  cfRelease(source)
  if (!handle) return null
  return { handle, width: Number(cgImageWidth(handle)), height: Number(cgImageHeight(handle)), scale: 1 }
}

/**
 * Write a crop of one frame to a PNG file.
 * @param {Frame} frame source frame.
 * @param {{ x: number, y: number, width: number, height: number }} rect crop in logical points, frame-relative.
 * @param {string} path absolute destination path.
 * @returns {{ width: number, height: number }} the written image's pixel size.
 */
export function writeCropPng(frame, rect, path) {
  const s = frame.scale
  // Snap to whole backing pixels so the crop never straddles a pixel and resamples.
  const px = {
    origin: { x: Math.round(rect.x * s), y: Math.round(rect.y * s) },
    size: { width: Math.max(1, Math.round(rect.width * s)), height: Math.max(1, Math.round(rect.height * s)) },
  }
  const cropped = cgImageCreateWithRect(frame.handle, px)
  if (!cropped) throw new Error('crop failed')
  const url = cfUrlFromPath(null, path, Buffer.byteLength(path), false)
  const type = cfStringFromC(null, 'public.png', UTF8)
  const dst = destCreateWithUrl(url, type, 1, null)
  if (!dst) {
    cgImageRelease(cropped); cfRelease(url); cfRelease(type)
    throw new Error(`cannot write ${path}`)
  }
  destAdd(dst, cropped, null)
  const ok = destFinalize(dst)
  const size = { width: Number(cgImageWidth(cropped)), height: Number(cgImageHeight(cropped)) }
  cfRelease(dst); cfRelease(url); cfRelease(type)
  cgImageRelease(cropped)
  if (!ok) throw new Error(`PNG encode failed for ${path}`)
  return size
}

// --- app behaviour -----------------------------------------------------------

/**
 * The system appearance right now.
 * Read from the application's effective appearance rather than a defaults key, so it
 * follows an app-level override and the automatic light/dark switch alike.
 * @returns {'light' | 'dark'}
 */
export function systemTheme() {
  const appearance = send.id(nsApp(), S('effectiveAppearance'))
  if (!appearance) return 'light'
  const name = send.id(appearance, S('name'))
  if (!name) return 'light'
  const utf8 = sendStr(name, S('UTF8String'))
  return typeof utf8 === 'string' && utf8.includes('Dark') ? 'dark' : 'light'
}

/** Stops the webview toolkit from activating this process while the overlay is down. */
export function preventAppActivation() {
  const appClass = classOf(nsApp())
  replace.boolArgVoid(appClass, S('activateIgnoringOtherApps:'), imps.noopFlag, `v@:${boolType}`)
  replace.noArgVoid(appClass, S('activate'), imps.noop, 'v@:')
}

/** No Dock tile; the overlay is not an app the user switches to. */
export function hideFromDock() {
  send.boolLong(nsApp(), S('setActivationPolicy:'), 1) // NSApplicationActivationPolicyAccessory
}

/**
 * Bring this process forward so the overlay receives key events.
 * NSApplication's own activation is disabled by {@link preventAppActivation},
 * so this goes through NSRunningApplication instead.
 */
export function activateApp() {
  const running = send.id(getClass('NSRunningApplication'), S('currentApplication'))
  send.boolLong(running, S('activateWithOptions:'), 2) // NSApplicationActivateIgnoringOtherApps
}

// --- layers --------------------------------------------------------------------
// Chrome that has to move in step with a window or with the pointer is drawn as layers in
// the window itself rather than in its web view: a web view repaints a frame after its
// window changes, which shows as jitter, while layers update in the same transaction.

const colorCache = new Map()
/** A cached CGColor for an sRGB colour; components 0-1. */
export function color(r, g, b, a = 1) {
  const key = `${r},${g},${b},${a}`
  let c = colorCache.get(key)
  if (!c) { c = cgColorSRGB(r, g, b, a); colorCache.set(key, c) }
  return c
}

const fontCache = new Map()
function font(name, size) {
  const key = `${name}@${size}`
  let f = fontCache.get(key)
  if (!f) { f = ctFontWithName(cfStringFromC(null, name, UTF8), size, null); fontCache.set(key, f) }
  return f
}

/**
 * Apply layer changes without Core Animation's implicit 0.25 s animations, which would
 * make anything that follows the pointer trail behind it.
 * @param {() => void} fn
 */
export function instantly(fn) {
  const tx = getClass('CATransaction')
  send.void(tx, S('begin'))
  send.voidBool(tx, S('setDisableActions:'), true)
  try { fn() } finally { send.void(tx, S('commit')) }
}

/**
 * Turn off implicit animations on one layer for good. A transaction with actions disabled
 * is not enough for text: a text layer re-renders when its string changes, later and
 * outside that transaction, and the change then cross-fades for a quarter second, leaving
 * the old text visible behind the new.
 */
const STILL_KEYS = ['contents', 'contentsRect', 'bounds', 'position', 'frame', 'hidden', 'opacity',
  'backgroundColor', 'borderColor', 'sublayers', 'onOrderIn', 'onOrderOut', 'transform']
let stillActions = null
function still(layer) {
  if (!stillActions) {
    stillActions = send.id(send.id(getClass('NSMutableDictionary'), S('alloc')), S('init'))
    const none = send.id(getClass('NSNull'), S('null'))
    for (const key of STILL_KEYS) send.voidIdId(stillActions, S('setObject:forKey:'), none, cfStringFromC(null, key, UTF8))
  }
  send.voidId(layer, S('setActions:'), stillActions)
  return layer
}

/** Primitive operations on a layer. Rects are in the parent layer's coordinates, origin bottom-left. */
function layerApi(layer) {
  return {
    handle: layer,
    frame(r) { send.voidRect(layer, S('setFrame:'), { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } }) },
    hidden(on) { send.voidBool(layer, S('setHidden:'), Boolean(on)) },
    background(c) { send.voidId(layer, S('setBackgroundColor:'), c) },
    border(width, c) { send.voidDouble(layer, S('setBorderWidth:'), width); send.voidId(layer, S('setBorderColor:'), c) },
    radius(r) { send.voidDouble(layer, S('setCornerRadius:'), r) },
    clip(on) { send.voidBool(layer, S('setMasksToBounds:'), Boolean(on)) },
    z(v) { send.voidDouble(layer, S('setZPosition:'), v) },
    contents(image) { send.voidId(layer, S('setContents:'), image ?? null) },
    /** Show only part of the contents: a rect in unit coordinates of the image. */
    contentsRect(r) { send.voidRect(layer, S('setContentsRect:'), { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } }) },
    /** Enlarge contents pixel-for-pixel instead of smoothing them. */
    nearest() { send.voidId(layer, S('setMagnificationFilter:'), cfStringFromC(null, 'nearest', UTF8)) },
    scale(v) { send.voidDouble(layer, S('setContentsScale:'), v) },
    add(child) { send.voidId(layer, S('addSublayer:'), child.handle) },
    shadow({ radius, opacity, offsetY }) {
      send.voidDouble(layer, S('setShadowRadius:'), radius)
      send.voidDouble(layer, S('setShadowOpacity:'), opacity)
      send.voidId(layer, S('setShadowColor:'), color(0, 0, 0, 1))
      send.voidSize(layer, S('setShadowOffset:'), { width: 0, height: -offsetY })
    },
    remove() { send.void(layer, S('removeFromSuperlayer')) },
  }
}

/** A new empty layer. */
export function createLayer() {
  return layerApi(still(send.id(send.id(getClass('CALayer'), S('alloc')), S('init'))))
}

/**
 * Lines on a regular grid: `count` cells of `cell` points each way, drawn by one shape layer.
 * @param {{ count: number, cell: number, ink: any, width?: number }} options
 */
export function createGridLayer({ count, cell, ink, width = 1 }) {
  const layer = still(send.id(send.id(getClass('CAShapeLayer'), S('alloc')), S('init')))
  const path = cgPathCreate()
  const size = count * cell
  for (let i = 1; i < count; i++) {
    cgPathMove(path, null, i * cell, 0); cgPathLine(path, null, i * cell, size)
    cgPathMove(path, null, 0, i * cell); cgPathLine(path, null, size, i * cell)
  }
  send.voidId(layer, S('setPath:'), path)
  send.voidId(layer, S('setStrokeColor:'), ink)
  send.voidId(layer, S('setFillColor:'), null)
  send.voidDouble(layer, S('setLineWidth:'), width)
  return layerApi(layer)
}

/**
 * A single-line text layer.
 * @param {{ size: number, weight?: 'regular' | 'semibold', mono?: boolean, align?: 'left' | 'center', scale: number }} options
 */
export function createTextLayer({ size, weight = 'regular', mono = false, align = 'center', scale }) {
  const layer = still(send.id(send.id(getClass('CATextLayer'), S('alloc')), S('init')))
  const api = layerApi(layer)
  const name = mono ? 'Menlo-Regular' : weight === 'semibold' ? '.AppleSystemUIFontDemi' : '.AppleSystemUIFont'
  send.voidId(layer, S('setFont:'), font(name, size))
  send.voidDouble(layer, S('setFontSize:'), size)
  send.voidId(layer, S('setAlignmentMode:'), cfStringFromC(null, align, UTF8))
  api.scale(scale)
  return Object.assign(api, {
    text(str) { send.voidId(layer, S('setString:'), cfStringFromC(null, String(str), UTF8)) },
    ink(c) { send.voidId(layer, S('setForegroundColor:'), c) },
    /** The size the current text needs. */
    measure() { const z = send.size(layer, S('preferredFrameSize')); return { width: z.width, height: z.height } },
  })
}

// --- overlay window ----------------------------------------------------------

let overlayClass = null
function shotWindowClass() {
  if (overlayClass) return overlayClass
  // A borderless NSWindow cannot become key, and the overlay must receive Esc.
  overlayClass = allocateClassPair(getClass('NSWindow'), 'DSHShotWindow', 0)
  registerClassPair(overlayClass)
  replace.noArgBool(overlayClass, S('canBecomeKeyWindow'), imps.yes, `${boolType}@:`)
  replace.noArgBool(overlayClass, S('canBecomeMainWindow'), imps.yes, `${boolType}@:`)
  // AppKit keeps a window's top out from under the menu bar by rewriting every frame it is
  // given. A pin dragged up towards a display above the main one then sticks at the top
  // of the main display until it is wholly past it, and jumps; the overlay must cover the
  // menu bar outright. These windows place themselves, so frames are taken as given.
  const rect = '{CGRect={CGPoint=dd}{CGSize=dd}}'
  replace.constrainRect(overlayClass, S('constrainFrameRect:toScreen:'), imps.unconstrained, `${rect}@:${rect}@`)
  return overlayClass
}

function findWebView(view, depth = 0) {
  if (send.boolId(view, S('isKindOfClass:'), getClass('WKWebView'))) return view
  if (depth > 5) return null
  const subviews = send.id(view, S('subviews'))
  const count = Number(send.ulong(subviews, S('count')))
  for (let i = 0; i < count; i++) {
    const found = findWebView(send.idIndex(subviews, S('objectAtIndex:'), i), depth + 1)
    if (found) return found
  }
  return null
}

function cocoaFrame(bounds, primaryHeight) {
  return {
    origin: { x: bounds.x, y: primaryHeight - bounds.y - bounds.height },
    size: { width: bounds.width, height: bounds.height },
  }
}

/** Height of the primary display, the origin of Cocoa's flipped coordinate space. */
export function primaryHeight() {
  return cgDisplayBounds(cgMainDisplay()).size.height
}

/**
 * Window levels this plugin uses.
 * `overlay` is kCGScreenSaverWindowLevel + 1, so the capture surface covers full-screen
 * apps the way a system screenshot does. `float` is kCGFloatingWindowLevel, which keeps a
 * pinned image above ordinary windows without fighting menus and alerts.
 */
export const LEVEL = { overlay: 1001, float: 3, normal: 0 }

/**
 * A borderless window hosting one web view, with an optional image layer beneath it.
 * The overlay and every floating surface share this; only the level, opacity and
 * space behaviour differ.
 * @param {{
 *   bounds: { x: number, y: number, width: number, height: number },
 *   taoWindow: any,
 *   level?: number,
 *   opaque?: boolean,
 *   shadow?: boolean,
 *   allSpaces?: boolean,
 * }} options
 */
export function createHostedWindow({ bounds, taoWindow, level = LEVEL.float, opaque = false, shadow = true, allSpaces = false }) {
  const frame = cocoaFrame(bounds, primaryHeight())
  const win = send.initWin(
    send.id(shotWindowClass(), S('alloc')),
    S('initWithContentRect:styleMask:backing:defer:'),
    frame,
    0, // borderless
    2, // NSBackingStoreBuffered
    false,
  )
  send.voidBool(win, S('setOpaque:'), opaque)
  if (!opaque) send.voidId(win, S('setBackgroundColor:'), send.id(getClass('NSColor'), S('clearColor')))
  send.voidBool(win, S('setHasShadow:'), shadow)
  send.voidBool(win, S('setReleasedWhenClosed:'), false)
  send.voidLong(win, S('setLevel:'), level)
  // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
  send.voidUlong(win, S('setCollectionBehavior:'), allSpaces ? (1 | 16 | 64 | 256) : (16 | 256))

  const content = send.id(win, S('contentView'))
  send.voidBool(content, S('setWantsLayer:'), true)
  const layer = send.id(content, S('layer'))
  send.voidId(layer, S('setContentsGravity:'), cfStringFromC(null, 'resize', UTF8))

  // Move wry's web view out of its own window and onto the frozen frame.
  const taoContent = taoWindow.getNativeHandle()
  const webView = findWebView(taoContent)
  if (!webView) throw new Error('WKWebView not found in the overlay window')
  let node = webView
  for (let p = send.id(node, S('superview')); p && p !== taoContent; p = send.id(node, S('superview'))) node = p
  const box = { origin: { x: 0, y: 0 }, size: frame.size }
  send.id(node, S('retain'))
  send.void(node, S('removeFromSuperview'))
  send.voidRect(node, S('setFrame:'), box)
  send.voidUlong(node, S('setAutoresizingMask:'), 2 | 16) // width | height
  send.voidId(content, S('addSubview:'), node)
  // A window that is not yet key would otherwise spend the first click on activation.
  replace.eventBool(classOf(webView), S('acceptsFirstMouse:'), imps.yesEvent, `${boolType}@:@`)

  let shown = false
  return {
    /** The content view's layer: the frozen frame or pinned image, with chrome layers on top. */
    rootLayer: () => layerApi(layer),
    /** Height of the content area, for converting top-left coordinates to layer ones. */
    contentHeight: () => send.rect(win, S('frame')).size.height,
    /** Round the window's contents; the system shadow follows the rounded shape. */
    setCornerRadius(r) {
      send.voidDouble(layer, S('setCornerRadius:'), r)
      send.voidBool(layer, S('setMasksToBounds:'), r > 0)
    },
    /** @param {Frame | null} f */
    setFrameImage(f) {
      send.voidId(layer, S('setContents:'), f ? f.handle : null)
    },
    setBounds(next) {
      send.voidRectBool(win, S('setFrame:display:'), cocoaFrame(next, primaryHeight()), true)
    },
    show({ key = false } = {}) {
      send.void(win, S('orderFrontRegardless'))
      if (key) {
        send.void(win, S('makeKeyWindow'))
        send.boolId(win, S('makeFirstResponder:'), webView)
      }
      shown = true
    },
    hide() {
      send.voidId(win, S('orderOut:'), null)
      send.voidId(layer, S('setContents:'), null)
      shown = false
    },
    get visible() { return shown },
    /**
     * Move the window's top-left corner to a point in top-left global coordinates.
     * Cheaper than setFrame: it neither resizes nor redraws, so it can run every frame.
     */
    moveTopLeft(x, y) {
      send.voidPoint(win, S('setFrameTopLeftPoint:'), { x, y: primaryHeight() - y })
    },
    /**
     * Recompute the system shadow from what the window now shows. A transparent window's
     * shadow follows its visible content, but only as of the last computation, so it is
     * redone once content arrives and after a resize.
     */
    invalidateShadow() { send.void(win, S('invalidateShadow')) },
    /** 0 to 1; a pinned image can be faded without being hidden. */
    setAlpha(value) {
      send.voidDouble(win, S('setAlphaValue:'), Math.max(0, Math.min(1, value)))
    },
    setLevel(next) { send.voidLong(win, S('setLevel:'), next) },
    /** Current frame in top-left logical coordinates. */
    bounds() {
      const f = send.rect(win, S('frame'))
      return {
        x: f.origin.x,
        y: primaryHeight() - f.origin.y - f.size.height,
        width: f.size.width,
        height: f.size.height,
      }
    },
    dispose() {
      send.voidId(win, S('orderOut:'), null)
      send.voidId(layer, S('setContents:'), null)
      send.void(win, S('close'))
    },
    inspect: () => ({
      level: Number(send.long(win, S('level'))),
      visible: send.bool(win, S('isVisible')),
      key: send.bool(win, S('isKeyWindow')),
    }),
  }
}

/**
 * The capture surface: one fullscreen window per display, opaque because it holds the
 * frozen frame on its own layer, above full-screen apps and on every space.
 * @param {{ bounds: object, taoWindow: any }} options
 */
export function createOverlayWindow({ bounds, taoWindow }) {
  return createHostedWindow({ bounds, taoWindow, level: LEVEL.overlay, opaque: true, shadow: false, allSpaces: true })
}
