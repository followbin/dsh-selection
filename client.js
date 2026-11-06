// Client half: the settings page inside DSH, plus the sidebar entry that opens it.
// A plain module for DSH's module loader (no build step); talks to the Host over /dsh-selection/api.
window.__ModuleLoader__.load({
  id: 'dsh-selection',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dshSelection'
    const PANEL_ID = 'dsh-selection'
    const API = '/dsh-selection/api'
    const SAVE_DELAY_MS = 350
    // How long "Saved" replaces the worker status in the header.
    const SAVED_NOTICE_MS = 2000

    const zh = {
      'title': '划词助手',
      'subtitle': '在任意应用里选中文字，就能用 DSH 翻译、总结、解释、追问或朗读。',
      'status.running': '运行中',
      'status.starting': '启动中',
      'status.restarting': '正在重启',
      'status.stopped': '未运行',
      'status.failed': '启动失败，可点「重启划词进程」再试',
      'status.unsupported': '仅支持 DSH 桌面版（macOS、Windows）',
      'status.saving': '保存中…',
      'status.saved': '已保存',
      'status.saveFailed': '保存失败：',
      'status.actionFailed': '操作失败：',
      'status.offline': '连不上 DSH Host：',
      'permission.title': '需要辅助功能权限',
      'permission.body': '在「系统设置 → 隐私与安全性 → 辅助功能」里打开 DeepSeek Harness，划词助手才能读到选中的文字。授权后会自动生效。',
      'permission.open': '打开系统设置',
      'enabled.label': '选中文字时显示工具栏',
      'enabled.hint': '关掉后划词助手不会再弹出，设置保留。',
      'skills.title': '技能',
      'skills.hint': '前 {count} 个启用的技能显示在工具栏上，其余收进 ⋯ 菜单。拖动或用方向键调整顺序。',
      'skills.overflow': '以下收进 ⋯ 菜单',
      'skills.custom': '自定义',
      'skills.add': '新建技能',
      'skills.edit': '编辑',
      'skills.delete': '删除',
      'skills.deleteConfirm': '删除技能「{name}」？',
      'skills.move': '拖动或按 ↑ ↓ 调整顺序',
      'editor.titleNew': '新建技能',
      'editor.titleEdit': '编辑技能',
      'editor.name': '名称',
      'editor.namePlaceholder': '例如：整理成表格',
      'editor.icon': '图标',
      'editor.prompt': '指令',
      'editor.promptPlaceholder': '例如：把这段内容整理成 Markdown 表格，列出要点和对应说明。',
      'editor.promptHint': '选中的文字会单独发给模型，不需要写进指令里；需要指定位置时可以写 {{text}}。',
      'editor.try': '试一试',
      'editor.sample': '示例文字',
      'editor.samplePlaceholder': '粘贴一段文字，看看这个技能的效果',
      'editor.run': '运行',
      'editor.running': '运行中…',
      'editor.save': '保存',
      'editor.cancel': '取消',
      'toolbar.title': '工具栏',
      'toolbar.trigger': '弹出方式',
      'toolbar.trigger.auto': '选中文字后自动弹出',
      'toolbar.trigger.modifier': '按住 ⌥ / Alt 选中时才弹出',
      'toolbar.size': '工具栏上的技能数',
      'language.title': '语言',
      'language.native': '我的母语',
      'language.translate': '翻译成',
      'language.translate.auto': '自动（母语和英文互译）',
      'language.answer': '总结、解释和回答使用',
      'language.answer.native': '我的母语',
      'language.answer.source': '和原文相同的语言',
      'model.title': '模型',
      'model.route': '使用的模型',
      'model.auto': '自动（优先 DeepSeek Flash）',
      'model.current': '当前使用：{route}',
      'model.none': 'DSH 里还没有可用的模型，请先在 DSH 设置中登录或填写 API Key。',
      'model.test': '测试',
      'model.testing': '测试中…',
      'model.testOk': '{route} 可用，用时 {ms} 毫秒：{output}',
      'model.hint': '模型请求走 DSH 自己的账号或 API Key，关闭思考以加快速度；追问会带上同一个面板里之前的问答。',
      'model.error': '读不到模型列表：{error}',
      'capture.title': '取词',
      'capture.clipboard': '读不到选区时用复制兜底',
      'capture.clipboardHint': '有些应用不提供选中文字，这时会模拟一次复制，之后恢复你原来的剪贴板。',
      'capture.max': '最多发送的字数',
      'search.title': '搜索',
      'search.engine': '搜索引擎',
      'search.custom': '自定义',
      'search.customUrl': '搜索地址',
      'search.customHint': '用 %s 表示要搜索的文字，例如 https://example.com/search?q=%s',
      'search.invalid': '地址要以 http:// 或 https:// 开头，并包含 %s。',
      'apps.title': '不在这些应用里弹出',
      'apps.empty': '还没有禁用的应用。也可以在工具栏的 ⋯ 菜单里选「在此应用中禁用」。',
      'apps.add': '添加',
      'apps.placeholder': '应用名称，和工具栏显示的「来自 …」一致',
      'apps.recent': '最近划词的应用：',
      'apps.remove': '移除',
      'footer.reset': '恢复默认设置',
      'footer.resetConfirm': '恢复全部默认设置？自定义技能会被删除。',
      'footer.restart': '重启划词进程',
      'footer.data': '设置保存在 DSH 数据目录下的 selection/settings.json',
      'tab.general': '常规',
      'tab.skills': '技能',
      'tab.model': '模型',
      'tab.capture': '取词与搜索',
      'tab.apps': '应用',
      'tab.usage': '用量',
      'failure.NO_LLM': 'DSH 的模型服务还没就绪',
      'failure.NO_MODEL': '还没有可用的模型',
      'failure.MODEL_FAILED': '模型调用失败',
      'failure.EMPTY': '模型没有返回内容',
      'failure.TIMEOUT': '模型太久没有回应',
      'failure.detail': '{message}：{detail}',
      'usage.loading': '正在读取用量…',
      'usage.period': '统计范围',
      'usage.period.today': '今天',
      'usage.period.week': '近 7 天',
      'usage.period.month': '近 30 天',
      'usage.period.all': '全部',
      'usage.requests': '请求',
      'usage.input': '输入 tokens',
      'usage.output': '输出 tokens',
      'usage.cacheRead': '缓存命中 tokens',
      'usage.reasoning': '推理 tokens',
      'usage.byModel': '按模型',
      'usage.bySkill': '按技能',
      'usage.model': '模型',
      'usage.skill': '技能',
      'usage.none': '这段时间还没有用量',
      'usage.modelTest': '模型测试',
      'usage.skillTest': '技能试运行',
      'usage.removedSkill': '已删除的技能',
      'usage.since': '从 {day} 开始统计，保留最近 90 天；只记数字，不记文字。',
      'usage.privacy': '用量只记数字，不记文字，保留最近 90 天。',
      'usage.reset': '清空用量',
      'usage.resetConfirm': '清空所有用量记录？',
      'error.render': '设置页渲染失败：',
    }
    const en = {
      'title': 'Selection assistant',
      'subtitle': 'Select text in any app to translate, summarize, explain, ask about or read it with DSH.',
      'status.running': 'Running',
      'status.starting': 'Starting',
      'status.restarting': 'Restarting',
      'status.stopped': 'Not running',
      'status.failed': 'Failed to start; use Restart the assistant to try again',
      'status.unsupported': 'Only available in DSH Desktop (macOS, Windows)',
      'status.saving': 'Saving…',
      'status.saved': 'Saved',
      'status.saveFailed': 'Save failed: ',
      'status.actionFailed': 'Action failed: ',
      'status.offline': 'Cannot reach the DSH Host: ',
      'permission.title': 'Accessibility permission needed',
      'permission.body': 'Turn on DeepSeek Harness in System Settings → Privacy & Security → Accessibility so the assistant can read selected text. It starts working as soon as you allow it.',
      'permission.open': 'Open System Settings',
      'enabled.label': 'Show the toolbar when text is selected',
      'enabled.hint': 'Turning this off hides the assistant and keeps your settings.',
      'skills.title': 'Skills',
      'skills.hint': 'The first {count} enabled skills sit on the toolbar; the rest go into the ⋯ menu. Drag or use the arrow keys to reorder.',
      'skills.overflow': 'In the ⋯ menu',
      'skills.custom': 'Custom',
      'skills.add': 'New skill',
      'skills.edit': 'Edit',
      'skills.delete': 'Delete',
      'skills.deleteConfirm': 'Delete the skill “{name}”?',
      'skills.move': 'Drag, or press ↑ ↓ to reorder',
      'editor.titleNew': 'New skill',
      'editor.titleEdit': 'Edit skill',
      'editor.name': 'Name',
      'editor.namePlaceholder': 'e.g. Make a table',
      'editor.icon': 'Icon',
      'editor.prompt': 'Instructions',
      'editor.promptPlaceholder': 'e.g. Turn this into a Markdown table of key points and explanations.',
      'editor.promptHint': 'The selected text is sent to the model separately, so you do not need to include it. Write {{text}} to place it yourself.',
      'editor.try': 'Try it',
      'editor.sample': 'Sample text',
      'editor.samplePlaceholder': 'Paste some text to see what the skill does',
      'editor.run': 'Run',
      'editor.running': 'Running…',
      'editor.save': 'Save',
      'editor.cancel': 'Cancel',
      'toolbar.title': 'Toolbar',
      'toolbar.trigger': 'Show the toolbar',
      'toolbar.trigger.auto': 'Automatically after selecting text',
      'toolbar.trigger.modifier': 'Only while holding ⌥ / Alt during selection',
      'toolbar.size': 'Skills on the toolbar',
      'language.title': 'Language',
      'language.native': 'My language',
      'language.translate': 'Translate into',
      'language.translate.auto': 'Auto (between my language and English)',
      'language.answer': 'Summaries, explanations and answers in',
      'language.answer.native': 'My language',
      'language.answer.source': 'The language of the selected text',
      'model.title': 'Model',
      'model.route': 'Model',
      'model.auto': 'Auto (prefers DeepSeek Flash)',
      'model.current': 'Currently using {route}',
      'model.none': 'No model is set up in DSH yet. Sign in or add an API key in DSH settings.',
      'model.test': 'Test',
      'model.testing': 'Testing…',
      'model.testOk': '{route} works, {ms} ms: {output}',
      'model.hint': 'Requests use DSH’s own account or API key, with thinking off for speed. Follow-up questions carry the earlier turns of the same panel.',
      'model.error': 'Could not list the models: {error}',
      'capture.title': 'Capture',
      'capture.clipboard': 'Fall back to copying when the selection cannot be read',
      'capture.clipboardHint': 'Some apps do not expose selected text; the assistant then simulates a copy and restores your clipboard afterwards.',
      'capture.max': 'Maximum characters sent',
      'search.title': 'Search',
      'search.engine': 'Search engine',
      'search.custom': 'Custom',
      'search.customUrl': 'Search URL',
      'search.customHint': 'Use %s for the search text, e.g. https://example.com/search?q=%s',
      'search.invalid': 'Use an http:// or https:// address that contains %s.',
      'apps.title': 'Never show in these apps',
      'apps.empty': 'No apps disabled. You can also choose “Disable in this app” from the toolbar’s ⋯ menu.',
      'apps.add': 'Add',
      'apps.placeholder': 'App name, as shown after “from” on the toolbar',
      'apps.recent': 'Recently used:',
      'apps.remove': 'Remove',
      'footer.reset': 'Restore defaults',
      'footer.resetConfirm': 'Restore all default settings? Custom skills will be deleted.',
      'footer.restart': 'Restart the assistant',
      'footer.data': 'Settings are stored in selection/settings.json under the DSH data directory',
      'tab.general': 'General',
      'tab.skills': 'Skills',
      'tab.model': 'Model',
      'tab.capture': 'Capture & search',
      'tab.apps': 'Apps',
      'tab.usage': 'Usage',
      'failure.NO_LLM': 'DSH’s model service is not ready yet',
      'failure.NO_MODEL': 'No model is available',
      'failure.MODEL_FAILED': 'The model call failed',
      'failure.EMPTY': 'The model returned nothing',
      'failure.TIMEOUT': 'The model took too long to answer',
      'failure.detail': '{message}: {detail}',
      'usage.loading': 'Reading usage…',
      'usage.period': 'Period',
      'usage.period.today': 'Today',
      'usage.period.week': 'Last 7 days',
      'usage.period.month': 'Last 30 days',
      'usage.period.all': 'All',
      'usage.requests': 'Requests',
      'usage.input': 'Input tokens',
      'usage.output': 'Output tokens',
      'usage.cacheRead': 'Cached input tokens',
      'usage.reasoning': 'Reasoning tokens',
      'usage.byModel': 'By model',
      'usage.bySkill': 'By skill',
      'usage.model': 'Model',
      'usage.skill': 'Skill',
      'usage.none': 'No usage in this period yet',
      'usage.modelTest': 'Model test',
      'usage.skillTest': 'Skill trial run',
      'usage.removedSkill': 'Deleted skill',
      'usage.since': 'Counted since {day}, last 90 days kept; numbers only, never text.',
      'usage.privacy': 'Usage keeps numbers only, never text, for the last 90 days.',
      'usage.reset': 'Clear usage',
      'usage.resetConfirm': 'Clear all usage records?',
      'error.render': 'The settings page failed to render: ',
    }
    const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))

    const css = `
      .dss-root { flex: 1; min-height: 0; height: 100%; overflow-y: auto; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
      .dss-page { max-width: 760px; margin: 0 auto; padding: calc(24px + var(--dsh-frame-top-clearance, 0px)) 24px 48px; }
      .dss-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .dss-title { font-size: 20px; font-weight: 500; line-height: 28px; }
      .dss-sub { margin-top: 2px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .dss-state { display: inline-flex; align-items: center; gap: 6px; flex: none; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dss-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #999); }
      .dss-dot[data-state="running"] { background: var(--dsw-alias-state-success-primary, #1f9d55); }
      .dss-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #d4302b); }
      .dss-section { margin-top: 28px; }
      .dss-section-title { font-size: 15px; font-weight: 600; line-height: 22px; }
      .dss-section-hint { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dss-card { margin-top: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .dss-row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 10px 16px; }
      .dss-row + .dss-row { border-top: 1px solid var(--dsw-alias-border-l1); }
      .dss-row-main { flex: 1; min-width: 0; }
      .dss-label { font-size: 13.5px; line-height: 20px; }
      .dss-hint { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dss-banner { display: flex; gap: 12px; align-items: flex-start; margin-top: 16px; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-state-warn-primary, #d98e04); background: var(--dsw-alias-bg-layer-1); }
      .dss-banner strong { display: block; font-size: 13.5px; font-weight: 600; }
      .dss-banner p { margin: 2px 0 0; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-secondary); }
      .dss-error { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #d4302b); }
      .dss-invalid { color: var(--dsw-alias-state-error-primary, #d4302b); }
      .dss-tabs { position: sticky; top: var(--dsh-frame-top-clearance, 0px); z-index: 1; display: flex; gap: 4px; margin: 20px 0 0; padding: 8px 0; overflow-x: auto; background: var(--dsw-alias-bg-base); border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dss-tab { flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
      .dss-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dss-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
      .dss-tab:focus-visible, .dss-segmented button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .dss-tabpanel[hidden] { display: none; }
      .dss-segmented { display: inline-flex; gap: 2px; margin-top: 20px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
      .dss-segmented button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px; cursor: pointer; }
      .dss-segmented button[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
      .dss-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-top: 12px; }
      .dss-tile { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .dss-tile-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .dss-tile-label { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dss-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .dss-table th, .dss-table td { padding: 9px 16px; text-align: right; border-top: 1px solid var(--dsw-alias-border-l1); font-variant-numeric: tabular-nums; }
      .dss-table th:first-child, .dss-table td:first-child { text-align: left; }
      .dss-table thead th { border-top: 0; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
      .dss-table td.dss-table-empty { text-align: left; color: var(--dsw-alias-label-secondary); }
      .dss-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
      .dss-button:hover { background: var(--dsw-alias-bg-layer-2); }
      .dss-button:disabled { opacity: 0.5; cursor: default; }
      .dss-button.primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
      .dss-button.primary:hover { filter: brightness(1.06); }
      .dss-button.quiet { border-color: transparent; background: none; color: var(--dsw-alias-label-secondary); }
      .dss-button.quiet:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dss-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .dss-icon-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dss-icon-button:focus-visible, .dss-button:focus-visible, .dss-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dss-svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
      .dss-switch { position: relative; flex: none; width: 40px; height: 24px; border: 0; border-radius: 12px; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background 0.15s; }
      .dss-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.2); transition: transform 0.15s; }
      .dss-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .dss-switch[aria-checked="true"]::after { transform: translateX(16px); }
      .dss-select, .dss-input, .dss-textarea { height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
      .dss-select { max-width: 280px; }
      .dss-input { width: 100%; }
      .dss-number { width: 88px; }
      .dss-textarea { width: 100%; height: auto; min-height: 84px; padding: 8px 10px; line-height: 1.55; resize: vertical; }
      .dss-select:focus, .dss-input:focus, .dss-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .dss-skill { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 12px 6px 6px; background: var(--dsw-alias-bg-layer-1); }
      .dss-skill + .dss-skill, .dss-overflow + .dss-skill { border-top: 1px solid var(--dsw-alias-border-l1); }
      .dss-skill[data-dragging="true"] { opacity: 0.4; }
      .dss-skill[data-drop="before"] { box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary); }
      .dss-skill[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); }
      .dss-skill[data-enabled="false"] .dss-skill-name, .dss-skill[data-enabled="false"] .dss-skill-icon { opacity: 0.45; }
      .dss-grip { cursor: grab; }
      .dss-skill-icon { display: inline-flex; color: var(--dsw-alias-label-primary); }
      .dss-skill-name { flex: 1; min-width: 0; font-size: 13.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .dss-tag { margin-left: 8px; padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
      .dss-overflow { padding: 6px 16px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-top: 1px solid var(--dsw-alias-border-l1); }
      .dss-actions { display: flex; gap: 8px; margin-top: 10px; }
      .dss-editor { margin-top: 10px; padding: 16px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .dss-editor h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
      .dss-field + .dss-field { margin-top: 14px; }
      .dss-field-label { display: block; margin-bottom: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
      .dss-icons { display: flex; flex-wrap: wrap; gap: 6px; }
      .dss-icon-choice { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .dss-icon-choice[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
      .dss-output { margin-top: 8px; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
      .dss-output.error { color: var(--dsw-alias-state-error-primary, #d4302b); }
      .dss-chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
      .dss-chip { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 4px 0 12px; border-radius: 15px; background: var(--dsw-alias-bg-layer-2); font-size: 12.5px; }
      .dss-chip .dss-icon-button { width: 24px; height: 24px; border-radius: 12px; }
      .dss-chip.suggest { padding: 0 12px; border: 1px dashed var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12.5px; }
      .dss-chip.suggest:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
      .dss-empty { padding: 14px 16px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
      .dss-inline { display: flex; gap: 8px; padding: 0 16px 14px; }
      .dss-recent { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 16px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dss-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 28px; }
      .dss-footer .dss-hint { flex-basis: 100%; }
    `

    // ---------- Host connection ----------

    async function request(path, init) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        ...init,
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload
    }

    // One server-sent-events connection per client, shared by the page and the navigation listener.
    // Read through fetch (like the whistle-agent panel) so it works through Desktop's request bridge.
    const events = (() => {
      const listeners = new Set()
      let controller = null
      let retry = 1000
      async function connect() {
        // Each connection checks its own controller: after a stop and start the shared one is a newer one.
        const own = new AbortController()
        controller = own
        try {
          const response = await fetch(`${API}/events`, { cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: own.signal })
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
          retry = 1000
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              let event = 'message'
              let data = ''
              for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim()
                else if (line.startsWith('data:')) data += line.slice(5).trim()
              }
              if (!data) continue
              let parsed = null
              try {
                parsed = JSON.parse(data)
              } catch {
                continue
              }
              for (const listener of listeners) listener(event, parsed)
            }
          }
        } catch (error) {
          if (own.signal.aborted) return
        }
        if (own.signal.aborted) return
        setTimeout(() => { if (!own.signal.aborted) void connect() }, retry)
        retry = Math.min(retry * 2, 30000)
      }
      return {
        start() {
          void connect()
          return () => controller && controller.abort()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    })()

    // ---------- Small components ----------

    function Svg({ markup, size }) {
      return h('svg', { className: 'dss-svg', viewBox: '0 0 24 24', 'aria-hidden': true, style: size ? { width: size, height: size } : undefined, dangerouslySetInnerHTML: { __html: markup || '' } })
    }

    function Switch({ checked, onChange, label }) {
      return h('button', { type: 'button', role: 'switch', className: 'dss-switch', 'aria-checked': String(Boolean(checked)), 'aria-label': label, onClick: () => onChange(!checked) })
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'dss-row' },
        h('div', { className: 'dss-row-main' }, h('div', { className: 'dss-label' }, label), hint ? h('div', { className: 'dss-hint' }, hint) : null),
        children)
    }

    function Section({ title, hint, children }) {
      return h('section', { className: 'dss-section' },
        h('div', { className: 'dss-section-title' }, title),
        hint ? h('div', { className: 'dss-section-hint' }, hint) : null,
        children)
    }

    function NumberInput({ value, min, max, onChange, label }) {
      const [draft, setDraft] = useState(String(value))
      useEffect(() => setDraft(String(value)), [value])
      const commit = () => {
        // A cleared or non-numeric field reads as '', which Number() would turn into 0.
        const number = draft.trim() === '' ? Number.NaN : Number(draft)
        const next = Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : value
        // The saved value may not change (a revert, or a clamp back to it), so the field resets here too.
        setDraft(String(next))
        if (next !== value) onChange(next)
      }
      return h('input', {
        className: 'dss-input dss-number', type: 'number', min, max, value: draft, 'aria-label': label,
        onChange: (event) => setDraft(event.target.value), onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') commit() },
      })
    }

    // Same rule as isSearchTemplate in src/host/settings.mjs, which drops any other value.
    function isSearchTemplate(value) {
      if (value.length > 500 || !value.includes('%s')) return false
      try {
        const url = new URL(value.replace('%s', 'x'))
        return url.protocol === 'https:' || url.protocol === 'http:'
      } catch {
        return false
      }
    }

    function SearchUrlRow({ t, settings, update }) {
      const [invalid, setInvalid] = useState(false)
      const commit = (event) => {
        const value = event.target.value.trim()
        const valid = !value || isSearchTemplate(value)
        setInvalid(!valid)
        // Tabbing through an unchanged field must not switch the engine.
        if (!valid || value === settings.customSearchUrl) return
        update(value
          ? { customSearchUrl: value, searchEngine: 'custom' }
          : { customSearchUrl: '', searchEngine: settings.searchEngine === 'custom' ? 'google' : settings.searchEngine })
      }
      const hint = invalid ? h('span', { className: 'dss-invalid', role: 'alert' }, t('search.invalid')) : t('search.customHint')
      return h(Row, { label: t('search.customUrl'), hint },
        h('input', {
          key: `search-url-${settings.customSearchUrl}`,
          className: 'dss-input', style: { maxWidth: 320 }, defaultValue: settings.customSearchUrl, placeholder: 'https://…%s',
          'aria-label': t('search.customUrl'), 'aria-invalid': invalid,
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
        }))
    }

    // ---------- Skills ----------

    function SkillList({ t, settings, catalog, update, onEdit }) {
      const [drag, setDrag] = useState(null)
      const builtins = useMemo(() => new Map(catalog.builtins.map((skill) => [skill.id, skill])), [catalog])
      // Built-in names follow DSH's interface language, which the bound dictionary already reflects.
      const locale = t('title') === zh.title ? 'zh' : 'en'
      const nameOf = (entry) => (entry.custom ? entry.name : builtins.get(entry.id).name[locale])
      const iconOf = (entry) => catalog.icons[entry.custom ? entry.icon : builtins.get(entry.id).icon]

      const move = (from, to) => {
        if (from === to || to < 0 || to >= settings.skills.length) return
        const skills = [...settings.skills]
        const [item] = skills.splice(from, 1)
        skills.splice(to, 0, item)
        update({ skills })
      }

      let enabledSeen = 0
      const rows = []
      settings.skills.forEach((entry, index) => {
        if (entry.enabled) enabledSeen += 1
        rows.push(h('div', {
          key: entry.id,
          className: 'dss-skill',
          'data-enabled': String(entry.enabled),
          'data-dragging': String(drag && drag.from === index),
          'data-drop': drag && drag.over === index && drag.from !== index ? (drag.from < index ? 'after' : 'before') : undefined,
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', entry.id)
            setDrag({ from: index, over: index })
          },
          onDragOver: (event) => {
            event.preventDefault()
            if (drag && drag.over !== index) setDrag({ ...drag, over: index })
          },
          onDrop: (event) => {
            event.preventDefault()
            if (drag) move(drag.from, index)
            setDrag(null)
          },
          onDragEnd: () => setDrag(null),
        },
        h('button', {
          type: 'button', className: 'dss-icon-button dss-grip', title: t('skills.move'), 'aria-label': t('skills.move'),
          onKeyDown: (event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); move(index, index - 1) }
            if (event.key === 'ArrowDown') { event.preventDefault(); move(index, index + 1) }
          },
        }, h(Svg, { markup: catalog.icons.grip })),
        h('span', { className: 'dss-skill-icon' }, h(Svg, { markup: iconOf(entry) })),
        h('span', { className: 'dss-skill-name' }, nameOf(entry), entry.custom ? h('span', { className: 'dss-tag' }, t('skills.custom')) : null),
        entry.custom ? h('button', { type: 'button', className: 'dss-icon-button', title: t('skills.edit'), 'aria-label': t('skills.edit'), onClick: () => onEdit(entry) }, h(Svg, { markup: catalog.icons.edit })) : null,
        entry.custom ? h('button', {
          type: 'button', className: 'dss-icon-button', title: t('skills.delete'), 'aria-label': t('skills.delete'),
          onClick: () => {
            if (window.confirm(fill(t('skills.deleteConfirm'), { name: entry.name }))) update({ skills: settings.skills.filter((skill) => skill.id !== entry.id) })
          },
        }, h(Svg, { markup: catalog.icons.trash })) : null,
        h(Switch, {
          checked: entry.enabled, label: nameOf(entry),
          onChange: (enabled) => update({ skills: settings.skills.map((skill) => (skill.id === entry.id ? { ...skill, enabled } : skill)) }),
        })))
        if (entry.enabled && enabledSeen === settings.toolbarSize && index < settings.skills.length - 1) {
          rows.push(h('div', { key: '__overflow', className: 'dss-overflow' }, t('skills.overflow')))
        }
      })
      return h('div', { className: 'dss-card', style: { overflow: 'hidden' } }, rows)
    }

    function SkillEditor({ t, catalog, limits, initial, onSave, onCancel, prepare }) {
      const [name, setName] = useState(initial ? initial.name : '')
      const [icon, setIcon] = useState(initial ? initial.icon : 'sparkles')
      const [prompt, setPrompt] = useState(initial ? initial.prompt : '')
      const [sample, setSample] = useState('')
      const [trial, setTrial] = useState(null)
      const [running, setRunning] = useState(false)
      const valid = name.trim() && prompt.trim()

      const run = async () => {
        setRunning(true)
        setTrial(null)
        try {
          await prepare?.()
          setTrial(await request('/skills/test', { method: 'POST', body: JSON.stringify({ prompt, text: sample }) }))
        } catch (error) {
          setTrial({ ok: false, error: { code: 'MODEL_FAILED', detail: error.message } })
        } finally {
          setRunning(false)
        }
      }

      return h('div', { className: 'dss-editor' },
        h('h3', null, initial ? t('editor.titleEdit') : t('editor.titleNew')),
        h('div', { className: 'dss-field' },
          h('label', { className: 'dss-field-label' }, t('editor.name')),
          h('input', { className: 'dss-input', value: name, maxLength: limits.customName, placeholder: t('editor.namePlaceholder'), onChange: (event) => setName(event.target.value) })),
        h('div', { className: 'dss-field' },
          h('span', { className: 'dss-field-label' }, t('editor.icon')),
          h('div', { className: 'dss-icons' }, catalog.customIcons.map((key) => h('button', {
            key, type: 'button', className: 'dss-icon-choice', 'aria-pressed': String(icon === key), 'aria-label': key, onClick: () => setIcon(key),
          }, h(Svg, { markup: catalog.icons[key] }))))),
        h('div', { className: 'dss-field' },
          h('label', { className: 'dss-field-label' }, t('editor.prompt')),
          h('textarea', { className: 'dss-textarea', value: prompt, maxLength: limits.customPrompt, placeholder: t('editor.promptPlaceholder'), onChange: (event) => setPrompt(event.target.value) }),
          h('div', { className: 'dss-hint' }, t('editor.promptHint'))),
        h('div', { className: 'dss-field' },
          h('label', { className: 'dss-field-label' }, `${t('editor.try')} · ${t('editor.sample')}`),
          h('textarea', { className: 'dss-textarea', style: { minHeight: 60 }, value: sample, placeholder: t('editor.samplePlaceholder'), onChange: (event) => setSample(event.target.value) }),
          h('div', { className: 'dss-actions' },
            h('button', { type: 'button', className: 'dss-button', disabled: !prompt.trim() || !sample.trim() || running, onClick: run }, running ? t('editor.running') : t('editor.run'))),
          trial ? h('div', { className: `dss-output${trial.ok ? '' : ' error'}` }, trial.ok ? trial.output : failureText(t, trial.error)) : null),
        h('div', { className: 'dss-actions', style: { marginTop: 16 } },
          h('button', { type: 'button', className: 'dss-button primary', disabled: !valid, onClick: () => onSave({ name: name.trim(), icon, prompt: prompt.trim() }) }, t('editor.save')),
          h('button', { type: 'button', className: 'dss-button', onClick: onCancel }, t('editor.cancel'))))
    }

    // ---------- Failures and usage ----------

    const FAILURE_CODES = new Set(['NO_LLM', 'NO_MODEL', 'MODEL_FAILED', 'EMPTY', 'TIMEOUT'])

    /** The Host reports stable codes; people read the matching sentence, with the provider's words after it. */
    function failureText(t, failure) {
      const message = FAILURE_CODES.has(failure.code) ? t(`failure.${failure.code}`) : failure.code
      return failure.detail ? fill(t('failure.detail'), { message, detail: failure.detail }) : message
    }

    const PERIODS = ['today', 'week', 'month', 'all']

    function UsagePanel({ t, usage, settings, catalog, onReset }) {
      const [period, setPeriod] = useState('week')
      if (!usage) return h('div', { className: 'dss-empty' }, t('usage.loading'))
      const locale = t('title') === zh.title ? 'zh' : 'en'
      const number = (value) => value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')
      const builtins = new Map(catalog.builtins.map((skill) => [skill.id, skill]))
      const skillName = (id) => {
        if (id === 'model-test') return t('usage.modelTest')
        if (id === 'skill-test') return t('usage.skillTest')
        if (builtins.has(id)) return builtins.get(id).name[locale]
        return settings.skills.find((skill) => skill.id === id)?.name ?? t('usage.removedSkill')
      }
      const { totals, models, skills } = usage.periods[period]
      const tiles = [
        ['usage.requests', totals.requests],
        ['usage.input', totals.input],
        ['usage.output', totals.output],
        ...(totals.cacheRead ? [['usage.cacheRead', totals.cacheRead]] : []),
        ...(totals.reasoning ? [['usage.reasoning', totals.reasoning]] : []),
      ]
      const table = (title, rows, labelOf, keyOf) => h('div', { className: 'dss-card' },
        h('table', { className: 'dss-table' },
          h('thead', null, h('tr', null,
            h('th', null, title), h('th', null, t('usage.requests')), h('th', null, t('usage.input')), h('th', null, t('usage.output')))),
          h('tbody', null, rows.length
            ? rows.map((row) => h('tr', { key: keyOf(row) },
              h('td', null, labelOf(row)), h('td', null, number(row.requests)), h('td', null, number(row.input)), h('td', null, number(row.output))))
            : h('tr', null, h('td', { colSpan: 4, className: 'dss-table-empty' }, t('usage.none'))))))
      return h('div', null,
        h('div', { className: 'dss-segmented', role: 'group', 'aria-label': t('usage.period') },
          PERIODS.map((id) => h('button', { key: id, type: 'button', 'aria-pressed': String(period === id), onClick: () => setPeriod(id) }, t(`usage.period.${id}`)))),
        h('div', { className: 'dss-tiles' }, tiles.map(([key, value]) => h('div', { key, className: 'dss-tile' },
          h('div', { className: 'dss-tile-value' }, number(value)), h('div', { className: 'dss-tile-label' }, t(key))))),
        h(Section, { title: t('usage.byModel') },
          table(t('usage.model'), models, (row) => `${row.providerName} · ${row.modelName}`, (row) => `${row.provider}/${row.model}`)),
        h(Section, { title: t('usage.bySkill') },
          table(t('usage.skill'), skills, (row) => skillName(row.skill), (row) => row.skill)),
        h('div', { className: 'dss-actions' },
          h('button', { type: 'button', className: 'dss-button', onClick: onReset }, t('usage.reset')),
          h('div', { className: 'dss-hint' }, usage.since ? fill(t('usage.since'), { day: usage.since }) : t('usage.privacy'))))
    }

    // Grouped by what people come to change; the most used group first.
    const TABS = ['general', 'skills', 'model', 'capture', 'apps', 'usage']

    function Tabs({ t, tab, onSelect }) {
      // Arrow keys move between tabs, as screen readers expect of a tab list.
      const onKeyDown = (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]
        onSelect(next)
        event.currentTarget.querySelector(`#dss-tab-${next}`)?.focus()
      }
      return h('div', { className: 'dss-tabs', role: 'tablist', 'aria-label': t('title'), onKeyDown },
        TABS.map((id) => h('button', {
          key: id, id: `dss-tab-${id}`, type: 'button', role: 'tab', className: 'dss-tab',
          'aria-selected': String(tab === id), 'aria-controls': `dss-panel-${id}`, tabIndex: tab === id ? 0 : -1,
          onClick: () => onSelect(id),
        }, t(`tab.${id}`))))
    }

    // ---------- Page ----------

    function SettingsPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key
      const [state, setState] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [save, setSave] = useState({ phase: 'idle', error: null })
      const [editing, setEditing] = useState(null)
      const [models, setModels] = useState(null)
      const [modelTest, setModelTest] = useState(null)
      const [appDraft, setAppDraft] = useState('')
      const [tab, setTab] = useState('general')
      const [usage, setUsage] = useState(null)
      const pending = useRef(null)
      const timer = useRef(null)
      const savedTimer = useRef(null)
      const loaded = useRef(false)

      const load = useCallback(async () => {
        try {
          setState(await request('/state'))
          setLoadError(null)
          loaded.current = true
        } catch (error) {
          setLoadError(error.message)
        }
      }, [])

      const loadModels = useCallback(async () => {
        try {
          setModels(await request('/models'))
        } catch (error) {
          setModels({ routes: [], selected: null, error: { code: 'MODEL_FAILED', detail: error.message } })
        }
      }, [])

      const loadUsage = useCallback(async () => {
        try {
          setUsage(await request('/usage'))
        } catch {
          // The usage tab keeps showing "reading" and the next usage event fills it.
        }
      }, [])

      useEffect(() => { void load(); void loadModels(); void loadUsage() }, [load, loadModels, loadUsage])

      useEffect(() => events.subscribe((event, data) => {
        // The first load failed (Host not up yet); an event means it is reachable now.
        if (!loaded.current) return void load()
        if (event === 'status') {
          setState((current) => (current ? { ...current, status: data } : current))
          // A new toolbar state is news; "Saved" gives way to it at once.
          setSave((current) => (current.phase === 'saved' ? { phase: 'idle', error: null } : current))
        }
        // Changes made elsewhere (e.g. "disable in this app") arrive here; fields being edited locally win.
        if (event === 'settings') setState((current) => (current ? { ...current, settings: { ...data, ...pending.current } } : current))
        if (event === 'usage') setUsage(data)
      }), [load])

      // Only the changed fields go to the Host, which merges them into its current settings, so a
      // concurrent change from the toolbar is never overwritten by a stale copy of the whole object.
      const flush = useCallback(async () => {
        const patch = pending.current
        if (!patch) return
        pending.current = null
        setSave({ phase: 'saving', error: null })
        try {
          const { settings } = await request('/settings', { method: 'PUT', body: JSON.stringify(patch) })
          setState((current) => ({ ...current, settings: { ...settings, ...pending.current } }))
          setSave({ phase: 'saved', error: null })
          clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(() => setSave((current) => (current.phase === 'saved' ? { phase: 'idle', error: null } : current)), SAVED_NOTICE_MS)
        } catch (error) {
          setSave({ phase: 'error', error: error.message })
          void load()
        }
      }, [load])

      const update = useCallback((patch) => {
        pending.current = { ...pending.current, ...patch }
        setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }))
        clearTimeout(timer.current)
        timer.current = setTimeout(() => { void flush() }, SAVE_DELAY_MS)
      }, [flush])

      // Tests run against the saved settings, so a change still waiting for the debounce goes first.
      const saveNow = useCallback(async () => {
        clearTimeout(timer.current)
        await flush()
      }, [flush])

      // Buttons that only fire a request: failures surface next to the save status.
      const act = useCallback((path, then) => {
        request(path, { method: 'POST', body: '{}' })
          .then((payload) => then?.(payload))
          .catch((error) => setSave({ phase: 'error', error: error.message, action: true }))
      }, [])

      useEffect(() => () => {
        clearTimeout(timer.current)
        clearTimeout(savedTimer.current)
        void flush()
      }, [flush])

      if (!state) {
        return h('div', { className: 'dss-root' }, h('style', null, css),
          h('div', { className: 'dss-page' }, h('div', { className: 'dss-title' }, t('title')),
            loadError ? h('div', { className: 'dss-error' }, t('status.offline') + loadError) : null))
      }

      const { settings, status, catalog, recentApps } = state
      const limits = catalog.limits
      const statusKey = !status.supported ? 'status.unsupported' : `status.${status.worker}`
      const saveText = save.phase === 'saving' ? t('status.saving') : save.phase === 'saved' ? t('status.saved') : save.phase === 'error' ? t(save.action ? 'status.actionFailed' : 'status.saveFailed') + save.error : null
      const routeLabel = (route) => `${route.providerName} · ${route.modelName}`
      const selectedRoute = settings.model.provider && settings.model.model ? `${settings.model.provider}\u0000${settings.model.model}` : ''

      const saveSkill = (draft) => {
        if (editing && editing.id) {
          update({ skills: settings.skills.map((skill) => (skill.id === editing.id ? { ...skill, ...draft } : skill)) })
        } else {
          update({ skills: [...settings.skills, { id: `custom-${Math.random().toString(36).slice(2, 10)}`, custom: true, enabled: true, ...draft }] })
        }
        setEditing(null)
      }

      const addApp = (app) => {
        const name = app.trim()
        if (!name || settings.disabledApps.includes(name)) return
        update({ disabledApps: [...settings.disabledApps, name] })
        setAppDraft('')
      }

      const panel = (id, ...children) => h('div', {
        key: id, id: `dss-panel-${id}`, role: 'tabpanel', className: 'dss-tabpanel', 'aria-labelledby': `dss-tab-${id}`, hidden: tab !== id,
      }, ...children)

      return h('div', { className: 'dss-root' }, h('style', null, css),
        h('div', { className: 'dss-page' },
          h('div', { className: 'dss-head' },
            h('div', null, h('div', { className: 'dss-title' }, t('title')), h('div', { className: 'dss-sub' }, t('subtitle'))),
            h('div', { className: 'dss-state' },
              h('span', { className: 'dss-dot', 'data-state': !status.supported ? 'idle' : status.worker === 'running' ? 'running' : status.worker === 'restarting' || status.worker === 'failed' ? 'error' : 'idle' }),
              saveText || t(statusKey))),

          status.supported && status.permission === 'denied'
            ? h('div', { className: 'dss-banner' },
              h('div', { style: { flex: 1 } }, h('strong', null, t('permission.title')), h('p', null, t('permission.body'))),
              h('button', { type: 'button', className: 'dss-button primary', onClick: () => act('/permission/open') }, t('permission.open')))
            : null,

          h(Tabs, { t, tab, onSelect: setTab }),

          panel('general',
            h('div', { className: 'dss-card', style: { marginTop: 20 } },
              h(Row, { label: t('enabled.label'), hint: t('enabled.hint') }, h(Switch, { checked: settings.enabled, label: t('enabled.label'), onChange: (enabled) => update({ enabled }) }))),
            h(Section, { title: t('toolbar.title') },
            h('div', { className: 'dss-card' },
              h(Row, { label: t('toolbar.trigger') },
                h('select', { className: 'dss-select', value: settings.trigger, onChange: (event) => update({ trigger: event.target.value }) },
                  h('option', { value: 'auto' }, t('toolbar.trigger.auto')),
                  h('option', { value: 'modifier' }, t('toolbar.trigger.modifier')))),
              h(Row, { label: t('toolbar.size') },
                h(NumberInput, { value: settings.toolbarSize, min: limits.toolbarSize.min, max: limits.toolbarSize.max, label: t('toolbar.size'), onChange: (toolbarSize) => update({ toolbarSize }) })))),
            h(Section, { title: t('language.title') },
            h('div', { className: 'dss-card' },
              h(Row, { label: t('language.native') },
                h('select', { className: 'dss-select', value: settings.nativeLanguage, onChange: (event) => update({ nativeLanguage: event.target.value }) },
                  catalog.languages.map((language) => h('option', { key: language.code, value: language.code }, language.name)))),
              h(Row, { label: t('language.translate') },
                h('select', { className: 'dss-select', value: settings.translateTarget, onChange: (event) => update({ translateTarget: event.target.value }) },
                  h('option', { value: 'auto' }, t('language.translate.auto')),
                  catalog.languages.map((language) => h('option', { key: language.code, value: language.code }, language.name)))),
              h(Row, { label: t('language.answer') },
                h('select', { className: 'dss-select', value: settings.answerLanguage, onChange: (event) => update({ answerLanguage: event.target.value }) },
                  h('option', { value: 'native' }, t('language.answer.native')),
                  h('option', { value: 'source' }, t('language.answer.source')),
                  catalog.languages.map((language) => h('option', { key: language.code, value: language.code }, language.name))))))),

          panel('skills',
            h(Section, { title: t('skills.title'), hint: fill(t('skills.hint'), { count: settings.toolbarSize }) },
            h(SkillList, { t, settings, catalog, update, onEdit: (entry) => setEditing(entry) }),
            editing
              ? h(SkillEditor, { key: editing.id || 'new', t, catalog, limits, initial: editing.id ? editing : null, onSave: saveSkill, onCancel: () => setEditing(null), prepare: saveNow })
              : h('div', { className: 'dss-actions' },
                h('button', { type: 'button', className: 'dss-button', onClick: () => setEditing({}) }, h(Svg, { markup: catalog.icons.plus }), t('skills.add'))))),

          panel('model',
            h(Section, { title: t('model.title'), hint: t('model.hint') },
            h('div', { className: 'dss-card' },
              h(Row, {
                label: t('model.route'),
                hint: models && models.error ? fill(t('model.error'), { error: failureText(t, models.error) })
                  : models && models.routes.length === 0 ? t('model.none')
                    : models && models.selected ? fill(t('model.current'), { route: routeLabel(models.selected) }) : null,
              },
              h('select', {
                className: 'dss-select', value: selectedRoute,
                onChange: (event) => {
                  const [provider, model] = event.target.value ? event.target.value.split('\u0000') : ['', '']
                  update({ model: { provider, model } })
                  setModelTest(null)
                  setTimeout(() => void loadModels(), SAVE_DELAY_MS + 200)
                },
              },
              h('option', { value: '' }, t('model.auto')),
              (models ? models.routes : []).map((route) => h('option', { key: `${route.provider}/${route.model}`, value: `${route.provider}\u0000${route.model}` }, routeLabel(route)))),
              h('button', {
                type: 'button', className: 'dss-button', disabled: modelTest && modelTest.running,
                onClick: async () => {
                  setModelTest({ running: true })
                  try {
                    await saveNow()
                    setModelTest(await request('/models/test', { method: 'POST', body: '{}' }))
                  } catch (error) {
                    setModelTest({ ok: false, error: { code: 'MODEL_FAILED', detail: error.message } })
                  }
                },
              }, modelTest && modelTest.running ? t('model.testing') : t('model.test'))),
              modelTest && !modelTest.running
                ? h('div', { style: { padding: '0 16px 14px' } }, h('div', { className: `dss-output${modelTest.ok ? '' : ' error'}` },
                  modelTest.ok
                    ? fill(t('model.testOk'), { route: modelTest.route ? routeLabel(modelTest.route) : '', ms: modelTest.ms, output: modelTest.output.trim() })
                    : failureText(t, modelTest.error)))
                : null))),

          panel('capture',
            h(Section, { title: t('capture.title') },
            h('div', { className: 'dss-card' },
              h(Row, { label: t('capture.clipboard'), hint: t('capture.clipboardHint') },
                h(Switch, { checked: settings.clipboardFallback, label: t('capture.clipboard'), onChange: (clipboardFallback) => update({ clipboardFallback }) })),
              h(Row, { label: t('capture.max') },
                h(NumberInput, { value: settings.maxTextLength, min: limits.maxTextLength.min, max: limits.maxTextLength.max, label: t('capture.max'), onChange: (maxTextLength) => update({ maxTextLength }) })))),
            h(Section, { title: t('search.title') },
            h('div', { className: 'dss-card' },
              h(Row, { label: t('search.engine') },
                h('select', { className: 'dss-select', value: settings.searchEngine, onChange: (event) => update({ searchEngine: event.target.value }) },
                  Object.keys(catalog.searchEngines).map((key) => h('option', { key, value: key }, ({ google: 'Google', bing: 'Bing', baidu: '百度 Baidu', duckduckgo: 'DuckDuckGo' })[key] || key)),
                  h('option', { value: 'custom', disabled: !settings.customSearchUrl && settings.searchEngine !== 'custom' }, t('search.custom')))),
              h(SearchUrlRow, { t, settings, update })))),

          panel('apps',
            h(Section, { title: t('apps.title') },
            h('div', { className: 'dss-card' },
              settings.disabledApps.length
                ? h('div', { className: 'dss-chips' }, settings.disabledApps.map((app) => h('span', { key: app, className: 'dss-chip' }, app,
                  h('button', { type: 'button', className: 'dss-icon-button', 'aria-label': `${t('apps.remove')} ${app}`, onClick: () => update({ disabledApps: settings.disabledApps.filter((item) => item !== app) }) },
                    h(Svg, { markup: catalog.icons.close, size: 14 })))))
                : h('div', { className: 'dss-empty' }, t('apps.empty')),
              h('div', { className: 'dss-inline' },
                h('input', { className: 'dss-input', value: appDraft, placeholder: t('apps.placeholder'), onChange: (event) => setAppDraft(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') addApp(appDraft) } }),
                h('button', { type: 'button', className: 'dss-button', disabled: !appDraft.trim(), onClick: () => addApp(appDraft) }, t('apps.add'))),
              recentApps.filter((app) => !settings.disabledApps.includes(app)).length
                ? h('div', { className: 'dss-recent' }, t('apps.recent'), recentApps.filter((app) => !settings.disabledApps.includes(app)).map((app) => h('button', {
                  key: app, type: 'button', className: 'dss-chip suggest', onClick: () => addApp(app),
                }, `+ ${app}`)))
                : null))),

          panel('usage',
            h(UsagePanel, {
              t, usage, settings, catalog,
              onReset: () => {
                if (window.confirm(t('usage.resetConfirm'))) act('/usage/reset', (summary) => setUsage(summary))
              },
            })),

          h('div', { className: 'dss-footer' },
            h('button', {
              type: 'button', className: 'dss-button',
              onClick: () => {
                if (!window.confirm(t('footer.resetConfirm'))) return
                clearTimeout(timer.current)
                pending.current = null
                act('/settings/reset', ({ settings: restored }) => setState((current) => ({ ...current, settings: restored })))
              },
            }, t('footer.reset')),
            status.supported ? h('button', { type: 'button', className: 'dss-button quiet', onClick: () => act('/worker/restart') }, t('footer.restart')) : null,
            h('div', { className: 'dss-hint' }, t('footer.data')))))
    }

    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          const t = typeof this.props.t === 'function' ? this.props.t : (key) => zh[key] || key
          return h('div', { className: 'dss-root' }, h('style', null, css),
            h('div', { className: 'dss-page' }, h('div', { className: 'dss-error' }, t('error.render') + String(this.state.error.message || this.state.error))))
        }
        return this.props.children
      }
    }

    function SettingsEntry(props) {
      return h(PageBoundary, props, h(SettingsPage, props))
    }

    // Dashed selection frame around lines of text (Lucide "text-select", ISC).
    const SIDEBAR_ICON = 'M5 3a2 2 0 0 0-2 2 M19 3a2 2 0 0 1 2 2 M21 19a2 2 0 0 1-2 2 M5 21a2 2 0 0 1-2-2 M9 3h1 M9 21h1 M14 3h1 M14 21h1 M3 9v1 M21 9v1 M3 14v1 M21 14v1 M7 8h10 M7 12h10 M7 16h6'

    function SidebarIcon({ size = 18, active }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      }, h('path', { d: SIDEBAR_ICON, stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-selection: dictionaries')
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('title') },
            SidebarIcon,
          )),
          'dsh-selection: sidebar entry',
        )
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SettingsEntry)),
          'dsh-selection: settings page',
        )
        ctx.effect(() => events.start(), 'dsh-selection: event stream')
        // "More settings…" in the toolbar menu asks the Host to bring DSH forward on this page.
        ctx.effect(() => events.subscribe((event) => {
          if (event !== 'navigate') return
          try {
            const layout = ctx.get ? ctx.get('layout') : ctx.layout
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
          } catch {
            // The layout service may not be ready yet; the window still comes forward.
          }
        }), 'dsh-selection: navigation')
      },
    }
  },
})
