# Changelog

## 0.2.2 (2026-11-09)

- The settings page no longer has its own version and update row: DSH's Plugins page already shows the version and finds updates.

## 0.2.1 (2026-11-09)

- Hover works on macOS: resting the pointer on the mini icon opens its menu, and buttons light up under the pointer. macOS sends no mouse moves to the window of a background process, so while the toolbar shows, the worker passes the pointer on from its global mouse hook.
- The follow-up box lines up with its send button before anything is typed.
- The settings page shows the installed version and updates the plugin in one click (General → Version), through DSH's own plugin manager, as its Plugins page does.

## 0.2.0 (2026-11-09)

- New icon, drawn for the plugin in the colours of DSH's own plugin icons: a selection frame around a spark. It marks the plugin, its sidebar entry and the mini toolbar.
- Mini toolbar: a single icon whose menu, opened by resting the pointer on it, holds every skill. Switch between it and the full toolbar from the toolbar's menu or the settings page.
- Windows: no border around the toolbar and its panels; the system shadow tao gave the transparent window is off.
- The follow-up box never shows a scrollbar (Windows drew one with arrow buttons); past four lines it still scrolls.

## 0.1.0 (2026-11-06)

- First release: toolbar with ⋯ menu, result panel with streaming Markdown, Ask DSH chat, read aloud, search.
- Built-in skills: Translate, Summarize, Explain, Ask DSH, Read aloud, Copy, Polish, Search; custom prompt skills.
- Settings page inside DSH, in tabs: skill order and visibility, custom skills with a test run, trigger mode, languages, model choice and test, clipboard fallback, search engine, disabled apps, token usage per day, model and skill.
- Follow-up questions after every skill's answer.
- Model calls through DSH's own `llm` service (DeepSeek Flash preferred, thinking off). Ask DSH and custom skills tell the model which model is answering.
- macOS: non-activating overlay panel, no Dock icon, accessibility permission attributed to DeepSeek Harness.
- Windows: implemented, not yet tested on hardware.
