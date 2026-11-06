import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../ui/markdown.js'

const { render } = globalThis.DshMarkdown

describe('markdown renderer', () => {
  test('never lets HTML through', () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)> `<b>`\n\n```\n<svg onload=alert(1)>\n```')
    assert.ok(!/<script|<img|<svg|<b>/.test(html), html)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /<code>&lt;b&gt;<\/code>/)
  })

  test('links keep only http(s) targets, in data-href', () => {
    assert.equal(render('[docs](https://example.com/a?b=1&c=2)'), '<p><a data-href="https://example.com/a?b=1&amp;c=2">docs</a></p>')
    assert.ok(!render('[x](javascript:alert(1))').includes('<a'))
    const html = render('[x](https://e.com/"onmouseover="alert(1))')
    assert.ok(!html.includes('" onmouseover'), html)
  })

  test('renders the common blocks', () => {
    assert.equal(render('# Title'), '<h3>Title</h3>')
    assert.equal(render('- a\n- **b**'), '<ul><li>a</li><li><strong>b</strong></li></ul>')
    assert.equal(render('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>')
    assert.equal(render('> quoted'), '<blockquote><p>quoted</p></blockquote>')
    assert.equal(render('line one\nline two'), '<p>line one<br>line two</p>')
    assert.equal(render('```js\nconst a = 1\n```'), '<pre><code>const a = 1</code></pre>')
    assert.equal(render('| a | b |\n|---|---|\n| 1 | 2 |'), '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  })

  test('an unfinished code block while streaming still renders', () => {
    assert.equal(render('```\npartial'), '<pre><code>partial</code></pre>')
  })

  test('emphasis does not eat list markers or snake_case', () => {
    assert.equal(render('*a* and snake_case_name'), '<p><em>a</em> and snake_case_name</p>')
  })
})
