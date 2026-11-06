import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openableUrl } from '../src/worker/open-url.mjs'
import { pageHtml } from '../src/worker/page.mjs'
import { localeOf, parseVoices } from '../src/worker/speech.mjs'

describe('opening links', () => {
  test('only web links and DSH links are handed to the system', () => {
    assert.equal(openableUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
    assert.equal(openableUrl('http://example.com'), 'http://example.com/')
    assert.equal(openableUrl('dsh://open'), 'dsh://open')
    for (const url of [
      'file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple.preference.security',
      'ftp://example.com', 'smb://server/share', 'vscode://file/x', 'not a url', '', undefined, 42,
    ]) {
      assert.equal(openableUrl(url), null, String(url))
    }
  })
})

describe('reading aloud', () => {
  test('the voice locale follows the script of the text', () => {
    assert.equal(localeOf('Hello there'), 'en_US')
    assert.equal(localeOf('你好，DSH'), 'zh_CN')
    assert.equal(localeOf('こんにちは、世界'), 'ja_JP', 'kana means Japanese even next to kanji')
    assert.equal(localeOf('안녕하세요'), 'ko_KR')
    assert.equal(localeOf('Привет'), 'ru_RU')
    assert.equal(localeOf(''), 'en_US')
  })

  test('voices are read from `say -v ?`, including names with spaces and brackets', () => {
    const voices = parseVoices([
      'Albert              en_US    # Hello! My name is Albert.',
      'Bad News            en_US    # Hello! My name is Bad News.',
      'Eddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。',
      'Tingting            zh_CN    # 你好！我叫婷婷。',
      '',
      'garbage line',
    ].join('\n'))
    assert.deepEqual(voices, [
      { name: 'Albert', locale: 'en_US' },
      { name: 'Bad News', locale: 'en_US' },
      { name: 'Eddy (Chinese (China mainland))', locale: 'zh_CN' },
      { name: 'Tingting', locale: 'zh_CN' },
    ])
  })
})

describe('toolbar page', () => {
  test('is one self-contained document that may not load anything', () => {
    const html = pageHtml()
    assert.doesNotMatch(html, /<script[^>]+src=/i)
    assert.doesNotMatch(html, /<link[^>]+href=/i)
    assert.match(html, /Content-Security-Policy[^>]+default-src 'none'/)
    assert.match(html, /window\.DSH_ICONS = \{/)
    assert.match(html, /window\.DshMarkdown|globalThis\.DshMarkdown/)
  })
})
