import { describe, expect, it } from 'vitest'
import { isBackupId, isOlderDaemonError, OLDER_DAEMON_MESSAGE, plainDaemonMessage } from './daemon-errors'

describe('isOlderDaemonError', () => {
  it('recognises a route the daemon does not have', () => {
    expect(isOlderDaemonError('Daemon HTTP 404: 404 page not found\n')).toBe(true)
    expect(isOlderDaemonError('Daemon HTTP 405: Method Not Allowed\n')).toBe(true)
  })

  it('does not mistake a missing server or backup for a missing route', () => {
    expect(isOlderDaemonError('Daemon HTTP 404: server not found')).toBe(false)
    expect(isOlderDaemonError('Daemon HTTP 404: backup not found')).toBe(false)
  })

  it('leaves other errors alone', () => {
    expect(isOlderDaemonError('Daemon HTTP 409: Stop the server before restoring a backup')).toBe(false)
    expect(isOlderDaemonError('Daemon HTTP 400: invalid backup id')).toBe(false)
    expect(isOlderDaemonError('connect ECONNREFUSED 10.0.0.2:8443')).toBe(false)
  })
})

describe('plainDaemonMessage', () => {
  it('keeps the daemon’s sentence and drops the transport prefix', () => {
    expect(plainDaemonMessage('Daemon HTTP 409: Stop the server before restoring a backup')).toBe(
      'Stop the server before restoring a backup'
    )
    expect(plainDaemonMessage('Daemon HTTP 404: backup not found')).toBe('backup not found')
  })

  it('explains an older daemon', () => {
    expect(plainDaemonMessage('Daemon HTTP 404: 404 page not found\n')).toBe(OLDER_DAEMON_MESSAGE)
  })

  it('passes anything else through', () => {
    expect(plainDaemonMessage('Certificate fingerprint mismatch')).toBe('Certificate fingerprint mismatch')
  })
})

describe('isBackupId', () => {
  it('accepts the ids backups get', () => {
    expect(isBackupId('20261123-153000-manual')).toBe(true)
    expect(isBackupId('20261123-153000-pre-restore')).toBe(true)
    expect(isBackupId('20261123-153000-scheduled')).toBe(true)
  })

  it('rejects anything that could change the request path', () => {
    for (const bad of ['', '..', '../20261123-153000-manual', '20261123-153000-manual/restore', '20261123-153000-manual?x=1', '20261123-153000-other', ' 20261123-153000-manual', '20261123-153000-manual\n', null, undefined, 7]) {
      expect(isBackupId(bad)).toBe(false)
    }
  })
})
