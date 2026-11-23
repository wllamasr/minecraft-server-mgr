import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { stopProcess } from './graceful-stop'

// Stand-ins for a Minecraft server: one obeys `stop` on its console, one
// ignores it, and one hides the real work in a child process (like run.bat).
const OBEDIENT = `process.stdin.on('data', (d) => { if (String(d).includes('stop')) process.exit(0) })`
// Every stand-in gives up after a minute, so a failed test cannot leak it.
const STUBBORN = `process.stdin.resume(); setTimeout(() => process.exit(9), 60000)`
const WRAPPER = `
  const { spawn } = require('child_process')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(9), 60000)'], { stdio: 'ignore' })
  console.log(child.pid)
  process.stdin.resume()
  setTimeout(() => process.exit(9), 60000)
`

const started: ChildProcess[] = []

function start(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: process.platform !== 'win32'
  })
  started.push(child)
  return child
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !isAlive(pid)
}

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

describe('stopProcess', () => {
  it('lets a process that obeys the stop command exit on its own', async () => {
    const child = start(OBEDIENT)
    let forced = false
    const outcome = await stopProcess(child, {
      requestStop: () => child.stdin?.write('stop\n'),
      timeoutMs: 10_000,
      onForce: () => (forced = true)
    })
    expect(outcome).toBe('graceful')
    expect(forced).toBe(false)
    expect(child.exitCode).toBe(0)
  })

  it('kills a process that ignores the stop command, and only then resolves', async () => {
    const child = start(STUBBORN)
    let forced = false
    const outcome = await stopProcess(child, {
      requestStop: () => child.stdin?.write('stop\n'),
      timeoutMs: 300,
      onForce: () => (forced = true)
    })
    expect(outcome).toBe('forced')
    expect(forced).toBe(true)
    // Resolved because the process exited, not because a timer fired.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('kills the descendants of a wrapper process too', async () => {
    const child = start(WRAPPER)
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout?.once('data', (d) => resolve(Number(String(d).trim())))
    })
    expect(isAlive(grandchildPid)).toBe(true)

    const outcome = await stopProcess(child, { requestStop: () => undefined, timeoutMs: 200 })
    expect(outcome).toBe('forced')
    expect(await waitUntilDead(grandchildPid)).toBe(true)
  })

  it('resolves immediately for a process that has already exited', async () => {
    const child = start('process.exit(3)')
    await new Promise((resolve) => child.once('exit', resolve))
    let asked = false
    const outcome = await stopProcess(child, { requestStop: () => (asked = true), timeoutMs: 10_000 })
    expect(outcome).toBe('graceful')
    expect(asked).toBe(false)
  })

  it('still resolves when the kill has no effect', async () => {
    const child = start(STUBBORN)
    const outcome = await stopProcess(child, {
      requestStop: () => undefined,
      timeoutMs: 100,
      killWaitMs: 100,
      kill: () => undefined
    })
    expect(outcome).toBe('forced')
    expect(child.exitCode).toBeNull()
  })

  it('does not wait for a process that never started', async () => {
    const child = spawn('msm-no-such-binary-for-tests', [], { stdio: 'ignore' })
    child.on('error', () => undefined)
    const started = Date.now()
    await stopProcess(child, { requestStop: () => undefined, timeoutMs: 30_000, kill: () => undefined })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('survives a stop request that throws', async () => {
    const child = start(STUBBORN)
    const outcome = await stopProcess(child, {
      requestStop: () => {
        throw new Error('console is gone')
      },
      timeoutMs: 200
    })
    expect(outcome).toBe('forced')
  })
})
