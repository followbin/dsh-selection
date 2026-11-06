// Reads text aloud with the system voice: `say` on macOS, SAPI through PowerShell on Windows.
// The text goes through stdin, so nothing in it is ever parsed as a command-line argument.
import { execFile, spawn } from 'node:child_process'

/**
 * @param {{ log: (level: string, message: string, fields?: object) => void, onChange: (speaking: boolean) => void }} options
 */
export function createSpeech({ log, onChange }) {
  let current = null
  let voices = null
  // Bumped on every start and stop so a slow voice lookup cannot resurrect a cancelled request.
  let generation = 0

  async function macVoiceFor(text) {
    voices ??= await listMacVoices().catch((error) => {
      log('warn', 'listing voices failed', { error: error.message })
      return []
    })
    return pickVoice(voices, localeOf(text))
  }

  async function speak(text) {
    stop()
    const token = ++generation
    const args = process.platform === 'darwin' ? await macArgs(text) : []
    if (token !== generation) return
    const process_ = process.platform === 'darwin'
      ? spawn('say', [...args, '-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
      // stdin would otherwise be decoded with the OEM code page and garble anything but ASCII.
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; '
        + '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())'],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    current = process_
    onChange(true)
    process_.on('error', (error) => log('warn', 'speech failed to start', { error: error.message }))
    process_.on('exit', () => {
      if (current === process_) {
        current = null
        onChange(false)
      }
    })
    // Stopping before the voice has read all of stdin closes the pipe; EPIPE is expected then.
    process_.stdin.on('error', () => {})
    process_.stdin.end(text)
  }

  async function macArgs(text) {
    const voice = await macVoiceFor(text)
    return voice ? ['-v', voice] : []
  }

  function stop() {
    generation += 1
    if (!current) return
    const process_ = current
    current = null
    process_.kill()
    onChange(false)
  }

  return {
    /** Starts reading, or stops if something is already being read. */
    toggle(text) {
      if (current) stop()
      else void speak(text)
    },
    stop,
    get speaking() { return current !== null },
  }
}

function listMacVoices() {
  return new Promise((resolve, reject) => {
    execFile('say', ['-v', '?'], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      if (error) return reject(error)
      resolve(parseVoices(stdout))
    })
  })
}

// `say -v ?` lists voices alphabetically, so the first one for a language is often a novelty voice
// (Albert, Bad News…). Well-known voices go first; novelty voices are never chosen.
const PREFERRED_VOICES = {
  en_US: ['Samantha', 'Alex', 'Ava', 'Allison', 'Tom'],
  zh_CN: ['Tingting', 'Lili', 'Yu-shu'],
  ja_JP: ['Kyoko', 'Otoya'],
  ko_KR: ['Yuna', 'Sora'],
  ru_RU: ['Milena', 'Yuri', 'Katya'],
}
const NOVELTY_VOICES = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ',
  'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
])

/** @returns {string | undefined} the voice name to pass to `say -v`, or undefined for the system voice */
export function pickVoice(voices, locale) {
  const base = (name) => name.replace(/\s*\(.*\)$/, '')
  for (const name of PREFERRED_VOICES[locale] ?? []) {
    const voice = voices.find((candidate) => candidate.locale === locale && base(candidate.name) === name)
    if (voice) return voice.name
  }
  const usable = (voice) => !NOVELTY_VOICES.has(base(voice.name))
  return voices.find((voice) => voice.locale === locale && usable(voice))?.name
    ?? voices.find((voice) => voice.locale.startsWith(locale.slice(0, 2)) && usable(voice))?.name
}

/** Reads the output of `say -v ?`: one voice per line, then its locale, then a sample sentence. */
export function parseVoices(stdout) {
  const voices = []
  for (const line of stdout.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line)
    if (match) voices.push({ name: match[1].trim(), locale: match[2] })
  }
  return voices
}

/** Picks a voice locale from the script the text is written in. */
export function localeOf(text) {
  let han = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 0x3040 && code <= 0x30ff) kana += 1
    else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) hangul += 1
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) han += 1
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1
  }
  if (kana > 0) return 'ja_JP'
  if (hangul > 0) return 'ko_KR'
  if (han > 0) return 'zh_CN'
  if (cyrillic > 0) return 'ru_RU'
  return 'en_US'
}
