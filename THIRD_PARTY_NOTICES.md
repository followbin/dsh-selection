# Third-party notices

dsh-selection ships or depends on the following software. Each is used under its own license.

| Component | Use | License | Copyright |
| --- | --- | --- | --- |
| [selection-hook](https://github.com/0xfullex/selection-hook) 2.1.2 | Vendored in `vendor/selection-hook` (JavaScript loader and N-API prebuilds for macOS and Windows): global input hooks and reading the selected text | MIT | © 2025 0xfullex |
| [@webviewjs/webview](https://github.com/webviewjs/webview) 0.6.0 | npm dependency: system web view windows (built on tao and wry) | MIT | © 2024 Twilight |
| [koffi](https://koffi.dev/) 3.3.6 (`@koromix/koffi-*` platform packages) | npm dependency: calling macOS and Windows system APIs | MIT | © 2026 Niels Martignène |
| [Lucide](https://lucide.dev/) icons | Path data copied into `src/shared/icons.mjs`, `client.js` and `icon.svg` | ISC (portions MIT, from Feather) | © Lucide Contributors 2022; portions © Cole Bemis 2013–2022 |

The full MIT text for selection-hook is in `vendor/selection-hook/LICENSE`; the other packages include their license files in `node_modules`.

## Lucide license

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
