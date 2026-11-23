package server

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/backup"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/schedule"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

// Daily scheduled backups and their retention.
//
// The scheduler starts them like any other backup (see RequestBackup), so
// everything that holds for a backup holds for these: a running server has
// its saving paused, stopping the server cancels it, nothing else runs on the
// server meanwhile. What is different:
//
//   - A server that is busy at the scheduled time is tried again for ten
//     minutes, then the backup is reported as missed.
//   - A stopped server whose files did not change since its last scheduled
//     backup is not backed up again.
//   - Once the new backup is complete, the scheduled backups beyond the number
//     to keep are deleted. Backups made by hand or before a restore never are.
//   - How it went is stored with the server (backupLastRun): nobody is
//     watching the console at four in the morning.

const missedBackupMessage = "It could not be started within 10 minutes of its time (the server was busy, or the host was suspended)"

// restoredMarker is a file in a server's backups folder that says that a
// backup was restored since the last scheduled backup.
const restoredMarker = ".restored"

// backupInFlight reports whether a backup of the server is running.
func (m *Manager) backupInFlight(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	op := m.ops[id]
	return op != nil && op.state.Kind == "backup"
}

// backupTick deals with the backup schedule of one server at now. It reports
// whether the server has a schedule worth remembering. Only the scheduler
// goroutine calls it.
func (m *Manager) backupTick(now time.Time, s store.Server) bool {
	id := s.ID
	previous := m.backupSchedules[id]
	// The note stays until the occurrence is started again or given up on: a
	// tick on which it cannot start must not lose why it is still open.
	m.mu.Lock()
	retry, again := m.backupRetries[id]
	m.mu.Unlock()
	forget := func() {
		m.mu.Lock()
		if m.backupRetries[id].Equal(retry) {
			delete(m.backupRetries, id)
		}
		m.mu.Unlock()
	}
	if again && previous != nil && previous.Schedule == s.BackupSchedule {
		previous = schedule.BackupRetry(previous, retry)
	}

	st, act, err := schedule.TickBackup(now, s.BackupSchedule, previous)
	if err != nil {
		return false // not a schedule: stored by hand, ignore
	}
	m.backupSchedules[id] = st

	if !act.Missed.IsZero() {
		if again {
			forget()
			// It was started, more than once, and the server never answered:
			// that is a failure with a cause, not a busy server.
			m.hub.PushLog(id, fmt.Sprintf("Scheduled backup (%s) given up on: the server still does not answer the save-off command.", s.BackupSchedule), "WARN")
			m.recordBackupRun(id, "failed", errNoSaveOffAnswer.Error())
			return true
		}
		m.hub.PushLog(id, fmt.Sprintf("Scheduled backup (%s) missed: %s.", s.BackupSchedule, lowerFirst(missedBackupMessage)), "WARN")
		m.recordBackupRun(id, "missed", missedBackupMessage)
		return true
	}
	if act.Due.IsZero() {
		if again {
			forget() // nothing is open any more (the schedule changed, say)
		}
		return true
	}
	// Not possible right now (starting, stopping, about to restart after a
	// crash, another backup or a restore): the occurrence stays due and the
	// next tick tries again.
	if m.startScheduledBackup(s, act.Due) {
		// Counted as handled from the moment it starts: a backup that fails
		// is reported, not repeated every fifteen seconds.
		m.backupSchedules[id] = schedule.BackupStarted(st, act.Due)
	}
	return true
}

// startScheduledBackup starts the scheduled backup of s that was due at
// occurrence, if the server is in a state for it.
func (m *Manager) startScheduledBackup(s store.Server, occurrence time.Time) bool {
	op, sv, rs, err := m.beginOperation(s.ID, "backup")
	if err != nil {
		return false
	}
	op.scheduled = true
	// A note to try this occurrence again is settled by this attempt. It is
	// cleared here, before the attempt runs, so that it cannot take away the
	// note the attempt itself may leave.
	m.mu.Lock()
	delete(m.backupRetries, s.ID)
	m.mu.Unlock()
	id := sv.ID
	// How many to keep is read when the backup is done, not now: it may be
	// changed while a long backup runs.
	keepNow := func() int {
		keep := sv.BackupKeep
		if current, err := m.store.Get(id); err == nil {
			keep = current.BackupKeep
		}
		if !schedule.ValidKeep(keep) {
			keep = schedule.KeepDefault
		}
		return keep
	}
	m.hub.PushLog(id, fmt.Sprintf("Scheduled backup (%s).", s.BackupSchedule), "INFO")

	go m.runOperation(op, sv, func() (string, string, error) {
		backupID, err := m.runBackup(op, sv, rs, "scheduled", func(plan *backup.Plan) bool {
			return m.unchangedSinceScheduled(id, plan)
		})
		switch {
		case err == nil:
			// Only now, with the new backup complete and the server saving
			// again, are older ones deleted.
			_ = os.Remove(filepath.Join(m.backupDir(id), restoredMarker))
			m.pruneScheduled(id, keepNow(), backupID)
			m.recordBackupRun(id, "ok", "")
		case errors.Is(err, errUnchanged):
			m.hub.PushLog(id, "Scheduled backup skipped: nothing has changed since the last one.", "INFO")
			// A lowered number to keep still takes effect.
			m.pruneScheduled(id, keepNow(), "")
			m.recordBackupRun(id, "skipped", "")
			return "", "", nil
		case errors.Is(err, errNoSaveOffAnswer):
			// Most likely still starting: not a failure yet. The scheduler
			// tries again while the occurrence is within its window, and
			// reports the failure after that.
			m.mu.Lock()
			if !m.deleting[id] && !m.shuttingDown {
				m.backupRetries[id] = occurrence
			}
			m.mu.Unlock()
		default:
			m.recordBackupRun(id, "failed", err.Error())
		}
		return backupID, "", err
	})
	return true
}

// backupIDs lists the ids of the backups in a server's folder, by file name
// alone: an archive that cannot be read still counts.
func (m *Manager) backupIDs(id string) []string {
	entries, err := os.ReadDir(m.backupDir(id))
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".zip") {
			continue
		}
		if backupID := strings.TrimSuffix(name, ".zip"); backup.ValidID(backupID) {
			out = append(out, backupID)
		}
	}
	return out
}

// unchangedSinceScheduled reports whether the files of a stopped server, as
// listed in plan, are the ones its newest scheduled backup already holds: the
// same number of files, none of them written since. When in doubt the answer
// is no, and a backup is made.
//
// A file that was replaced by one with an older date, with the count staying
// the same, goes unnoticed; so does nothing else.
func (m *Manager) unchangedSinceScheduled(id string, plan *backup.Plan) bool {
	dir := m.backupDir(id)
	if fileExists(filepath.Join(dir, restoredMarker)) {
		return false
	}
	newest := ""
	for _, backupID := range m.backupIDs(id) {
		if _, kind, _ := backup.IDTime(backupID); kind == "scheduled" && backupID > newest {
			newest = backupID
		}
	}
	if newest == "" {
		return false
	}
	at, _, ok := backup.IDTime(newest)
	if !ok {
		return false
	}
	comment, err := backup.ReadComment(filepath.Join(dir, newest+".zip"))
	if err != nil {
		return false
	}
	manifest, ok := backup.ParseManifest(comment)
	if !ok || manifest.FileCount != len(plan.Files) {
		return false
	}
	for _, file := range plan.Files {
		if file.ModTime.After(at) {
			return false
		}
	}
	return true
}

// markRestored notes that a backup was restored over the server's files.
func (m *Manager) markRestored(id string) {
	dir := m.backupDir(id)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, restoredMarker), nil, 0o640)
}

// pruneScheduled deletes the scheduled backups of a server beyond the number
// to keep. justCreated is the backup that was just made, if one was. It never
// fails the backup: what cannot be deleted is tried again next time.
func (m *Manager) pruneScheduled(id string, keep int, justCreated string) {
	doomed := schedule.ScheduledToPrune(m.backupIDs(id), keep, justCreated)
	deleted := 0
	for _, backupID := range doomed {
		if err := os.Remove(filepath.Join(m.backupDir(id), backupID+".zip")); err == nil {
			deleted++
		}
	}
	if deleted > 0 {
		m.hub.PushLog(id, fmt.Sprintf("%d old scheduled backup(s) deleted (the last %d are kept).", deleted, keep), "INFO")
	}
	if failed := len(doomed) - deleted; failed > 0 {
		m.hub.PushLog(id, fmt.Sprintf("%d old scheduled backup(s) could not be deleted.", failed), "WARN")
	}
}

// recordBackupRun stores how a scheduled backup of a server went. A server
// that is gone, or going, is left alone.
func (m *Manager) recordBackupRun(id, outcome, message string) {
	run := &store.BackupRun{At: time.Now().UTC().Format(time.RFC3339), Outcome: outcome, Message: message}
	if _, err := m.mutate(id, func(s *store.Server) { s.BackupLastRun = run }); err != nil && !errors.Is(err, store.ErrNotFound) {
		m.hub.PushLog(id, "Could not store how the scheduled backup went: "+err.Error(), "WARN")
	}
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}
