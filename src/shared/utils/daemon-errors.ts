/**
 * Reading the errors a remote daemon (msmd) answers with. They reach the app
 * as `Daemon HTTP <status>: <message>`.
 */

export const OLDER_DAEMON_MESSAGE =
  'This host runs an older msmd that does not support this. Update msmd on the host and try again.'

/**
 * Whether an error says that the daemon does not know the route at all.
 * Routes added after a host's msmd was installed answer 404 or 405 there. A
 * 404 the daemon wrote itself names what is missing ("server not found",
 * "backup not found") and is not that.
 */
export function isOlderDaemonError(message: string): boolean {
  if (/^Daemon HTTP 405\b/.test(message)) return true
  return /^Daemon HTTP 404\b/.test(message) && !/(server|backup) not found/.test(message)
}

/**
 * The daemon's own words, without the transport prefix:
 * "Daemon HTTP 409: Stop the server before restoring a backup" reads better
 * as the sentence alone.
 */
export function plainDaemonMessage(message: string): string {
  if (isOlderDaemonError(message)) return OLDER_DAEMON_MESSAGE
  return message.replace(/^Daemon HTTP \d+: /, '')
}

/** What a backup id looks like. Ids end up in request paths: nothing else is sent. */
export function isBackupId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{8}-\d{6}-(manual|pre-restore|scheduled)$/.test(id)
}
