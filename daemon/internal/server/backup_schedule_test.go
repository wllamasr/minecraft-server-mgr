package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

// juneAt is a moment of June 2026 on the host's clock, for scheduler ticks.
func juneAt(day, h, mi, s int) time.Time { return time.Date(2026, 6, day, h, mi, s, 0, time.Local) }

// schedules sets the backup schedule (and, when not empty, the restart
// schedule) of a server the way the API does.
func schedules(t *testing.T, m *Manager, id, backupAt string, keep int, restartAt string) {
	t.Helper()
	in := UpdateInput{BackupSchedule: &backupAt, BackupKeep: &keep}
	if restartAt != "" {
		in.RestartSchedule = &restartAt
	}
	if _, err := m.Update(id, in); err != nil {
		t.Fatal(err)
	}
}

// backdate makes every file of a server an hour old, as the files of a server
// that has been sitting there are.
func backdate(t *testing.T, dir string) {
	t.Helper()
	old := time.Now().Add(-time.Hour)
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		return os.Chtimes(path, old, old)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func lastRun(t *testing.T, m *Manager, id string) *store.BackupRun {
	t.Helper()
	s, err := m.store.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return s.BackupLastRun
}

func idle(m *Manager, id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ops[id] == nil
}

// waitRun waits until the last scheduled backup of a server is recorded with
// the given outcome and nothing is running any more.
func waitRun(t *testing.T, m *Manager, id, outcome string) *store.BackupRun {
	t.Helper()
	var run *store.BackupRun
	waitFor(t, "a scheduled backup to be recorded as "+outcome, func() bool {
		run = lastRun(t, m, id)
		return run != nil && run.Outcome == outcome && idle(m, id)
	})
	return run
}

func scheduledArchives(m *Manager, id string) []string {
	var out []string
	for _, name := range archives(m, id) {
		if strings.HasSuffix(name, "-scheduled.zip") {
			out = append(out, name)
		}
	}
	return out
}

func TestScheduledBackupOfAStoppedServerAndTheSkipRule(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "ok", false)
	backdate(t, dir)
	schedules(t, m, "a", "04:30", 7, "")

	m.scheduleTick(juneAt(10, 4, 20, 0)) // first look
	m.scheduleTick(juneAt(10, 4, 29, 50))
	if lastRun(t, m, "a") != nil || len(archives(m, "a")) != 0 {
		t.Fatal("a backup was made before its time")
	}
	m.scheduleTick(juneAt(10, 4, 30, 5)) // due
	waitRun(t, m, "a", "ok")
	if got := scheduledArchives(m, "a"); len(got) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
	v, _ := m.Get("a")
	if v.LastOperation == nil || !v.LastOperation.OK || !v.LastOperation.Scheduled || v.LastOperation.BackupID == "" {
		t.Fatalf("last operation = %+v", v.LastOperation)
	}
	if v.BackupLastRun == nil || v.BackupLastRun.Outcome != "ok" {
		t.Fatalf("the view does not carry the last run: %+v", v.BackupLastRun)
	}
	if out := logs(m, "a"); !strings.Contains(out, "Scheduled backup (04:30).") {
		t.Errorf("not in the console:\n%s", out)
	}

	// The same occurrence is not acted on twice.
	m.scheduleTick(juneAt(10, 4, 30, 20))
	time.Sleep(200 * time.Millisecond)
	if !idle(m, "a") || len(archives(m, "a")) != 1 {
		t.Fatal("the same occurrence was backed up twice")
	}

	// The next day nothing has changed: no second copy of the same files.
	m.scheduleTick(juneAt(11, 4, 30, 5))
	waitRun(t, m, "a", "skipped")
	if len(archives(m, "a")) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
	if out := logs(m, "a"); !strings.Contains(out, "Scheduled backup skipped") || strings.Count(out, "Backup started") != 1 {
		t.Errorf("console:\n%s", out)
	}
	if v, _ := m.Get("a"); v.LastOperation == nil || !v.LastOperation.OK || v.LastOperation.BackupID != "" {
		t.Fatalf("a skip must end well and name no backup: %+v", v.LastOperation)
	}

	// A file changed: backed up again.
	put(t, filepath.Join(dir, "server.properties"), "motd=changed\n")
	m.scheduleTick(juneAt(12, 4, 30, 5))
	waitFor(t, "the second scheduled backup", func() bool { return len(scheduledArchives(m, "a")) == 2 && idle(m, "a") })
	if run := lastRun(t, m, "a"); run.Outcome != "ok" {
		t.Fatalf("last run = %+v", run)
	}
}

func TestScheduledBackupOfARunningServer(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "ok", true)
	schedules(t, m, "a", "04:30", 7, "")
	before := pidOf(m, "a")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	waitRun(t, m, "a", "ok")
	if len(scheduledArchives(m, "a")) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
	waitFor(t, "save-on", func() bool { return strings.Join(commands(cmdLog), " ") == "save-off save-all-flush save-on" })
	if pidOf(m, "a") != before {
		t.Fatal("the server was restarted by its backup")
	}
	// A running server is backed up every day: its files do change.
	m.scheduleTick(juneAt(11, 4, 30, 5))
	waitFor(t, "the second scheduled backup", func() bool { return len(scheduledArchives(m, "a")) == 2 && idle(m, "a") })
}

func TestScheduledBackupsKeepOnlyTheLastOnes(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "ok", false)
	backdate(t, dir)
	schedules(t, m, "a", "04:30", 2, "")

	// Older backups, as file names: what is in them does not matter here.
	seeded := []string{
		"20260601-040000-scheduled", "20260602-040000-scheduled", "20260603-040000-scheduled",
		"20260604-040000-scheduled", "20260101-120000-manual", "20260102-120000-pre-restore",
	}
	for _, id := range seeded {
		put(t, filepath.Join(m.backupDir("a"), id+".zip"), "")
	}
	put(t, filepath.Join(m.backupDir("a"), "notes.txt"), "mine")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	waitRun(t, m, "a", "ok")

	left := strings.Join(archives(m, "a"), " ")
	for _, gone := range seeded[:3] {
		if strings.Contains(left, gone) {
			t.Errorf("%s was kept: %s", gone, left)
		}
	}
	for _, kept := range append(seeded[3:], "notes.txt") {
		if !strings.Contains(left, kept) {
			t.Errorf("%s was deleted: %s", kept, left)
		}
	}
	if got := scheduledArchives(m, "a"); len(got) != 2 {
		t.Fatalf("scheduled archives = %v", got)
	}
	if out := logs(m, "a"); !strings.Contains(out, "3 old scheduled backup(s) deleted") {
		t.Errorf("console:\n%s", out)
	}

	// A lowered number takes effect even when the next backup is skipped.
	schedules(t, m, "a", "04:30", 1, "")
	m.scheduleTick(juneAt(11, 4, 30, 5))
	waitRun(t, m, "a", "skipped")
	got := scheduledArchives(m, "a")
	if len(got) != 1 || strings.HasPrefix(got[0], "202606") {
		t.Fatalf("scheduled archives = %v", got)
	}
	left = strings.Join(archives(m, "a"), " ")
	if !strings.Contains(left, "-manual.zip") || !strings.Contains(left, "-pre-restore.zip") {
		t.Fatalf("a backup that was not scheduled was deleted: %s", left)
	}
}

func TestAFailedScheduledBackupDeletesNothing(t *testing.T) {
	m := newRealManager(t)
	m.saveAllTimeout = 300 * time.Millisecond
	minecraftServer(t, m, "a", "noflush", true)
	schedules(t, m, "a", "04:30", 1, "")
	for _, id := range []string{"20260601-040000-scheduled", "20260602-040000-scheduled"} {
		put(t, filepath.Join(m.backupDir("a"), id+".zip"), "")
	}

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	run := waitRun(t, m, "a", "failed")
	if !strings.Contains(run.Message, "did not finish saving") {
		t.Fatalf("run = %+v", run)
	}
	if got := scheduledArchives(m, "a"); len(got) != 2 {
		t.Fatalf("old backups were deleted although no new one was made: %v", got)
	}
	// Reported, not repeated.
	m.scheduleTick(juneAt(10, 4, 30, 20))
	time.Sleep(200 * time.Millisecond)
	if !idle(m, "a") {
		t.Fatal("a failed scheduled backup was started again")
	}
}

func TestScheduledBackupWaitsForABusyServerAndIsMissedInTheEnd(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "noflush", true)
	schedules(t, m, "a", "04:30", 7, "")
	// A backup made by hand that never gets past the saving.
	if _, err := m.RequestBackup("a"); err != nil {
		t.Fatal(err)
	}

	m.scheduleTick(juneAt(10, 4, 20, 0))
	for _, now := range []time.Time{juneAt(10, 4, 30, 5), juneAt(10, 4, 35, 0), juneAt(10, 4, 39, 55)} {
		m.scheduleTick(now)
		if lastRun(t, m, "a") != nil {
			t.Fatalf("recorded at %v: %+v", now, lastRun(t, m, "a"))
		}
	}
	if out := logs(m, "a"); strings.Contains(out, "Scheduled backup") {
		t.Fatalf("a scheduled backup started on a busy server:\n%s", out)
	}
	m.scheduleTick(juneAt(10, 4, 40, 10))
	run := lastRun(t, m, "a")
	if run == nil || run.Outcome != "missed" || !strings.Contains(run.Message, "within 10 minutes") {
		t.Fatalf("run = %+v", run)
	}
	if out := logs(m, "a"); !strings.Contains(out, "Scheduled backup (04:30) missed") {
		t.Errorf("console:\n%s", out)
	}
	// Given up on once.
	m.scheduleTick(juneAt(10, 4, 40, 25))
	if strings.Count(logs(m, "a"), "missed") != 1 {
		t.Error("the same occurrence was given up on twice")
	}
}

func TestScheduledBackupStartsOnceTheServerIsFree(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "noflush", true)
	backdate(t, dir)
	schedules(t, m, "a", "04:30", 7, "")
	if _, err := m.RequestBackup("a"); err != nil {
		t.Fatal(err)
	}
	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	if lastRun(t, m, "a") != nil {
		t.Fatal("recorded while busy")
	}
	// Stopping the server drops the other backup; the scheduled one is still
	// within its window.
	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the other backup to end", func() bool { return idle(m, "a") })
	m.scheduleTick(juneAt(10, 4, 33, 0))
	waitRun(t, m, "a", "ok")
	if len(scheduledArchives(m, "a")) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
}

func TestScheduledBackupTriesAgainWhenTheServerDoesNotAnswerYet(t *testing.T) {
	m := newRealManager(t)
	m.saveOffTimeout = 200 * time.Millisecond
	minecraftServer(t, m, "a", "mute", true)
	schedules(t, m, "a", "04:30", 7, "")
	attempts := func() int { return strings.Count(logs(m, "a"), "Scheduled backup (04:30).") }
	retryPending := func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, ok := m.backupRetries["a"]
		return ok
	}

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	waitFor(t, "the first attempt to end", func() bool { return idle(m, "a") && retryPending() })
	if attempts() != 1 || lastRun(t, m, "a") != nil {
		t.Fatalf("attempts = %d, run = %+v", attempts(), lastRun(t, m, "a"))
	}
	// A server that is still starting is not a failed backup: tried again.
	m.scheduleTick(juneAt(10, 4, 30, 20))
	waitFor(t, "the second attempt to end", func() bool { return attempts() == 2 && idle(m, "a") && retryPending() })
	if lastRun(t, m, "a") != nil {
		t.Fatalf("run = %+v", lastRun(t, m, "a"))
	}
	// Until its window is over: then it is a failure, with its cause.
	m.scheduleTick(juneAt(10, 4, 41, 0))
	if run := lastRun(t, m, "a"); run == nil || run.Outcome != "failed" || !strings.Contains(run.Message, "did not answer the save-off command") {
		t.Fatalf("run = %+v", run)
	}
	// Reported once.
	m.scheduleTick(juneAt(10, 4, 41, 15))
	if strings.Count(logs(m, "a"), "given up on") != 1 {
		t.Errorf("console:\n%s", logs(m, "a"))
	}
	if attempts() != 2 || len(archives(m, "a")) != 0 {
		t.Fatalf("attempts = %d, archives = %v", attempts(), archives(m, "a"))
	}
}

func TestScheduledRestartWaitsForABackupThatFinishes(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "ok", true)
	schedules(t, m, "a", "04:30", 7, "04:30")
	before := pidOf(m, "a")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5)) // both due: the backup goes first
	if out := logs(m, "a"); !strings.Contains(out, "Scheduled restart (04:30) is waiting for the backup") {
		t.Fatalf("the restart did not wait:\n%s", out)
	}
	waitRun(t, m, "a", "ok")
	if pidOf(m, "a") != before {
		t.Fatal("the server was restarted during its backup")
	}
	m.scheduleTick(juneAt(10, 4, 30, 20))
	waitFor(t, "the restart that was put off", func() bool {
		pid := pidOf(m, "a")
		return pid != 0 && pid != before && m.statusOf("a") == StatusRunning
	})
	if len(scheduledArchives(m, "a")) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
	// And only once.
	after := pidOf(m, "a")
	m.scheduleTick(juneAt(10, 4, 30, 35))
	time.Sleep(300 * time.Millisecond)
	if pidOf(m, "a") != after {
		t.Fatal("the restart that was put off happened twice")
	}
}

func TestScheduledRestartDoesNotWaitForEver(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "noflush", true) // the backup never gets past the saving
	schedules(t, m, "a", "04:30", 7, "04:30")
	before := pidOf(m, "a")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	m.scheduleTick(juneAt(10, 4, 40, 0))
	time.Sleep(300 * time.Millisecond)
	if pidOf(m, "a") != before || idle(m, "a") {
		t.Fatal("the restart did not wait for the backup")
	}
	m.scheduleTick(juneAt(10, 4, 45, 10)) // 15 minutes are over
	waitFor(t, "the restart", func() bool {
		pid := pidOf(m, "a")
		return pid != 0 && pid != before && m.statusOf("a") == StatusRunning
	})
	run := waitRun(t, m, "a", "failed")
	if !strings.Contains(run.Message, "the server is stopping") {
		t.Fatalf("run = %+v", run)
	}
	if len(archives(m, "a")) != 0 {
		t.Fatalf("a cancelled backup left an archive: %v", archives(m, "a"))
	}
}

func TestAPutOffRestartIsDroppedWhenTheServerIsStopped(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "noflush", true)
	schedules(t, m, "a", "04:30", 7, "04:30")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the backup to end", func() bool { return idle(m, "a") })
	m.scheduleTick(juneAt(10, 4, 31, 0))
	time.Sleep(300 * time.Millisecond)
	if pidOf(m, "a") != 0 {
		t.Fatal("a stopped server was started by a restart that was put off")
	}
}

func TestARestoreMakesTheNextScheduledBackupHappen(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "ok", false)
	backdate(t, dir)
	schedules(t, m, "a", "04:30", 7, "")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	waitRun(t, m, "a", "ok")
	first := strings.TrimSuffix(scheduledArchives(m, "a")[0], ".zip")

	// Restoring puts files back with the dates they had: by their dates alone
	// the server would look untouched.
	put(t, filepath.Join(dir, "world", "level.dat"), "LEVEL-2")
	opID, err := m.RequestRestore("a", first, false)
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.OK {
		t.Fatalf("restore: %+v", res)
	}
	m.scheduleTick(juneAt(11, 4, 30, 5))
	waitFor(t, "a scheduled backup after the restore", func() bool { return len(scheduledArchives(m, "a")) == 2 && idle(m, "a") })
	if run := lastRun(t, m, "a"); run.Outcome != "ok" {
		t.Fatalf("run = %+v", run)
	}
	// After which the server counts as unchanged again.
	m.scheduleTick(juneAt(12, 4, 30, 5))
	waitRun(t, m, "a", "skipped")
}

func TestDeletingAServerDuringItsScheduledBackupLeavesNothing(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "noflush", true)
	schedules(t, m, "a", "04:30", 7, "")

	m.scheduleTick(juneAt(10, 4, 20, 0))
	m.scheduleTick(juneAt(10, 4, 30, 5))
	if idle(m, "a") {
		t.Fatal("the scheduled backup did not start")
	}
	if _, err := m.RequestDelete("a"); err != nil {
		t.Fatal(err)
	}
	m.WaitDeletes()
	waitFor(t, "the backup to end", func() bool { return idle(m, "a") })
	if _, err := m.store.Get("a"); err == nil {
		t.Fatal("the record of a deleted server was written back")
	}
	if len(m.store.List()) != 0 {
		t.Fatalf("store = %+v", m.store.List())
	}
	for _, path := range []string{dir, m.backupDir("a")} {
		if fileExists(path) {
			t.Errorf("%s was left behind", path)
		}
	}
	// The scheduler forgets it.
	m.scheduleTick(juneAt(10, 4, 30, 20))
	if len(m.backupSchedules) != 0 || len(m.deferredRestarts) != 0 {
		t.Fatalf("scheduler memory = %v %v", m.backupSchedules, m.deferredRestarts)
	}
}

func TestUpdateChecksTheBackupSettings(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "a", "")
	str := func(s string) *string { return &s }
	num := func(n int) *int { return &n }

	for name, in := range map[string]UpdateInput{
		"time":           {BackupSchedule: str("4:30")},
		"keep 0":         {BackupKeep: num(0)},
		"keep 366":       {BackupKeep: num(366)},
		"good and wrong": {BackupSchedule: str("04:30"), BackupKeep: num(-1)},
	} {
		if _, err := m.Update("a", in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if s, _ := m.store.Get("a"); s.BackupSchedule != "" || s.BackupKeep != 0 {
		t.Fatalf("a refused update changed the server: %+v", s)
	}

	v, err := m.Update("a", UpdateInput{BackupSchedule: str("04:30"), BackupKeep: num(3)})
	if err != nil || v.BackupSchedule != "04:30" || v.BackupKeep != 3 {
		t.Fatalf("update = %+v, %v", v, err)
	}
	// One setting at a time leaves the others alone.
	if v, err = m.Update("a", UpdateInput{RestartSchedule: str("05:00")}); err != nil || v.BackupSchedule != "04:30" || v.BackupKeep != 3 {
		t.Fatalf("update = %+v, %v", v, err)
	}
	if v, err = m.Update("a", UpdateInput{BackupSchedule: str("")}); err != nil || v.BackupSchedule != "" || v.BackupKeep != 3 || v.RestartSchedule != "05:00" {
		t.Fatalf("update = %+v, %v", v, err)
	}
	if _, err := m.Update("nope", UpdateInput{BackupKeep: num(3)}); err != store.ErrNotFound {
		t.Fatalf("unknown server: %v", err)
	}
}
