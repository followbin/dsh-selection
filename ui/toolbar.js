// Toolbar page logic. Node drives it through window.bar.*; it answers with window.ipc.postMessage(JSON).
(function () {
  const STRINGS = {
    zh: {
      more: '更多', disableApp: '在此应用中禁用', settings: '更多设置…', copied: '已复制', stop: '停止',
      close: '关闭', copyResult: '复制结果', retry: '重新生成', pin: '固定窗口', translateTo: '译为', auto: '自动',
      askPlaceholder: '就这段内容问点什么…', followPlaceholder: '接着问…', send: '发送', waiting: '正在生成', retryShort: '重试', from: '来自 {app}',
      errors: {
        NO_LLM: 'DSH 的模型服务还没就绪，稍后再试',
        NO_MODEL: 'DSH 里还没有可用的模型，请先在 DSH 设置中登录或填写 API Key',
        MODEL_FAILED: '模型调用失败',
        EMPTY: '模型没有返回内容',
        TIMEOUT: '等待模型超时',
      },
    },
    en: {
      more: 'More', disableApp: 'Disable in this app', settings: 'More settings…', copied: 'Copied', stop: 'Stop',
      close: 'Close', copyResult: 'Copy result', retry: 'Regenerate', pin: 'Keep open', translateTo: 'Translate to', auto: 'Auto',
      askPlaceholder: 'Ask something about this text…', followPlaceholder: 'Ask a follow-up…', send: 'Send', waiting: 'Generating', retryShort: 'Retry', from: 'from {app}',
      errors: {
        NO_LLM: 'DSH’s model service is not ready yet, try again shortly',
        NO_MODEL: 'No model is set up in DSH yet. Sign in or add an API key in DSH settings',
        MODEL_FAILED: 'The model request failed',
        EMPTY: 'The model returned nothing',
        TIMEOUT: 'The model took too long to answer',
      },
    },
  }
  const locale = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const t = STRINGS[locale]
  const icons = window.DSH_ICONS || {}
  const body = document.body
  const $ = (selector) => document.querySelector(selector)
  const post = (message) => window.ipc.postMessage(JSON.stringify(message))
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`
  const nameOf = (skill) => (typeof skill.name === 'string' ? skill.name : skill.name[locale] || skill.name.en)

  const els = {
    barSkills: $('.bar-skills'),
    more: $('.more-button'),
    menu: $('.menu'),
    menuSkills: $('.menu-skills'),
    panel: $('.panel'),
    panelIcon: $('.panel-icon'),
    panelTitle: $('.panel-title'),
    panelApp: $('.panel-app'),
    language: $('.panel-language'),
    pin: $('[data-tool="pin"]'),
    copy: $('[data-tool="copy"]'),
    source: $('.source'),
    result: $('.result'),
    thread: $('.thread'),
    composer: $('.composer'),
    input: $('.composer textarea'),
    send: $('.composer .send'),
    panelBody: $('.panel-body'),
  }

  // Static labels and icons.
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t[node.dataset.i18n] })
  document.querySelectorAll('[data-i18n-label]').forEach((node) => {
    node.setAttribute('aria-label', t[node.dataset.i18nLabel])
    node.title = t[node.dataset.i18nLabel]
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t[node.dataset.i18nPlaceholder] })
  els.more.innerHTML = icon('more')
  $('[data-menu-action="disable-app"]').insertAdjacentHTML('afterbegin', icon('ban'))
  $('[data-menu-action="settings"]').insertAdjacentHTML('afterbegin', icon('settings'))
  for (const [tool, name] of [['pin', 'pin'], ['copy', 'copy'], ['retry', 'retry'], ['close', 'close']]) {
    $(`[data-tool="${tool}"]`).innerHTML = icon(name)
  }
  els.send.innerHTML = icon('send')

  const emptyState = (requestId = null, pending = false) => ({ requestId, text: '', turn: null, pending, failure: null })
  let skills = { bar: [], more: [] }
  let state = emptyState()
  let renderTimer = null
  // Timers rather than requestAnimationFrame: the view can be occluded or the screen locked, and then
  // frame callbacks stop while the window still has to be resized and the answer kept up to date.
  const RENDER_INTERVAL_MS = 16

  function skillButton(skill, className) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.dataset.skill = skill.id
    button.innerHTML = `${icon(skill.icon)}<span></span>`
    button.querySelector('span').textContent = nameOf(skill)
    return button
  }

  function setMenu(open) {
    if (open) {
      const bar = $('.bar')
      els.menu.style.left = `${bar.offsetLeft + els.more.offsetLeft - 6}px`
      els.menu.style.top = `${bar.offsetTop + bar.offsetHeight + 6}px`
    }
    body.dataset.menu = open ? 'open' : 'closed'
    els.more.setAttribute('aria-expanded', String(open))
    queueSize()
  }

  // Whether the reader is at the end of the conversation. New text keeps the end in view until they
  // scroll up; scrolling back down, or asking something, follows it again.
  let following = true
  const scrollToEnd = () => { els.panelBody.scrollTop = els.panelBody.scrollHeight }

  // Draws the answer and any failure from state, so a late batched render can never erase an error.
  function render() {
    clearTimeout(renderTimer)
    renderTimer = null
    const node = state.turn ? state.turn.querySelector('.answer') : els.result
    node.classList.toggle('pending', state.pending)
    node.dataset.pending = t.waiting
    // Copy takes the answer from here: the node itself also holds the failure notice.
    node.dataset.text = state.text
    node.innerHTML = window.DshMarkdown.render(state.text) + (state.failure ? failureHtml(state.failure) : '')
    if (following) scrollToEnd()
    queueSize()
  }

  // Re-rendering the whole answer is cheap at this size; batching keeps streaming smooth.
  function scheduleRender() {
    if (renderTimer === null) renderTimer = setTimeout(render, RENDER_INTERVAL_MS)
  }

  function failureHtml(failure) {
    const message = t.errors[failure.code] || t.errors.MODEL_FAILED
    const detail = failure.detail ? `<small>${window.DshMarkdown.escapeHtml(failure.detail)}</small>` : ''
    const request = window.DshMarkdown.escapeHtml(state.requestId || '')
    return `<div class="failure" data-request="${request}">${window.DshMarkdown.escapeHtml(message)}${detail}<button type="button" data-tool="retry">${t.retryShort}</button></div>`
  }

  // A second flash before the first one ends must still restore the original content, not the check mark.
  const flashes = new WeakMap()
  function flashDone(button, label) {
    const running = flashes.get(button)
    if (running) clearTimeout(running.timer)
    const original = running ? running.original : button.innerHTML
    const labelled = running ? running.labelled : button.querySelector('span') !== null
    button.classList.add('done')
    button.innerHTML = `${icon('check')}${labelled ? `<span>${label}</span>` : ''}`
    const timer = setTimeout(() => {
      flashes.delete(button)
      button.classList.remove('done')
      button.innerHTML = original
    }, 1200)
    flashes.set(button, { original, labelled, timer })
  }

  window.bar = {
    configure(next) {
      skills = next
      els.barSkills.replaceChildren(...next.bar.map((skill) => skillButton(skill, 'skill')))
      els.menuSkills.replaceChildren(...next.more.map((skill) => skillButton(skill, 'menu-item')))
      queueSize()
    },
    showBar() {
      delete body.dataset.pointer
      body.dataset.mode = 'bar'
      setMenu(false)
    },
    setMenu(open) {
      if (body.dataset.mode === 'bar') setMenu(Boolean(open))
    },
    showPanel({ skill, text, app, languages, translateTarget }) {
      delete body.dataset.pointer
      body.dataset.mode = 'panel'
      body.dataset.menu = 'closed'
      body.dataset.kind = skill.kind === 'ask' ? 'ask' : skill.id === 'translate' ? 'translate' : 'prompt'
      els.panelIcon.innerHTML = icon(skill.icon)
      els.panelTitle.textContent = nameOf(skill)
      els.panelApp.textContent = app ? t.from.replace('{app}', app) : ''
      els.source.textContent = text
      els.source.classList.remove('expanded')
      els.result.replaceChildren()
      delete els.result.dataset.text
      els.thread.replaceChildren()
      // Other skills offer the follow-up box once their answer is complete.
      delete body.dataset.composer
      els.input.placeholder = skill.kind === 'ask' ? t.askPlaceholder : t.followPlaceholder
      els.pin.setAttribute('aria-pressed', 'false')
      els.language.replaceChildren(
        new Option(t.auto, 'auto'),
        ...(languages || []).map((language) => new Option(language.name, language.code)),
      )
      els.language.value = translateTarget || 'auto'
      clearTimeout(renderTimer)
      renderTimer = null
      state = emptyState()
      following = true
      els.panelBody.scrollTop = 0
      // A question typed but not sent belongs to the earlier selection.
      els.input.value = ''
      resizeInput()
      if (skill.kind === 'ask') setTimeout(() => els.input.focus(), 0)
      queueSize()
    },
    begin(requestId, info) {
      // The previous answer is drawn before its state goes: its last text may still wait for the
      // render timer, and a turn that was still streaming ends where it is.
      if (state.requestId !== null && (renderTimer !== null || state.pending)) {
        state.pending = false
        render()
      }
      // Retry buttons left in earlier failures would run whatever is on screen now.
      els.panel.querySelectorAll('.failure [data-tool="retry"]').forEach((button) => button.remove())
      state = emptyState(requestId, true)
      if (typeof info?.question === 'string') {
        const turn = document.createElement('div')
        turn.className = 'turn'
        turn.innerHTML = '<div class="question"></div><div class="answer markdown"></div>'
        turn.querySelector('.question').textContent = info.question
        els.thread.append(turn)
        state.turn = turn
        following = true
        scrollToEnd()
      } else if (body.dataset.kind !== 'ask') {
        // The panel's own skill runs again (retry, another language), so its conversation starts over.
        els.thread.replaceChildren()
        delete body.dataset.composer
      }
      scheduleRender()
      queueSize()
    },
    append(requestId, chunk) {
      if (requestId !== state.requestId) return
      state.text += chunk
      state.pending = true
      scheduleRender()
    },
    done(requestId) {
      if (requestId !== state.requestId) return
      state.pending = false
      body.dataset.composer = 'shown'
      scheduleRender()
    },
    fail(requestId, failure) {
      if (requestId !== state.requestId) return
      state.pending = false
      state.failure = failure
      render()
    },
    setSpeaking(speaking) {
      const button = els.barSkills.querySelector('[data-skill="speak"]') || els.menuSkills.querySelector('[data-skill="speak"]')
      if (!button) return
      const skill = [...skills.bar, ...skills.more].find((candidate) => candidate.id === 'speak')
      button.innerHTML = `${icon(speaking ? 'stop' : 'speak')}<span></span>`
      button.querySelector('span').textContent = speaking ? t.stop : nameOf(skill)
      queueSize()
    },
    flash(skillId) {
      // A skill run from the ⋯ menu confirms on the ⋯ button: the menu has closed by then.
      flashDone(els.barSkills.querySelector(`[data-skill="${skillId}"]`) || els.more, t.copied)
    },
    /**
     * How tall the panel may grow before it scrolls inside, from the worker's placement. With `fill`
     * it takes that height at once: it sits above the selection, its bottom edge at the selection.
     */
    setRoom(px, fill) {
      const limited = Number.isFinite(px) && px > 0
      body.style.setProperty('--room', limited ? `${px}px` : 'none')
      if (limited && fill) body.dataset.fill = 'true'
      else delete body.dataset.fill
      queueSize()
    },
    reset() {
      delete body.dataset.pointer
      body.dataset.mode = 'hidden'
      body.dataset.menu = 'closed'
      if (document.activeElement) document.activeElement.blur()
    },
    /** Clicks an element through the page's own click handling (self tests). */
    click(selector) {
      document.querySelector(selector)?.click()
    },
    probe() {
      const card = body.dataset.mode === 'panel' ? els.panel : $('.bar')
      const box = card.getBoundingClientRect()
      const buttons = [...document.querySelectorAll('button')].filter((button) => button.offsetParent !== null)
      post({
        type: 'probe',
        mode: body.dataset.mode,
        menu: body.dataset.menu,
        viewport: { width: innerWidth, height: innerHeight },
        card: { width: Math.round(box.width), height: Math.round(box.height) },
        buttons: buttons.map((button) => button.getAttribute('aria-label') || button.textContent.trim()),
        overflow: buttons.filter((button) => {
          const rect = button.getBoundingClientRect()
          const owner = button.closest('.card').getBoundingClientRect()
          return rect.right > owner.right + 0.5 || rect.bottom > owner.bottom + 0.5
        }).map((button) => button.getAttribute('aria-label') || button.textContent.trim()),
        darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
        // Visible area of each card: anything a card draws outside it is clipped from the user's view.
        clipped: [...document.querySelectorAll('.card')].filter((node) => node.offsetParent !== null).some((node) => {
          const rect = node.getBoundingClientRect()
          return rect.bottom > innerHeight + 0.5 || rect.right > innerWidth + 0.5
            || document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 2)?.closest('.card') !== node
        }),
        controls: Object.fromEntries([...document.querySelectorAll('[data-tool]')].filter((node) => node.offsetParent !== null).map((node) => {
          const rect = node.getBoundingClientRect()
          return [node.dataset.tool, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }]
        })),
        body: (({ left, right }) => ({ left, right }))(els.panelBody.getBoundingClientRect()),
        questions: [...els.thread.querySelectorAll('.question')].map((node) => (({ left, right }) => ({ left, right }))(node.getBoundingClientRect())),
      })
    },
  }

  // Report the window size the visible cards need, which card the window is anchored on, and every
  // clickable card so clicks on the transparent margin fall through to the app underneath.
  const padding = (() => {
    const style = getComputedStyle(body)
    return { right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom) }
  })()
  let sizeQueued = false
  // Batched per task; reading layout synchronously forces it even when nothing is being painted.
  function queueSize() {
    if (sizeQueued) return
    sizeQueued = true
    queueMicrotask(() => {
      sizeQueued = false
      const mode = body.dataset.mode
      if (mode !== 'bar' && mode !== 'panel') return
      const cards = mode === 'bar' ? [$('.bar'), ...(body.dataset.menu === 'open' ? [els.menu] : [])] : [els.panel]
      const rects = cards.map((card) => card.getBoundingClientRect())
      const asRect = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      post({
        type: 'size',
        mode,
        width: Math.ceil(Math.max(...rects.map((rect) => rect.right)) + padding.right),
        height: Math.ceil(Math.max(...rects.map((rect) => rect.bottom)) + padding.bottom),
        primary: asRect(rects[0]),
        hits: rects.map(asRect),
      })
    })
  }
  new ResizeObserver(queueSize).observe($('.stage'))

  function resizeInput() {
    els.input.style.height = 'auto'
    const height = els.input.scrollHeight
    els.input.style.height = `${Math.min(height, 96)}px`
    // Scrollable only past its tallest size: at fractional display scaling one line can overflow by a
    // fraction of a pixel, which would otherwise let it scroll.
    els.input.style.overflowY = height > 96 ? 'auto' : 'hidden'
    els.send.disabled = !els.input.value.trim()
  }

  function submitQuestion() {
    const question = els.input.value.trim()
    if (!question) return
    post({ type: 'ask', question })
    els.input.value = ''
    resizeInput()
  }

  document.addEventListener('click', (event) => {
    const skill = event.target.closest('[data-skill]')
    if (skill) {
      setMenu(false)
      post({ type: 'skill', id: skill.dataset.skill })
      return
    }
    if (event.target.closest('.more-button')) {
      setMenu(body.dataset.menu !== 'open')
      return
    }
    const menu = event.target.closest('[data-menu-action]')
    if (menu) {
      post({ type: 'menu', action: menu.dataset.menuAction })
      return
    }
    const link = event.target.closest('a[data-href]')
    if (link) {
      event.preventDefault()
      post({ type: 'open-url', url: link.dataset.href })
      return
    }
    const tool = event.target.closest('[data-tool]')
    if (tool) {
      const action = tool.dataset.tool
      if (action === 'pin') {
        const pinned = tool.getAttribute('aria-pressed') !== 'true'
        tool.setAttribute('aria-pressed', String(pinned))
        post({ type: 'pin', pinned })
      } else if (action === 'copy') {
        const answers = [els.result, ...els.thread.querySelectorAll('.answer')]
        const text = answers.map((node) => node.dataset.text || '').filter(Boolean).join('\n\n')
        if (text) {
          post({ type: 'copy-result', text })
          flashDone(tool, '')
        }
      } else if (action === 'retry') {
        const failure = tool.closest('.failure')
        if (failure) {
          // A failed turn is asked again in place of itself.
          failure.closest('.turn')?.remove()
          post({ type: 'retry', requestId: failure.dataset.request })
        } else {
          post({ type: 'retry' })
        }
      } else if (action === 'close') {
        post({ type: 'close' })
      }
      return
    }
    if (event.target.closest('.source')) {
      els.source.classList.toggle('expanded')
      queueSize()
    }
  })

  els.language.addEventListener('change', () => post({ type: 'language', code: els.language.value }))
  els.input.addEventListener('input', resizeInput)
  els.input.addEventListener('focus', () => post({ type: 'keyboard', needed: true }))
  els.input.addEventListener('keydown', (event) => {
    // WebKit ends the composition before this keydown, so only keyCode 229 marks the IME's own Enter.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      submitQuestion()
    }
  })
  // Escape closes the panel, unless an input method is using it to cancel a composition.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && body.dataset.mode !== 'hidden') post({ type: 'close' })
  })
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault()
    submitQuestion()
  })
  // Pressing on the toolbar or the panel header and moving moves the window. A press that travels less
  // than a few points stays an ordinary click; once it has become a drag, its click is swallowed.
  const DRAG_THRESHOLD = 4
  let press = null
  let swallowClick = false
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('select, textarea')) return
    if (!event.target.closest('.bar, .panel-head')) return
    press = { id: event.pointerId, x: event.screenX, y: event.screenY, target: event.target, dragging: false }
  })
  document.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id) return
    if (!press.dragging) {
      if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_THRESHOLD) return
      press.dragging = true
      body.dataset.dragging = 'true'
      try {
        press.target.setPointerCapture(event.pointerId)
      } catch {
        // Without capture the drag still works while the pointer stays over the window.
      }
      post({ type: 'drag', phase: 'start', x: press.x, y: press.y })
    }
    post({ type: 'drag', phase: 'move', x: event.screenX, y: event.screenY })
  })
  const endPress = (event) => {
    if (!press || event.pointerId !== press.id) return
    if (press.dragging) {
      post({ type: 'drag', phase: 'end', x: event.screenX, y: event.screenY })
      delete body.dataset.dragging
      swallowClick = true
      setTimeout(() => { swallowClick = false }, 0)
    }
    press = null
  }
  document.addEventListener('pointerup', endPress)
  document.addEventListener('pointercancel', endPress)
  document.addEventListener('click', (event) => {
    if (!swallowClick) return
    swallowClick = false
    event.stopImmediatePropagation()
    event.preventDefault()
  }, true)

  els.panelBody.addEventListener('scroll', () => {
    following = els.panelBody.scrollHeight - els.panelBody.scrollTop - els.panelBody.clientHeight < 24
  })

  // Clicking into the answer lets the panel take the keyboard, so ⌘C copies a selected part of it.
  els.panelBody.addEventListener('pointerdown', () => {
    if (body.dataset.mode === 'panel') post({ type: 'keyboard', needed: true })
  })

  // WebKit keeps :hover on whatever was under the pointer when it last saw one, through hiding and
  // showing the window, and this process is never the active app, so a pointer that does not move
  // over the page is not tracked. Hover styles therefore wait for a real movement after each show.
  document.addEventListener('pointermove', () => {
    if (!('pointer' in body.dataset)) body.dataset.pointer = ''
  })

  // Dropping a link or file would navigate the view away from this page.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => event.preventDefault())
  window.addEventListener('error', (event) => post({ type: 'page-error', message: String(event.message) }))
  post({ type: 'page-ready' })
})()
