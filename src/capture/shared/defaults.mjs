// Defaults the Host and the capture worker must agree on.

/**
 * The capture shortcut: Alt+D, the same keys on macOS (⌥D) and Windows, D for DSH. It is
 * registered with the system, so it reaches only the capture: on macOS it no longer types
 * "∂", and on Windows browsers no longer move to the address bar on it (Ctrl+L still does).
 * No common screenshot tool or system shortcut uses it.
 */
export const DEFAULT_HOTKEY = 'Alt+D'
