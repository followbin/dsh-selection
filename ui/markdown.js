// A deliberately small Markdown renderer for model output. Everything is HTML-escaped first and only
// tags produced here reach the page; links keep their target in data-href and open in the browser.
// Classic script: the toolbar page inlines it, the tests import it, both read globalThis.DshMarkdown.
(function (root) {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char])

  const FENCE = /^\s*(```|~~~)/
  const HEADING = /^(#{1,6})\s+(.*)$/
  const QUOTE = /^\s*>\s?/
  const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/
  const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
  const TABLE_ROW = /^\s*\|.*\|\s*$/
  const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

  // A link target has no spaces, and parentheses only in balanced pairs, as in .../Python_(programming_language).
  const LINK = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g

  function emphasis(html) {
    return html
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  }

  function inline(text) {
    return String(text).replace(/\u0000/g, '').split(/(`[^`\n]+`)/g).map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      // Links are set aside while emphasis is applied, so an underscore or asterisk in a URL stays
      // part of it, and **[a link](…)** still turns bold.
      const links = []
      const marked = part.replace(LINK, (match, label, href) => {
        links.push(`<a data-href="${escapeHtml(href)}">${emphasis(escapeHtml(label))}</a>`)
        return `\u0000${links.length - 1}\u0000`
      })
      return emphasis(escapeHtml(marked)).replace(/\u0000(\d+)\u0000/g, (match, index) => links[Number(index)])
    }).join('')
  }

  function isBlockStart(line) {
    return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || RULE.test(line) || TABLE_ROW.test(line)
  }

  function cells(row) {
    return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  }

  function render(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        i += 1
        continue
      }
      const fence = FENCE.exec(line)
      if (fence) {
        const code = []
        i += 1
        while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i++])
        i += 1
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        continue
      }
      const heading = HEADING.exec(line)
      if (heading) {
        const level = heading[1].length <= 2 ? 3 : 4
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
        i += 1
        continue
      }
      if (QUOTE.test(line)) {
        const quote = []
        while (i < lines.length && QUOTE.test(lines[i])) quote.push(lines[i++].replace(QUOTE, ''))
        out.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`)
        continue
      }
      if (RULE.test(line)) {
        out.push('<hr>')
        i += 1
        continue
      }
      if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
        const head = cells(line)
        i += 2
        const body = []
        while (i < lines.length && TABLE_ROW.test(lines[i])) body.push(cells(lines[i++]))
        out.push(`<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`
          + `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
        continue
      }
      const item = LIST_ITEM.exec(line)
      if (item) {
        const ordered = /\d/.test(item[1])
        const items = []
        while (i < lines.length) {
          const next = LIST_ITEM.exec(lines[i])
          if (next && /\d/.test(next[1]) === ordered) {
            items.push(next[2])
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1] += `\n${lines[i].trim()}`
          } else {
            break
          }
          i += 1
        }
        const tag = ordered ? 'ol' : 'ul'
        out.push(`<${tag}>${items.map((text) => `<li>${text.split('\n').map(inline).join('<br>')}</li>`).join('')}</${tag}>`)
        continue
      }
      const paragraph = []
      while (i < lines.length && lines[i].trim() && !(paragraph.length && isBlockStart(lines[i]))) paragraph.push(lines[i++])
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    }
    return out.join('')
  }

  root.DshMarkdown = { render, escapeHtml }
})(globalThis)
