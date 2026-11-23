package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/backup"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

const (
	// defaultSaveOffTimeout is how long a running server gets to answer "save-off".
	defaultSaveOffTimeout = 15 * time.Second
	// defaultSaveAllTimeout is how long it gets to write the world to disk.
	defaultSaveAllTimeout = 180 * time.Second
	// freeSpaceMargin is what must stay free on the disk beyond what an
	// operation needs.
	freeSpaceMargin = 64 << 20
)

// ErrBackupNotFound says that a server has no backup with the given id.
var ErrBackupNotFound = errors.New("backup not found")

// conflictError is a request that is valid but cannot be carried out in the
// state the server is in right now.
type conflictError string

func (e conflictError) Error() string { return string(e) }

// IsConflict reports whether err says that the server is in the wrong state
// for what was asked (as opposed to the request itself being wrong).
func IsConflict(err error) bool {
	var c conflictError
	return errors.As(err, &c)
}

// OperationState is a backup or a restore in flight.
type OperationState struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "backup" or "restore"
	// Phase is "saving" (waiting for the running server to write the world to
	// disk), "copying" or "replacing" (a restore putting the files in place).
	Phase      string `json:"phase"`
	DoneBytes  int64  `json:"doneBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

// OperationResult is how the last backup or restore of a server ended. It is
// kept in memory only: a daemon restart forgets it.
type OperationResult struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	OK        bool   `json:"ok"`
	Cancelled bool   `json:"cancelled,omitempty"`
	Error     string `json:"error,omitempty"`
	// Warning is set when the operation went through but left something to do.
	Warning string `json:"warning,omitempty"`
	// BackupID is the backup that was made or restored.
	BackupID string `json:"backupId,omitempty"`
	// Scheduled is set for a backup the schedule started; how those went is
	// also kept, across daemon restarts, in the server's backupLastRun.
	Scheduled  bool   `json:"scheduled,omitempty"`
	FinishedAt string `json:"finishedAt"`
}

// operation is the daemon's side of an OperationState. All fields but ctx,
// cancel and done are guarded by Manager.mu.
type operation struct {
	state  OperationState
	ctx    context.Context
	cancel context.CancelCauseFunc
	done   chan struct{}
	// committed is set once a restore starts replacing files: from then on it
	// runs to the end, and whoever needs it gone waits.
	committed bool
	// savePaused is set while the running server has (or may have) automatic
	// saving turned off for this backup.
	savePaused bool
	// scheduled says that the schedule started this backup. Set before the
	// operation runs and not changed after.
	scheduled bool
}

type lineWatcher struct{ fn func(line string) }

// watch calls fn with every line the server writes to its output from now
// on, until the returned function is called. fn runs on the goroutine that
// reads the output and must not block.
func (m *Manager) watch(id string, fn func(line string)) (remove func()) {
	w := &lineWatcher{fn: fn}
	m.mu.Lock()
	m.watchers[id] = append(m.watchers[id], w)
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		list := m.watchers[id]
		for i, other := range list {
			if other == w {
				m.watchers[id] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
		if len(m.watchers[id]) == 0 {
			delete(m.watchers, id)
		}
	}
}

func (m *Manager) notifyWatchers(id, line string) {
	m.mu.Lock()
	list := m.watchers[id]
	m.mu.Unlock()
	for _, w := range list {
		w.fn(line)
	}
}

// safeID is what a server id may look like to be used as a folder name.
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (m *Manager) backupDir(id string) string { return filepath.Join(m.cfg.BackupsRoot, id) }

func stageDir(s store.Server) string { return s.Dir + ".restore-stage" }
func asideDir(s store.Server) string { return s.Dir + ".restore-aside" }

// ListBackups returns the backups of a server, newest first.
func (m *Manager) ListBackups(id string) ([]backup.Info, error) {
	if _, err := m.store.Get(id); err != nil {
		return nil, err
	}
	if !safeID.MatchString(id) {
		return []backup.Info{}, nil
	}
	return backup.List(m.backupDir(id), id)
}

// DeleteBackup deletes one backup of a server.
func (m *Manager) DeleteBackup(id, backupID string) error {
	if _, err := m.store.Get(id); err != nil {
		return err
	}
	if !backup.ValidID(backupID) || !safeID.MatchString(id) {
		return errors.New("invalid backup id")
	}
	m.mu.Lock()
	op := m.ops[id]
	restoring := op != nil && op.state.Kind == "restore"
	m.mu.Unlock()
	if restoring {
		return conflictError("A backup of this server is being restored; wait until it is done")
	}
	if err := os.Remove(filepath.Join(m.backupDir(id), backupID+".zip")); err != nil {
		if os.IsNotExist(err) {
			return ErrBackupNotFound
		}
		return err
	}
	m.hub.PushLog(id, "Backup "+backupID+" deleted.", "INFO")
	return nil
}

// RequestBackup starts a backup of a server and returns at once with the id
// of the operation. Progress and the outcome show in the server's view
// ("operation", then "lastOperation" with the same id) and in its console.
//
// A running server is backed up while it runs: its automatic saving is paused
// and the world written to disk first. Stopping, restarting or deleting the
// server cancels the backup.
func (m *Manager) RequestBackup(id string) (string, error) {
	op, s, rs, err := m.beginOperation(id, "backup")
	if err != nil {
		return "", err
	}
	go m.runOperation(op, s, func() (string, string, error) {
		backupID, err := m.runBackup(op, s, rs, "manual", nil)
		return backupID, "", err
	})
	return op.state.ID, nil
}

// RequestRestore starts replacing the files of a stopped server with a backup
// and returns at once with the id of the operation. With backupFirst the
// current files are backed up first, so the restore can be undone.
func (m *Manager) RequestRestore(id, backupID string, backupFirst bool) (string, error) {
	if _, err := m.store.Get(id); err != nil {
		return "", err
	}
	if !backup.ValidID(backupID) || !safeID.MatchString(id) {
		return "", errors.New("invalid backup id")
	}
	if _, err := os.Stat(filepath.Join(m.backupDir(id), backupID+".zip")); err != nil {
		return "", ErrBackupNotFound
	}
	op, s, _, err := m.beginOperation(id, "restore")
	if err != nil {
		return "", err
	}
	go m.runOperation(op, s, func() (string, string, error) {
		warning, err := m.runRestore(op, s, backupID, backupFirst)
		return backupID, warning, err
	})
	return op.state.ID, nil
}

// beginOperation registers a backup or a restore of a server, or says why it
// cannot run now. rs is the server's process when it is running.
func (m *Manager) beginOperation(id, kind string) (*operation, store.Server, *runningServer, error) {
	s, err := m.store.Get(id)
	if err != nil {
		return nil, store.Server{}, nil, err
	}
	if !safeID.MatchString(id) {
		return nil, store.Server{}, nil, errors.New("this server's id cannot be used for backups")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	// Again under the lock: a delete that finished in between has lifted its
	// "deleting" mark, and an operation must not bring the server's folders back.
	if _, err := m.store.Get(id); err != nil {
		return nil, store.Server{}, nil, err
	}
	refuse := func(msg string) (*operation, store.Server, *runningServer, error) {
		return nil, store.Server{}, nil, conflictError(msg)
	}
	rs := m.running[id]
	switch {
	case m.shuttingDown:
		return refuse("the daemon is shutting down")
	case m.deleting[id]:
		return refuse("server is being deleted")
	case m.ops[id] != nil:
		return refuse("A backup or a restore of this server is already in progress")
	case m.provisioning[id] == StatusProvisioning:
		return refuse("server is still being provisioned")
	case m.provisioning[id] != "":
		return refuse("The server was not set up completely; there is nothing to back up or restore")
	case m.starting[id] > 0:
		return refuse("The server is starting; try again once it is up")
	case m.restarting[id]:
		return refuse("The server is restarting; try again once it is up")
	case m.restartTimers[id] != nil:
		return refuse("The server is about to restart after a crash; try again in a moment")
	case rs != nil && rs.stopping:
		return refuse("The server is stopping; try again once it has stopped")
	case rs != nil && kind == "restore":
		return refuse("Stop the server before restoring a backup")
	}

	ctx, cancel := context.WithCancelCause(context.Background())
	op := &operation{
		state:  OperationState{ID: newID()[:12], Kind: kind, Phase: "copying"},
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	m.ops[id] = op
	m.opsWG.Add(1)
	return op, s, rs, nil
}

// runOperation runs a registered operation to its end and records the result.
func (m *Manager) runOperation(op *operation, s store.Server, run func() (backupID, warning string, err error)) {
	backupID, warning, err := run()

	result := OperationResult{
		ID:         op.state.ID,
		Kind:       op.state.Kind,
		OK:         err == nil,
		Warning:    warning,
		Scheduled:  op.scheduled,
		FinishedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err == nil {
		result.BackupID = backupID
	} else {
		result.Error = err.Error()
		result.Cancelled = errors.Is(err, backup.ErrCancelled)
	}

	m.mu.Lock()
	delete(m.ops, s.ID)
	// A server that is being deleted leaves nothing behind.
	if !m.deleting[s.ID] {
		m.lastOps[s.ID] = &result
	}
	m.mu.Unlock()
	op.cancel(nil)
	close(op.done)
	m.opsWG.Done()
}

func (m *Manager) setPhase(op *operation, phase string) {
	m.mu.Lock()
	op.state.Phase = phase
	op.state.DoneBytes, op.state.TotalBytes = 0, 0
	m.mu.Unlock()
}

func (m *Manager) progress(op *operation) backup.Progress {
	return func(done, total int64) {
		m.mu.Lock()
		op.state.DoneBytes, op.state.TotalBytes = done, total
		m.mu.Unlock()
	}
}

// cancelOpLocked tells the operation of a server to stop, unless it is past
// the point of no return. It returns the operation either way, for callers
// that must wait until it is gone. m.mu must be held.
func (m *Manager) cancelOpLocked(id, reason string) *operation {
	op := m.ops[id]
	if op != nil && !op.committed {
		op.cancel(errors.New(reason))
	}
	return op
}

var errNothingToBackUp = errors.New("The server has no files to back up")

// errUnchanged says that a backup was not made because the caller's check
// found nothing new to back up.
var errUnchanged = errors.New("nothing has changed since the last scheduled backup")

// errNoSaveOffAnswer says that a running server did not react to "save-off":
// it is most likely still starting.
var errNoSaveOffAnswer = errors.New("The server did not answer the save-off command. If it is still starting, try again once it is up.")

func ensureFreeSpace(dir string, needed int64) error {
	free, ok := backup.FreeSpace(dir)
	if !ok {
		return nil // Cannot tell here; the write itself fails if it must.
	}
	if needed < 0 || free < uint64(needed)+freeSpaceMargin {
		return fmt.Errorf("Not enough free disk space: this needs about %s and only %s is free", formatBytes(needed), formatBytes(int64(free)))
	}
	return nil
}

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

// runBackup makes one backup of s and returns its id. rs is the server's
// process when the backup is made while it runs.
//
// unchanged, when given, is asked about the files of a stopped server before
// anything is copied: if it says that nothing is new, no backup is made and
// the error is errUnchanged. (A running server always has something new.)
func (m *Manager) runBackup(op *operation, s store.Server, rs *runningServer, kind string, unchanged func(*backup.Plan) bool) (id string, err error) {
	started := time.Now()
	hot := rs != nil
	defer func() {
		switch {
		case err == nil, errors.Is(err, errUnchanged), errors.Is(err, errNothingToBackUp) && kind == "pre-restore":
		case errors.Is(err, backup.ErrCancelled):
			m.hub.PushLog(s.ID, "Backup cancelled ("+cancelReason(err)+").", "WARN")
		default:
			m.hub.PushLog(s.ID, "Backup failed: "+err.Error(), "WARN")
		}
	}()

	var plan *backup.Plan
	if !hot && unchanged != nil {
		if plan, err = backup.MakePlan(op.ctx, s.Dir); err != nil {
			return "", err
		}
		if len(plan.Files) > 0 && unchanged(plan) {
			return "", errUnchanged
		}
	}
	if hot {
		m.hub.PushLog(s.ID, "Backup started — pausing world saving for a consistent copy...", "INFO")
	} else {
		m.hub.PushLog(s.ID, "Backup started...", "INFO")
	}

	dir := m.backupDir(s.ID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	backup.SweepPartials(dir)

	if hot {
		m.setPhase(op, "saving")
		resume, err := m.pauseSaving(op, s.ID, rs)
		if err != nil {
			return "", err
		}
		defer resume()
	}

	m.setPhase(op, "copying")
	if plan == nil {
		if plan, err = backup.MakePlan(op.ctx, s.Dir); err != nil {
			return "", err
		}
	}
	if len(plan.Files) == 0 {
		return "", errNothingToBackUp
	}
	if err := ensureFreeSpace(dir, plan.TotalBytes); err != nil {
		return "", err
	}

	id = backup.NewID(time.Now(), kind)
	// Two backups within one second (a manual one, then a restore).
	for fileExists(filepath.Join(dir, id+".zip")) {
		select {
		case <-op.ctx.Done():
			return "", backup.Cancelled(op.ctx)
		case <-time.After(time.Second):
		}
		id = backup.NewID(time.Now(), kind)
	}
	at, _, _ := backup.IDTime(id)
	manifest := backup.Manifest{
		Format:           1,
		ServerID:         s.ID,
		ServerName:       s.Name,
		MinecraftVersion: s.MinecraftVersion,
		CreatedAt:        at.Format("2006-01-02T15:04:05.000Z"),
		Kind:             kind,
		WhileRunning:     hot,
		FileCount:        len(plan.Files),
		TotalBytes:       plan.TotalBytes,
	}
	if s.ModLoader != "" {
		loader := s.ModLoader
		manifest.ModLoader = &loader
	}
	comment, err := backup.ASCIIJSON(manifest)
	if err != nil {
		return "", err
	}
	zipPath := filepath.Join(dir, id+".zip")
	if err := backup.Write(op.ctx, plan, zipPath, comment, m.progress(op)); err != nil {
		return "", err
	}
	// The server went away while its files were being read: it writes the
	// world on its way out, so the copy may hold files from two moments.
	if hot {
		if err := backup.Cancelled(op.ctx); err != nil {
			_ = os.Remove(zipPath)
			return "", err
		}
		select {
		case <-rs.exited:
			_ = os.Remove(zipPath)
			return "", fmt.Errorf("%w: the server stopped", backup.ErrCancelled)
		default:
		}
	}

	size := int64(0)
	if st, err := os.Stat(zipPath); err == nil {
		size = st.Size()
	}
	seconds := int(time.Since(started).Round(time.Second) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	msg := fmt.Sprintf("Backup finished: %d file(s), %s, in %ds.", len(plan.Files), formatBytes(size), seconds)
	level := "INFO"
	if n := len(plan.Skipped); n > 0 {
		msg += fmt.Sprintf(" %d entr(y/ies) skipped (links or unreadable files).", n)
		level = "WARN"
	}
	m.hub.PushLog(s.ID, msg, level)
	return id, nil
}

func cancelReason(err error) string {
	msg := err.Error()
	prefix := backup.ErrCancelled.Error() + ": "
	if len(msg) > len(prefix) && msg[:len(prefix)] == prefix {
		return msg[len(prefix):]
	}
	return "cancelled"
}

// pauseSaving brings a running server to a state its files can be copied in:
// automatic saving off, everything written to disk. It returns the function
// that turns saving back on (if it was on before).
//
// Without this the copy would catch region files halfway through a write. If
// the server does not confirm, the backup fails rather than produce an
// archive nobody can vouch for.
func (m *Manager) pauseSaving(op *operation, id string, rs *runningServer) (resume func(), err error) {
	if err := backup.Cancelled(op.ctx); err != nil {
		return nil, err
	}
	offCh := make(chan string, 1)
	savedCh := make(chan struct{}, 1)
	var flushing atomic.Bool
	// Listen before sending, so the answer cannot slip by.
	unwatch := m.watch(id, func(line string) {
		if answer := backup.SaveOffAnswer(line); answer != "" {
			select {
			case offCh <- answer:
			default:
			}
		}
		if flushing.Load() && backup.IsSaveFinished(line) {
			select {
			case savedCh <- struct{}{}:
			default:
			}
		}
	})
	defer unwatch()

	send := func(command string) error {
		_, err := io.WriteString(rs.stdin, command+"\n")
		return err
	}
	setPaused := func(v bool) {
		m.mu.Lock()
		op.savePaused = v
		m.mu.Unlock()
	}

	// From here on the server may have saving off: a stop request turns it
	// back on itself (see beginStop), whatever this goroutine is doing.
	setPaused(true)
	if err := send("save-off"); err != nil {
		setPaused(false)
		return nil, errors.New("Could not send commands to the server")
	}
	// The command was sent, so the server may still act on it later (it reads
	// its input only once it has started). Never leave saving off behind an
	// answer nobody saw: turn it back on.
	giveUp := func(err error) (func(), error) {
		_ = send("save-on")
		setPaused(false)
		return nil, err
	}
	var answer string
	offTimer := time.NewTimer(m.saveOffTimeout)
	defer offTimer.Stop()
	select {
	case answer = <-offCh:
	case <-rs.exited:
		setPaused(false)
		return nil, fmt.Errorf("%w: the server stopped", backup.ErrCancelled)
	case <-op.ctx.Done():
		return giveUp(backup.Cancelled(op.ctx))
	case <-offTimer.C:
		return giveUp(errNoSaveOffAnswer)
	}

	// Leave saving off if an admin had turned it off on purpose.
	wasOn := answer == "disabled"
	resume = func() {
		if wasOn {
			_ = send("save-on")
		}
		setPaused(false)
	}

	flushing.Store(true)
	if err := send("save-all flush"); err != nil {
		resume()
		return nil, errors.New("Could not send commands to the server")
	}
	saveTimer := time.NewTimer(m.saveAllTimeout)
	defer saveTimer.Stop()
	select {
	case <-savedCh:
	case <-rs.exited:
		setPaused(false)
		return nil, fmt.Errorf("%w: the server stopped", backup.ErrCancelled)
	case <-op.ctx.Done():
		resume()
		return nil, backup.Cancelled(op.ctx)
	case <-saveTimer.C:
		resume()
		return nil, fmt.Errorf("The server did not finish saving within %d seconds", int(m.saveAllTimeout.Seconds()))
	}
	return resume, nil
}

// runRestore replaces the files of a stopped server with a backup. warning is
// set when the restore went through but left something for the user to do.
func (m *Manager) runRestore(op *operation, s store.Server, backupID string, backupFirst bool) (warning string, err error) {
	m.hub.PushLog(s.ID, "Restoring backup "+backupID+"...", "INFO")
	defer func() {
		switch {
		case err == nil:
		case errors.Is(err, backup.ErrCancelled):
			m.hub.PushLog(s.ID, "Restore cancelled ("+cancelReason(err)+"); the server files were not changed.", "WARN")
		default:
			m.hub.PushLog(s.ID, "Restore failed: "+err.Error(), "ERROR")
		}
	}()

	zipPath := filepath.Join(m.backupDir(s.ID), backupID+".zip")
	comment, err := backup.ReadComment(zipPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrBackupNotFound
		}
		return "", errors.New("This file is damaged or is not a backup made by this software")
	}
	// An archive without the manifest this software writes, or with no files,
	// is not restored: it would only empty the server.
	manifest, err := backup.RestorableManifest(comment)
	if err != nil {
		return "", err
	}
	stage, aside := stageDir(s), asideDir(s)
	if fileExists(aside) {
		return "", fmt.Errorf("An earlier restore left the previous files in %s. Delete that folder first.", aside)
	}

	if backupFirst {
		_, err := m.runBackup(op, s, nil, "pre-restore", nil)
		switch {
		case err == nil, errors.Is(err, errNothingToBackUp):
		case errors.Is(err, backup.ErrCancelled):
			return "", err
		default:
			return "", fmt.Errorf("The current files could not be backed up first, so nothing was changed: %w", err)
		}
	}

	m.setPhase(op, "copying")
	if err := ensureFreeSpace(filepath.Dir(s.Dir), manifest.TotalBytes); err != nil {
		return "", err
	}
	// The backup is unpacked next to the server first: the server's files are
	// only touched once the whole backup is known to be readable.
	if err := os.RemoveAll(stage); err != nil {
		return "", err
	}
	if err := os.Mkdir(stage, 0o750); err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	count, err := backup.Extract(op.ctx, zipPath, stage, manifest.TotalBytes, m.progress(op))
	if err != nil {
		return "", err
	}
	if count != manifest.FileCount {
		return "", fmt.Errorf("This backup is damaged: it holds %d file(s) instead of %d", count, manifest.FileCount)
	}

	// The point of no return: a stop, delete or shutdown from here on waits.
	m.mu.Lock()
	if err := backup.Cancelled(op.ctx); err != nil {
		m.mu.Unlock()
		return "", err
	}
	op.committed = true
	op.state.Phase = "replacing"
	op.state.DoneBytes, op.state.TotalBytes = 0, 0
	m.mu.Unlock()

	if err := backup.Swap(s.Dir, stage, aside); err != nil {
		var leftover *backup.LeftoverError
		if !errors.As(err, &leftover) {
			return "", err
		}
		warning = err.Error()
		m.hub.PushLog(s.ID, warning, "WARN")
	}
	// The files now carry the dates they had when the backup was made: the
	// next scheduled backup must not take the server for unchanged.
	m.markRestored(s.ID)
	m.hub.PushLog(s.ID, fmt.Sprintf("Backup %s restored: %d file(s).", backupID, count), "INFO")
	return warning, nil
}
