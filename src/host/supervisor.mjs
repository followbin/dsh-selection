// Runs the selection worker as a child of the DSH Host. Being a child keeps the macOS accessibility
// grant attributed to DeepSeek Harness, and a crash in native code only takes the worker down.
import { fork } from 'node:child_process'
import { RESTART_NOW } from '../shared/protocol.mjs'

const MAX_BACKOFF_MS = 30_000
const SHUTDOWN_GRACE_MS = 2000
// A worker that dies before 'ready' this many times in a row will not start by retrying (a missing
// native package, say). It then waits for the settings page's Restart instead of looping all day.
const MAX_FAILED_STARTS = 5

/**
 * @param {{
 *   workerPath: string,
 *   args?: string[],
 *   log: (level: string, message: string, fields?: object) => void,
 *   onMessage: (message: any) => void,
 *   onState: (state: { state: 'starting' | 'running' | 'restarting' | 'stopped' | 'failed', pid: number | null }) => void,
 *   baseDelayMs?: number,
 * }} options `baseDelayMs` is the first crash backoff, doubled per failure; tests shorten it.
 */
export function startWorker({ workerPath, args = [], log, onMessage, onState, baseDelayMs = 1000 }) {
  let child = null
  let stopped = false
  let failures = 0
  let immediate = false
  let timer = null

  function spawn() {
    const env = { ...process.env }
    // The DSH Host is Electron in Node mode; fork reuses that executable, which must stay in Node mode.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    // execArgv is cleared so Host flags (inspector ports, loaders) do not leak into the worker.
    child = fork(workerPath, args, { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const current = child
    onState({ state: 'starting', pid: current.pid ?? null })
    pipeOutput(current.stdout, 'debug')
    pipeOutput(current.stderr, 'debug')
    current.on('message', (message) => {
      if (message?.type === 'ready') {
        failures = 0
        onState({ state: 'running', pid: current.pid ?? null })
      }
      onMessage(message)
    })
    let ended = false
    const end = (code, signal) => {
      if (ended) return
      ended = true
      if (child === current) child = null
      if (stopped) {
        onState({ state: 'stopped', pid: null })
        return
      }
      if (!immediate && code !== RESTART_NOW && failures >= MAX_FAILED_STARTS) {
        log('error', 'worker keeps failing to start; waiting for a restart', { code, signal, failures })
        onState({ state: 'failed', pid: null })
        return
      }
      const delay = immediate || code === RESTART_NOW ? 0 : Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** failures++)
      immediate = false
      log(code === RESTART_NOW ? 'info' : 'warn', 'worker exited', { code, signal, restartInMs: delay })
      onState({ state: 'restarting', pid: null })
      timer = setTimeout(spawn, delay)
    }
    current.on('error', (error) => {
      log('error', 'worker process error', { error: error.message })
      // A child that could not be spawned at all reports only this error, never 'exit'.
      if (current.pid === undefined) end(null, null)
    })
    current.on('exit', end)
  }

  function pipeOutput(stream, level) {
    let buffer = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (data) => {
      buffer += data
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) log(level, 'worker output', { line: line.slice(0, 500) })
    })
  }

  spawn()

  return {
    send(message) {
      if (child?.connected) child.send(message)
    },
    /** Restarts now, skipping the crash backoff. */
    restart() {
      if (stopped) return
      failures = 0
      if (child) {
        immediate = true
        child.kill()
      } else {
        clearTimeout(timer)
        spawn()
      }
    },
    /** Asks the worker to clean up, then kills it if it does not exit in time. */
    stop() {
      stopped = true
      clearTimeout(timer)
      const current = child
      if (!current) {
        // Between a crash and the next spawn there is no process to wait for.
        onState({ state: 'stopped', pid: null })
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        const kill = setTimeout(() => current.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
        const done = () => {
          clearTimeout(kill)
          resolve()
        }
        current.once('exit', done)
        current.once('error', done)
        if (current.connected) current.send({ type: 'shutdown' })
        else current.kill()
      })
    },
  }
}
