# Changelog

## 0.1.0 (unreleased)

- First release: toolbar with ⋯ menu, result panel with streaming Markdown, Ask DSH chat, read aloud, search.
- Built-in skills: Translate, Summarize, Explain, Ask DSH, Read aloud, Copy, Polish, Search; custom prompt skills.
- Settings page inside DSH, in tabs: skill order and visibility, custom skills with a test run, trigger mode, languages, model choice and test, clipboard fallback, search engine, disabled apps, token usage per day, model and skill.
- Follow-up questions after every skill's answer.
- Model calls through DSH's own `llm` service (DeepSeek Flash preferred, thinking off). Ask DSH and custom skills tell the model which model is answering.
- macOS: non-activating overlay panel, no Dock icon, accessibility permission attributed to DeepSeek Harness.
- Windows: implemented, not yet tested on hardware.
