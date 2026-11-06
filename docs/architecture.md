# Architecture

```text
DSH Desktop (Electron main, launched by macOS LaunchServices)
└─ DSH Host (Electron in Node mode; loads plugins)
   ├─ index.js ─ src/host/service.mjs      settings, model calls, worker supervision
   │             src/host/http.mjs         /dsh-selection/api/* for the settings page (+ SSE)
   │             src/host/usage.mjs        token counts per day, model and skill (numbers only)
   │             ctx.get('llm')            DSH's model service: prepareCall → stream
   └─ fork → src/worker/main.mjs           a child process: crash isolation, own main thread
            ├─ src/worker/controller.mjs   what each selection, click, key, page and Host message does
            ├─ vendor/selection-hook       global mouse/keyboard hook, reads the selection
            ├─ src/worker/overlay.mjs      @webviewjs/webview window, pumped from a Node timer
            │   └─ src/worker/page.mjs     ui/toolbar.* inlined into one HTML string
            │       └─ ui/toolbar.html     toolbar, ⋯ menu, result panel
            └─ src/worker/native-window.mjs  koffi → objc / user32 for overlay window behaviour

DSH web UI (renderer) ─ client.js          sidebar entry + settings page, talks to /dsh-selection/api
```

## Messages

Worker ↔ Host (Node IPC):

| From | Type | Fields | Meaning |
| --- | --- | --- | --- |
| worker | `hello` | | Ready for configuration. |
| Host | `config` | `config` | Skills to draw, behaviour flags. Sent again whenever settings change. |
| worker | `permission` | `trusted`, `prompted?` | macOS accessibility state. |
| worker | `ready` | `hookStarted`, `platform`, `pid` | The hook and overlay are up. |
| worker | `selection` | `app` | Text was selected. Only the app name crosses over; the text stays in the worker. |
| worker | `run` | `requestId`, `skillId`, `text`, `language?`, `question?`, `history?` | The user clicked a model skill or asked a follow-up. A `history` turn is `{ question, answer }`, or `{ skillId, language?, answer }` for the answer of the skill the panel was opened with. |
| Host | `result` | `requestId`, `chunk?`, `done?`, `error?` | Streamed answer; `error` is `{ code, detail }`. |
| worker | `cancel` | `requestId` | The panel was closed or replaced. |
| worker | `disable-app` / `open-settings` | `app?` | ⋯ menu actions. |
| worker | `log` | `level`, `message`, `fields?` | Written to the Host's log. |
| Host | `shutdown` | | Clean up and exit. |

Page ↔ worker: the worker calls `window.bar.*` (`configure`, `showBar`, `showPanel`, `begin`, `append`, `done`, `fail`, `setSpeaking`, `setMenu`, `flash`, `reset`, and `probe` / `click` for self tests). The page posts JSON through `window.ipc.postMessage`: `page-ready` (first; the overlay ignores everything before it, and anything from another document), `page-error`, `size`, `skill`, `menu` (`disable-app` or `settings`; anything else is ignored), `drag`, `retry` (with the `requestId` of the failed request when it comes from a failure notice; without one it runs the panel's skill again), `language`, `ask`, `copy-result`, `open-url`, `pin`, `keyboard`, `close`.

Settings page ↔ Host: `GET /api/state`, `/api/models`, `/api/usage`; `PUT /api/settings` (a patch); `POST /api/settings/reset`, `/api/models/test`, `/api/skills/test`, `/api/usage/reset`, `/api/worker/restart`, `/api/permission/open`; and `GET /api/events`, a server-sent event stream of `status`, `settings`, `usage`, `navigate` and `closing`. The worker's state is `starting`, `running`, `restarting`, `stopped` or `failed` (five starts in a row died before `ready`; it waits for the Restart button).

## Decisions and the reasons behind them

**Open-ended skills are told which model answers.** Without it, models guess their own identity; DeepSeek Flash said it was Claude. `llm.stream()` resolves the route first and then asks the caller for the prompt, so the name in the prompt is the model that actually answers, and the route lookup stays under the request's timeout and cancellation.

**The worker's rules live in `controller.mjs`, apart from the native code.** `main.mjs` only connects selection-hook, the overlay window and the Host channel to it, so every rule (dismissing, pinning, gestures that start on the overlay, request ids, follow-up history) runs in unit tests with fakes.

**The toolbar runs in a child process of the Host.** A native hook or web view crash then only takes down the worker; the supervisor restarts it with backoff. Being a child of DSH also makes macOS attribute the accessibility grant to DeepSeek Harness (the "responsible process"), which is what users recognise in the permission prompt. The cost is that the grant covers every process DSH spawns. The README says so.

**Model calls happen in the Host, not the worker.** The Host has DSH's `llm` service and credentials; the worker never touches the network or keys. Each click is one request with no tools and `reasoningEffort: 'off'` when the route supports it (otherwise the route default, remembered per route until DSH announces `llm/adapters-updated`). Every panel takes follow-up questions once its answer is complete; those requests carry the panel's earlier turns, the first being the opening skill's answer shown to the model as the instruction that produced it. The route list is cached for five minutes, but an empty or partial list never is, so signing in to DSH takes effect on the next click.

**A turned-off toolbar does not read selections.** selection-hook reads every selection before JavaScript sees it, and in apps without accessibility text that read is a simulated ⌘C. While the toolbar is off, or the trigger is ⌥ and ⌥ is not held, the worker sets the hook's global filter to an empty include list, which makes the native engine return before reading anything.

**Token usage is counted in the Host.** DSH's stream ends each request with a `usage` chunk (also for failed requests); the Host adds it to `usage.json` per local day, model and skill, keeps 90 days and writes after a two-second pause. The settings page reads totals and the split by model and skill for today, the last 7 and 30 days, and everything kept.

**The overlay is a real `NSPanel` that we build ourselves.** macOS only honours the non-activating style on `NSPanel`; on the `NSWindow` subclass tao creates, AppKit logs "NSWindow does not support nonactivating panel styleMask" and ignores it. That window is also under KVO (`NSKVONotifying_TaoWindow`), so swapping its class is unsafe. Instead the worker creates `DSHSelectionPanel` (an `NSPanel` subclass with `canBecomeKeyWindow` switchable and `canBecomeMainWindow` off) and moves wry's `WKWebView` into it. The web view's `acceptsFirstMouse:` returns YES, so a click on the toolbar acts immediately instead of only focusing the window.

**Activation is disabled for the worker process.** tao calls `activateIgnoringOtherApps:` when launching finishes, which pulled the frontmost app away from the one the user was selecting in. Both activation methods are replaced with no-ops before the first event pump. The activation policy is `Accessory`, so there is no Dock icon.

**No install scripts.** DSH installs plugins with pnpm 11, which refuses unapproved dependency scripts and fails the install with `ERR_PNPM_IGNORED_BUILDS`. selection-hook ships N-API prebuilds but runs `node-gyp-build` on install, so it is vendored with only the prebuilds DSH Desktop targets and a direct loader (`scripts/vendor-selection-hook.mjs`). koffi's meta package also has an install script, so the platform packages (`@koromix/koffi-<platform>-<arch>`, which carry the full native API) are optional dependencies loaded directly.

**Timers, not animation frames, in the page.** The toolbar has to resize and keep streaming text even when the web view is occluded or the screen is locked, and `requestAnimationFrame` and `ResizeObserver` stop firing then. Layout is measured synchronously in a microtask and rendering is batched with a 16 ms timer.

**Window events are pumped from a Node timer.** macOS requires window work on the main thread; `@webviewjs/webview` exposes `pumpEvents()`, called every 16 ms while visible and every 250 ms while hidden.

**The settings page reaches the Host through DSH's own web server, behind DSH's own gate.** Routes registered on `webServer` are not authenticated by default, so every request first goes through `ctx.connection.requestRejection(req)`, the check DSH's built-in routes use: a Host/Origin fence against cross-site calls and DNS rebinding, plus the signed-in browser session. Cross-site fetch metadata is refused on top of that, writes must be JSON, and settings are saved as patches so the page never overwrites a change made from the toolbar meanwhile.

## Where coordinates come from

selection-hook reports logical points with a top-left origin on macOS, and physical pixels on Windows. The overlay converts Windows pixels with the monitor's scale factor, places the toolbar below the selection (or above it when there is more room above), and keeps every card inside the visible area of its display on both axes, as it grows and after a drag. On macOS it converts to Cocoa coordinates (origin at the primary display's bottom-left) only when setting the panel frame. On Windows with displays at different scale factors this conversion is not right yet (see the README's known limitations).
