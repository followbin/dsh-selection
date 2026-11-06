import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { startWorker } from '../src/host/supervisor.mjs'
import { RESTART_NOW } from '../src/shared/protocol.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-selection-supervisor-'))
after(() => rmSync(directory, { recursive: true, force: true }))

/** A worker that exits at once with the code in its first argument, or stays up after 'ready'. */
const workerPath = join(directory, 'worker.mjs')
writeFileSync(workerPath, `
const code = process.argv[2]
if (code !== 'ready') process.exit(Number(code))
process.send({ type: 'ready' })
process.on('message', (message) => { if (message?.type === 'shutdown') process.exit(0) })
`)

async function until(check, ms = 5000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function supervise(args) {
  const states = []
  const logs = []
  const worker = startWorker({
    workerPath, args, baseDelayMs: 1,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    onMessage: () => {},
    onState: ({ state }) => states.push(state),
  })
  return { worker, states, logs }
}

describe('worker supervisor', () => {
  test('a worker that keeps dying before ready is left alone until a restart', async () => {
    const { worker, states, logs } = supervise(['3'])
    await until(() => states.includes('failed'))
    assert.equal(states.filter((state) => state === 'starting').length, 6, 'the first start and five retries')
    assert.equal(logs.at(-1).level, 'error')
    worker.restart()
    await until(() => states.filter((state) => state === 'failed').length === 2)
    assert.equal(states.filter((state) => state === 'starting').length, 12, 'a restart grants a fresh set of attempts')
    await worker.stop()
  })

  test('the restart code after a permission grant restarts at once and is not a failure', async () => {
    const { worker, states, logs } = supervise([String(RESTART_NOW)])
    await until(() => states.filter((state) => state === 'starting').length >= 8)
    assert.ok(!states.includes('failed'))
    assert.ok(logs.filter((entry) => entry.message === 'worker exited').every((entry) => entry.level === 'info'))
    await worker.stop()
  })

  test('a running worker is asked to shut down and reports stopped', async () => {
    const { worker, states } = supervise(['ready'])
    await until(() => states.includes('running'))
    await worker.stop()
    assert.equal(states.at(-1), 'stopped')
  })

  test('a worker process that cannot be spawned is retried, and stop still settles', async () => {
    const execPath = process.execPath
    process.execPath = join(directory, 'missing-executable')
    let supervised
    try {
      supervised = supervise(['ready'])
      await until(() => supervised.states.filter((state) => state === 'starting').length >= 2)
    } finally {
      process.execPath = execPath
    }
    assert.ok(supervised.logs.some((entry) => entry.message === 'worker process error'))
    await supervised.worker.stop()
    assert.equal(supervised.states.at(-1), 'stopped')
  })
})
