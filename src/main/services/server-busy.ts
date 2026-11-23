/**
 * Long file operations on a server directory (a backup, a restore) and who
 * has to wait for them.
 *
 * The backup manager needs the server manager (to look servers up) and the
 * server manager needs to know about operations in flight (to refuse a start
 * or cancel a backup before a stop). Keeping that knowledge here lets both
 * depend on this module instead of on each other.
 */

export type BusyKind = 'backup' | 'restore'

interface BusyOperation {
  kind: BusyKind
  /** Ask the operation to stop; resolves when it has wound down completely. */
  cancel: (reason: string) => Promise<void>
}

const operations = new Map<string, BusyOperation>()

/** The operation running on a server's files, if any. */
export function busyKind(serverId: string): BusyKind | undefined {
  return operations.get(serverId)?.kind
}

/**
 * Register an operation. Throws when one is already running on that server:
 * two of them must never touch the same files. Returns the function that
 * marks it finished.
 */
export function beginBusy(serverId: string, operation: BusyOperation): () => void {
  const current = operations.get(serverId)
  if (current) {
    throw new Error(current.kind === 'backup' ? 'A backup of this server is in progress' : 'This server is being restored from a backup')
  }
  operations.set(serverId, operation)
  return () => {
    if (operations.get(serverId) === operation) operations.delete(serverId)
  }
}

/**
 * Cancel whatever is running on a server's files and wait until it is over.
 * A backup stops at once. A restore can only be cancelled before it starts
 * replacing files; past that point this waits for it to finish.
 */
export async function cancelBusy(serverId: string, reason: string): Promise<void> {
  await operations.get(serverId)?.cancel(reason)
}

/** Cancel every operation in flight (the app is exiting). */
export async function cancelAllBusy(reason: string): Promise<void> {
  await Promise.allSettled([...operations.values()].map((operation) => operation.cancel(reason)))
}

export function busyCount(): number {
  return operations.size
}
