/**
 * Why a backup was made: by hand, automatically right before a restore so
 * the restore itself can be undone, or by the daily schedule.
 */
export type BackupKind = 'manual' | 'pre-restore' | 'scheduled'

export interface BackupInfo {
  /** Identifies the backup within its server, e.g. `20261123-153000-manual`. */
  id: string
  serverId: string
  kind: BackupKind
  /** ISO timestamp. */
  createdAt: string
  /** Size of the archive on disk. */
  sizeBytes: number
  /** From the manifest written into the archive; absent when it cannot be read. */
  fileCount?: number
  minecraftVersion?: string
  /** The server was running (and saving was paused) while the backup was made. */
  whileRunning?: boolean
}

export interface BackupProgress {
  serverId: string
  operation: 'backup' | 'restore'
  /**
   * `saving`: waiting for the server to write the world to disk. `done`: the
   * operation is over, whether it worked or not (sent once, last).
   */
  phase: 'saving' | 'copying' | 'replacing' | 'done'
  doneBytes: number
  totalBytes: number
}

export interface RestoreBackupOptions {
  /** Back the current files up first, so the restore can be undone. Default true. */
  backupFirst?: boolean
}
