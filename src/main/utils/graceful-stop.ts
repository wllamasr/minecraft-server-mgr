import { spawn, type ChildProcess } from 'child_process'

/** How a process ended up stopping. */
export type StopOutcome = 'graceful' | 'forced'

export interface StopOptions {
  /** Ask the process to shut down on its own (e.g. write `stop` to its console). */
  requestStop: () => void
  /** How long to wait for a clean exit before killing the process tree. */
  timeoutMs: number
  /** How long to wait for the exit after killing. Defaults to 10 s. */
  killWaitMs?: number
  /** Called once when the grace period ran out, right before the kill. */
  onForce?: () => void
  /** Replaces the kill, for tests. Defaults to {@link killProcessTree}. */
  kill?: (child: ChildProcess) => void
}

/**
 * Stop a child process gracefully and resolve only once it is really gone.
 *
 * Waiting for the exit (rather than returning right after the kill) matters:
 * a Minecraft server holds a lock on its world, so starting it again while
 * the old process is still shutting down fails or corrupts data.
 */
export function stopProcess(child: ChildProcess, options: StopOptions): Promise<StopOutcome> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve('graceful')
      return
    }

    let outcome: StopOutcome = 'graceful'
    let graceTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const finish = (): void => {
      clearTimeout(graceTimer)
      clearTimeout(killTimer)
      child.removeListener('exit', finish)
      child.removeListener('error', onError)
      resolve(outcome)
    }
    // A process that failed to spawn reports an error and never exits.
    const onError = (): void => {
      if (child.pid === undefined) finish()
    }
    child.once('exit', finish)
    child.on('error', onError)

    graceTimer = setTimeout(() => {
      outcome = 'forced'
      try {
        options.onForce?.()
      } catch {
        /* reporting must never prevent the kill */
      }
      ;(options.kill ?? killProcessTree)(child)
      // If even the kill has no effect, do not hang the caller forever.
      killTimer = setTimeout(finish, options.killWaitMs ?? 10_000)
    }, options.timeoutMs)

    try {
      options.requestStop()
    } catch {
      /* the grace timer still applies */
    }
  })
}

/**
 * Kill a process together with its descendants.
 *
 * Forge and NeoForge servers are started through `run.bat` / `run.sh`, so the
 * direct child is a shell and the JVM is its child: killing only the direct
 * child would leave the JVM running.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill('SIGKILL'))
    return
  }

  try {
    // Negative pid = the whole process group (the child must be a group leader,
    // i.e. spawned with `detached: true`).
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
