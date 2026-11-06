// Window behaviour @webviewjs/webview does not expose: no Dock icon, clicks that do not steal focus,
// and a level above full-screen apps. System APIs are called through koffi, so nothing is compiled.
// The Windows branch has not been run on real hardware yet.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Loads koffi's platform package directly. The `koffi` meta package runs an install script that
 * DSH's pnpm refuses by default; the platform packages carry the same native API and no script.
 */
function loadKoffi() {
  const name = `@koromix/koffi-${process.platform}-${process.arch}`
  try {
    return require(name)
  } catch (error) {
    throw new Error(`${name} is missing; reinstall the plugin for this platform (${error.message})`)
  }
}

/**
 * Controls one overlay window. Coordinates are logical screen points with a top-left origin,
 * matching what selection-hook reports.
 * @typedef {object} OverlayWindow
 * @property {(rect: { x: number, y: number, width: number, height: number }) => void} setBounds
 * @property {() => void} showInactive Shows the window without activating the app.
 * @property {() => void} hide
 * @property {(keyable: boolean) => void} setKeyable Lets the window take keyboard input (the ask box) or not.
 * @property {() => Record<string, unknown>} inspect Reads back the effective native state, for self tests.
 */

/**
 * @typedef {object} NativeWindowTweaks
 * @property {() => void} preventActivation Keeps this process from ever activating; call before the first event pump.
 * @property {() => void} hideFromDock
 * @property {(point: { x: number, y: number }) => ({ x: number, y: number, width: number, height: number } | null)} displayBoundsAt
 * @property {(win: any) => OverlayWindow} adopt Turns a @webviewjs window into a floating overlay.
 */

/** @returns {NativeWindowTweaks | null} */
export function createNativeWindowTweaks() {
  if (process.platform === 'darwin') return macTweaks(loadKoffi())
  if (process.platform === 'win32') return windowsTweaks(loadKoffi())
  return null
}

/** Fallback without native tweaks: the window activates on show. Only for unsupported platforms. */
export function plainOverlayWindow(win) {
  return {
    setBounds(rect) {
      win.setSize(rect.width, rect.height, true)
      win.setPosition(rect.x, rect.y, true)
    },
    showInactive: () => win.show(),
    hide: () => win.hide(),
    setKeyable: () => {},
    inspect: () => ({}),
  }
}

function macTweaks(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const coreGraphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })
  const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' })
  const CGRect = koffi.struct('CGRect', { origin: CGPoint, size: CGSize })
  const mainDisplay = coreGraphics.func('uint32_t CGMainDisplayID(void)')
  const displayBounds = coreGraphics.func('CGRect CGDisplayBounds(uint32_t display)')
  const displaysWithPoint = coreGraphics.func('int32_t CGGetDisplaysWithPoint(CGPoint point, uint32_t maxDisplays, _Out_ uint32_t *displays, _Out_ uint32_t *count)')

  const getClass = objc.func('void *objc_getClass(const char *name)')
  const selector = objc.func('void *sel_registerName(const char *name)')
  const classOf = objc.func('void *object_getClass(void *obj)')
  const className = objc.func('const char *class_getName(void *cls)')
  const allocateClassPair = objc.func('void *objc_allocateClassPair(void *superclass, const char *name, size_t extraBytes)')
  const registerClassPair = objc.func('void objc_registerClassPair(void *cls)')
  // On arm64 objc_msgSend must be declared with the exact signature of each call; it is not variadic.
  const send = {
    id: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
    idIndex: objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'unsigned long']),
    initPanel: objc.func('objc_msgSend', 'void *', ['void *', 'void *', CGRect, 'unsigned long', 'unsigned long', 'bool']),
    bool: objc.func('objc_msgSend', 'bool', ['void *', 'void *']),
    boolId: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']),
    boolLong: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'long']),
    long: objc.func('objc_msgSend', 'long', ['void *', 'void *']),
    ulong: objc.func('objc_msgSend', 'unsigned long', ['void *', 'void *']),
    void: objc.func('objc_msgSend', 'void', ['void *', 'void *']),
    voidId: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']),
    voidLong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']),
    voidUlong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'unsigned long']),
    voidBool: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']),
    voidRect: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGRect]),
    voidRectBool: objc.func('objc_msgSend', 'void', ['void *', 'void *', CGRect, 'bool']),
    // Struct returns only go through plain objc_msgSend on arm64; x86_64 would need objc_msgSend_stret.
    rect: process.arch === 'arm64' ? objc.func('objc_msgSend', CGRect, ['void *', 'void *']) : null,
  }
  const sel = (name) => selector(name)
  const app = () => send.id(getClass('NSApplication'), sel('sharedApplication'))
  const boolType = process.arch === 'arm64' ? 'B' : 'c'

  // Method implementations installed with class_replaceMethod. AppKit calls them on the main thread
  // while the event pump runs; the references must stay alive for the life of the process.
  const NoArgBool = koffi.proto('bool NoArgBool(void *self, void *cmd)')
  const EventBool = koffi.proto('bool EventBool(void *self, void *cmd, void *event)')
  const NoArgVoid = koffi.proto('void NoArgVoid(void *self, void *cmd)')
  const BoolArgVoid = koffi.proto('void BoolArgVoid(void *self, void *cmd, bool flag)')
  const replace = {
    noArgBool: objc.func('void *class_replaceMethod(void *cls, void *name, NoArgBool *imp, const char *types)'),
    eventBool: objc.func('void *class_replaceMethod(void *cls, void *name, EventBool *imp, const char *types)'),
    noArgVoid: objc.func('void *class_replaceMethod(void *cls, void *name, NoArgVoid *imp, const char *types)'),
    boolArgVoid: objc.func('void *class_replaceMethod(void *cls, void *name, BoolArgVoid *imp, const char *types)'),
  }
  let keyable = false
  const callbacks = {
    canBecomeKey: koffi.register(() => keyable, koffi.pointer(NoArgBool)),
    never: koffi.register(() => false, koffi.pointer(NoArgBool)),
    always: koffi.register(() => true, koffi.pointer(EventBool)),
    noop: koffi.register(() => {}, koffi.pointer(NoArgVoid)),
    noopFlag: koffi.register(() => {}, koffi.pointer(BoolArgVoid)),
  }

  let panelClass = null
  // Only NSPanel honours the non-activating style; AppKit rejects it on a plain NSWindow. Key status is
  // off unless the ask box needs typing, so clicking the toolbar leaves the source app's selection alone.
  function overlayPanelClass() {
    if (panelClass) return panelClass
    panelClass = allocateClassPair(getClass('NSPanel'), 'DSHSelectionPanel', 0)
    registerClassPair(panelClass)
    replace.noArgBool(panelClass, sel('canBecomeKeyWindow'), callbacks.canBecomeKey, `${boolType}@:`)
    replace.noArgBool(panelClass, sel('canBecomeMainWindow'), callbacks.never, `${boolType}@:`)
    return panelClass
  }

  function findWebView(view, depth = 0) {
    if (send.boolId(view, sel('isKindOfClass:'), getClass('WKWebView'))) return view
    if (depth > 4) return null
    const subviews = send.id(view, sel('subviews'))
    const count = Number(send.ulong(subviews, sel('count')))
    for (let i = 0; i < count; i++) {
      const found = findWebView(send.idIndex(subviews, sel('objectAtIndex:'), i), depth + 1)
      if (found) return found
    }
    return null
  }

  // Top-left logical coordinates → Cocoa coordinates (origin at the primary display's bottom-left, y up).
  function toCocoaFrame(rect) {
    const primaryHeight = displayBounds(mainDisplay()).size.height
    return { origin: { x: rect.x, y: primaryHeight - rect.y - rect.height }, size: { width: rect.width, height: rect.height } }
  }

  function fromCocoaFrame({ origin, size }) {
    const primaryHeight = displayBounds(mainDisplay()).size.height
    return { x: origin.x, y: primaryHeight - origin.y - size.height, width: size.width, height: size.height }
  }

  return {
    preventActivation() {
      // tao calls activateIgnoringOtherApps once launching finishes, which would steal focus from the
      // app the user is selecting in. This process never needs to be the active app.
      const appClass = classOf(app())
      replace.boolArgVoid(appClass, sel('activateIgnoringOtherApps:'), callbacks.noopFlag, `v@:${boolType}`)
      replace.noArgVoid(appClass, sel('activate'), callbacks.noop, 'v@:')
    },
    hideFromDock() {
      send.boolLong(app(), sel('setActivationPolicy:'), 1) // NSApplicationActivationPolicyAccessory
    },
    displayBoundsAt(point) {
      const ids = [0]
      const count = [0]
      if (displaysWithPoint({ x: point.x, y: point.y }, 1, ids, count) !== 0 || count[0] === 0) return null
      const { origin, size } = displayBounds(ids[0])
      return { x: origin.x, y: origin.y, width: size.width, height: size.height }
    },
    adopt(win) {
      // tao's window is an NSWindow subclass under KVO, so it cannot become a panel. Build a real panel
      // and move wry's web view into it; the tao window stays hidden and only hosts the web view's origin.
      const contentView = win.getNativeHandle()
      const webView = findWebView(contentView)
      if (!webView) throw new Error('WKWebView not found in the overlay window')
      let node = webView
      for (let parent = send.id(node, sel('superview')); parent && parent !== contentView; parent = send.id(node, sel('superview'))) node = parent

      const size = { width: 1, height: 1 }
      const panel = send.initPanel(
        send.id(overlayPanelClass(), sel('alloc')),
        sel('initWithContentRect:styleMask:backing:defer:'),
        { origin: { x: 0, y: 0 }, size },
        1 << 7, // borderless + NSWindowStyleMaskNonactivatingPanel
        2, // NSBackingStoreBuffered
        false,
      )
      send.voidBool(panel, sel('setOpaque:'), false)
      send.voidId(panel, sel('setBackgroundColor:'), send.id(getClass('NSColor'), sel('clearColor')))
      send.voidBool(panel, sel('setHasShadow:'), false)
      send.voidBool(panel, sel('setFloatingPanel:'), true)
      send.voidBool(panel, sel('setBecomesKeyOnlyIfNeeded:'), true)
      send.voidBool(panel, sel('setHidesOnDeactivate:'), false)
      send.voidBool(panel, sel('setReleasedWhenClosed:'), false)
      // kCGScreenSaverWindowLevel + 1: above full-screen apps, like Electron's setAlwaysOnTop(true, 'screen-saver', 1).
      send.voidLong(panel, sel('setLevel:'), 1001)
      // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
      send.voidUlong(panel, sel('setCollectionBehavior:'), 1 | 16 | 64 | 256)

      send.id(node, sel('retain')) // keep the view alive while it moves between windows
      send.void(node, sel('removeFromSuperview'))
      send.voidRect(node, sel('setFrame:'), { origin: { x: 0, y: 0 }, size })
      send.voidUlong(node, sel('setAutoresizingMask:'), 2 | 16) // follow the panel's width and height
      send.voidId(send.id(panel, sel('contentView')), sel('addSubview:'), node)
      // A window that is not key normally spends the first click on becoming active; take it as a real click.
      replace.eventBool(classOf(webView), sel('acceptsFirstMouse:'), callbacks.always, `${boolType}@:@`)

      return {
        setBounds(rect) {
          send.voidRectBool(panel, sel('setFrame:display:'), toCocoaFrame(rect), true)
        },
        showInactive() {
          send.void(panel, sel('orderFrontRegardless'))
        },
        hide() {
          keyable = false
          send.voidId(panel, sel('orderOut:'), null)
        },
        setKeyable(value) {
          keyable = value
          if (value) {
            // A non-activating panel becomes key without activating the app, so the user can type
            // into the ask box while the app they selected in stays frontmost.
            send.void(panel, sel('makeKeyWindow'))
            send.boolId(panel, sel('makeFirstResponder:'), webView)
          } else if (send.bool(panel, sel('isKeyWindow'))) {
            send.void(panel, sel('resignKeyWindow'))
          }
        },
        inspect() {
          return {
            windowClass: className(classOf(panel)),
            isPanel: send.boolId(panel, sel('isKindOfClass:'), getClass('NSPanel')),
            activationPolicy: ['regular', 'accessory', 'prohibited'][Number(send.long(app(), sel('activationPolicy')))],
            appActive: send.bool(app(), sel('isActive')),
            nonactivatingPanel: (BigInt(send.ulong(panel, sel('styleMask'))) & (1n << 7n)) !== 0n,
            level: Number(send.long(panel, sel('level'))),
            collectionBehavior: Number(send.ulong(panel, sel('collectionBehavior'))),
            canBecomeKey: send.bool(panel, sel('canBecomeKeyWindow')),
            isKey: send.bool(panel, sel('isKeyWindow')),
            isVisible: send.bool(panel, sel('isVisible')),
            webViewAcceptsFirstMouse: send.boolId(webView, sel('acceptsFirstMouse:'), null),
            frame: send.rect ? fromCocoaFrame(send.rect(panel, sel('frame'))) : null,
          }
        },
      }
    },
  }
}

function windowsTweaks(koffi) {
  const user32 = koffi.load('user32.dll')
  const getLong = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)')
  const setLong = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)')
  const showWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)')
  const setPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)')
  const setForeground = user32.func('bool __stdcall SetForegroundWindow(void *hwnd)')
  const getForeground = user32.func('intptr_t __stdcall GetForegroundWindow()')
  const GWL_EXSTYLE = -20
  const WS_EX_TOPMOST = 0x8n
  const WS_EX_TOOLWINDOW = 0x80n
  const WS_EX_NOACTIVATE = 0x08000000n
  const HWND_TOPMOST = -1
  const SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x1 | 0x2 | 0x10
  const SW_HIDE = 0
  const SW_SHOWNOACTIVATE = 4

  return {
    preventActivation() {},
    hideFromDock() {},
    displayBoundsAt: () => null,
    adopt(win) {
      const hwnd = win.getNativeHandle()
      const isForeground = () => {
        try {
          return BigInt(getForeground()) === BigInt(hwnd)
        } catch {
          return false
        }
      }
      const base = BigInt(getLong(hwnd, GWL_EXSTYLE)) | WS_EX_TOPMOST | WS_EX_TOOLWINDOW
      setLong(hwnd, GWL_EXSTYLE, base | WS_EX_NOACTIVATE)
      return {
        // The overlay converts selection-hook's physical pixels to logical ones before calling this.
        setBounds(rect) {
          win.setSize(rect.width, rect.height, true)
          win.setPosition(rect.x, rect.y, true)
        },
        showInactive() {
          showWindow(hwnd, SW_SHOWNOACTIVATE)
          setPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE)
        },
        hide() {
          setLong(hwnd, GWL_EXSTYLE, base | WS_EX_NOACTIVATE)
          showWindow(hwnd, SW_HIDE)
        },
        setKeyable(value) {
          setLong(hwnd, GWL_EXSTYLE, value ? base : base | WS_EX_NOACTIVATE)
          if (value) setForeground(hwnd)
        },
        inspect() {
          const current = BigInt(getLong(hwnd, GWL_EXSTYLE))
          return {
            noActivate: (current & WS_EX_NOACTIVATE) !== 0n,
            toolWindow: (current & WS_EX_TOOLWINDOW) !== 0n,
            topmost: (current & WS_EX_TOPMOST) !== 0n,
            // After setKeyable(true) the panel is the foreground window and gets the keystrokes.
            isKey: isForeground(),
          }
        },
      }
    },
  }
}
