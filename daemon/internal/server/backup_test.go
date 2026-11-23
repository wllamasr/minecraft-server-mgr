package server

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/backup"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

const (
	fakeSavesEnv  = "MSMD_TEST_SAVES"
	fakeCmdLogEnv = "MSMD_TEST_CMDLOG"
)

// runFakeMinecraft stands in for a server that answers the save commands the
// way Minecraft does, in the lines Minecraft logs. MSMD_TEST_SAVES picks how
// well it behaves: "ok", "mute" (never answers save-off), "noflush" (never
// finishes save-all) or "already-off" (an admin had turned saving off). Every
// command it receives is appended to the file MSMD_TEST_CMDLOG names.
func runFakeMinecraft() {
	saves := os.Getenv(fakeSavesEnv)
	say := func(msg string) { fmt.Println("[12:00:00] [Server thread/INFO]: " + msg) }
	record := func(command string) {
		f, err := os.OpenFile(os.Getenv(fakeCmdLogEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		fmt.Fprintln(f, command)
		f.Close()
	}
	say(`Done (1.0s)! For help, type "help"`)
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		command := strings.TrimSpace(sc.Text())
		record(command)
		switch command {
		case "save-off":
			switch saves {
			case "mute":
			case "already-off":
				say("Saving is already turned off")
			default:
				// A player trying to pass for the server must not count.
				say("<Steve> Saved the game")
				say("Automatic saving is now disabled")
			}
		case "save-all flush":
			if saves != "noflush" {
				say("Saving the game (this may take a moment!)")
				say("Saved the game")
			}
		case "save-on":
			say("Automatic saving is now enabled")
		case "stop":
			say("Stopping the server")
			os.Exit(0)
		}
	}
	os.Exit(0)
}

// minecraftServer registers and starts a fake Minecraft server with a small
// world, and returns its directory and the file its commands are logged to.
func minecraftServer(t *testing.T, m *Manager, id, saves string, start bool) (dir, cmdLog string) {
	t.Helper()
	realServer(t, m, id, "")
	s, err := m.store.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	dir = s.Dir
	put(t, filepath.Join(dir, "server.properties"), "motd=original\n")
	put(t, filepath.Join(dir, "world", "level.dat"), "LEVEL-1")
	put(t, filepath.Join(dir, "world", "region", "r.0.0.mca"), strings.Repeat("R", 4096))
	put(t, filepath.Join(dir, "logs", "latest.log"), "log\n")
	cmdLog = filepath.Join(t.TempDir(), "commands.log")
	t.Setenv(fakeServerEnv, "minecraft")
	t.Setenv(fakeSavesEnv, saves)
	t.Setenv(fakeCmdLogEnv, cmdLog)
	if start {
		if err := m.Start(id); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the server to come up", func() bool { return strings.Contains(logs(m, id), "Done (") })
	}
	return dir, cmdLog
}

func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return string(b)
}

func commands(path string) []string {
	b, _ := os.ReadFile(path)
	return strings.Fields(strings.ReplaceAll(strings.TrimSpace(string(b)), "save-all flush", "save-all-flush"))
}

// result waits for the operation opID of a server to end.
func result(t *testing.T, m *Manager, id, opID string) OperationResult {
	t.Helper()
	var out OperationResult
	waitFor(t, "the operation to end", func() bool {
		v, err := m.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if v.LastOperation != nil && v.LastOperation.ID == opID {
			if v.Operation != nil {
				t.Fatal("the operation is reported as both running and finished")
			}
			out = *v.LastOperation
			return true
		}
		return false
	})
	return out
}

func archives(m *Manager, id string) []string {
	entries, _ := os.ReadDir(m.backupDir(id))
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestBackupOfARunningServerPausesSaving(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "ok", true)

	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if !res.OK || res.Kind != "backup" || !backup.ValidID(res.BackupID) {
		t.Fatalf("result = %+v\n%s", res, logs(m, "a"))
	}
	// Saving is paused before anything is read, and turned back on after
	// (the server records that a moment after the backup is reported done).
	waitFor(t, "save-on", func() bool { return strings.Join(commands(cmdLog), " ") == "save-off save-all-flush save-on" })

	list, err := m.ListBackups("a")
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	info := list[0]
	// server.jar, server.properties, level.dat and the region file; not the log.
	if info.ID != res.BackupID || info.Kind != "manual" || info.FileCount != 4 || info.WhileRunning == nil || !*info.WhileRunning {
		t.Fatalf("info = %+v", info)
	}
	zr, err := zip.OpenReader(filepath.Join(m.backupDir("a"), info.ID+".zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "logs/") {
			t.Fatalf("the backup contains %s", f.Name)
		}
	}
	var manifest map[string]any
	if err := json.Unmarshal([]byte(zr.Comment), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["serverId"] != "a" || manifest["whileRunning"] != true || manifest["modLoader"] != nil || manifest["format"] != float64(1) {
		t.Fatalf("manifest = %v", manifest)
	}
	if !strings.Contains(logs(m, "a"), "Backup finished: 4 file(s)") {
		t.Fatalf("no summary in the console:\n%s", logs(m, "a"))
	}
}

func TestBackupLeavesSavingOffWhenAnAdminTurnedItOff(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "already-off", true)
	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.OK {
		t.Fatalf("result = %+v", res)
	}
	if got := strings.Join(commands(cmdLog), " "); got != "save-off save-all-flush" {
		t.Fatalf("commands = %q", got)
	}
}

func TestBackupFailsWhenTheServerDoesNotAnswer(t *testing.T) {
	m := newRealManager(t)
	m.saveOffTimeout = 300 * time.Millisecond
	_, cmdLog := minecraftServer(t, m, "a", "mute", true)

	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if res.OK || res.Cancelled || !strings.Contains(res.Error, "did not answer the save-off command") {
		t.Fatalf("result = %+v", res)
	}
	// The server may still act on the save-off later: it is told to save again.
	waitFor(t, "save-on", func() bool { return strings.Join(commands(cmdLog), " ") == "save-off save-on" })
	if left := archives(m, "a"); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
}

func TestBackupFailsWhenTheSaveDoesNotFinish(t *testing.T) {
	m := newRealManager(t)
	m.saveAllTimeout = 300 * time.Millisecond
	_, cmdLog := minecraftServer(t, m, "a", "noflush", true)

	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if res.OK || !strings.Contains(res.Error, "did not finish saving") {
		t.Fatalf("result = %+v", res)
	}
	waitFor(t, "save-on", func() bool { return strings.Join(commands(cmdLog), " ") == "save-off save-all-flush save-on" })
}

func TestStopCancelsABackup(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "noflush", true)

	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the save to start", func() bool { return strings.Contains(strings.Join(commands(cmdLog), " "), "save-all-flush") })
	if v, _ := m.Get("a"); v.Operation == nil || v.Operation.ID != opID || v.Operation.Phase != "saving" {
		t.Fatalf("operation = %+v", v.Operation)
	}
	// A second one is refused while the first runs.
	if _, err := m.RequestBackup("a"); !IsConflict(err) {
		t.Fatalf("second backup: %v", err)
	}

	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if res.OK || !res.Cancelled || !strings.Contains(res.Error, "the server is stopping") {
		t.Fatalf("result = %+v", res)
	}
	// Saving is turned back on before the server is told to stop. Both the
	// stop and the cancelled backup may say so, in either order.
	got := commands(cmdLog)
	stop := -1
	for i, c := range got {
		if c == "stop" {
			stop = i
			break
		}
	}
	if len(got) < 4 || got[0] != "save-off" || got[1] != "save-all-flush" || stop < 3 {
		t.Fatalf("commands = %q", got)
	}
	for _, c := range got[2:stop] {
		if c != "save-on" {
			t.Fatalf("commands = %q", got)
		}
	}
	if left := archives(m, "a"); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
	if !strings.Contains(logs(m, "a"), "Backup cancelled (the server is stopping)") {
		t.Fatalf("console:\n%s", logs(m, "a"))
	}
}

func TestRestartCancelsABackupAndStillRestarts(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "noflush", true)
	before := pidOf(m, "a")
	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Restart("a"); err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.Cancelled {
		t.Fatalf("result = %+v", res)
	}
	if after := pidOf(m, "a"); after == 0 || after == before {
		t.Fatalf("pid %d -> %d: not restarted", before, after)
	}
}

func TestDeleteCancelsABackupAndRemovesTheBackups(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "noflush", false)

	// One finished backup of the stopped server...
	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.OK {
		t.Fatalf("result = %+v", res)
	}
	if len(archives(m, "a")) != 1 {
		t.Fatalf("archives = %v", archives(m, "a"))
	}
	// ...and one in flight of the running one.
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the server to come up", func() bool { return strings.Contains(logs(m, "a"), "Done (") })
	if _, err := m.RequestBackup("a"); err != nil {
		t.Fatal(err)
	}

	pending, err := m.RequestDelete("a")
	if err != nil || !pending {
		t.Fatalf("delete: pending=%v err=%v", pending, err)
	}
	m.WaitDeletes()
	if _, err := m.Get("a"); err == nil {
		t.Fatal("the server is still there")
	}
	for _, p := range []string{dir, m.backupDir("a")} {
		if fileExists(p) {
			t.Fatalf("%s is still there", p)
		}
	}
}

func coldBackup(t *testing.T, m *Manager, id string) string {
	t.Helper()
	opID, err := m.RequestBackup(id)
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, id, opID)
	if !res.OK {
		t.Fatalf("backup: %+v", res)
	}
	return res.BackupID
}

func TestRestoreReplacesTheFilesAndCanBeUndone(t *testing.T) {
	m := newRealManager(t)
	dir, cmdLog := minecraftServer(t, m, "a", "ok", false)
	first := coldBackup(t, m, "a")
	if len(commands(cmdLog)) != 0 {
		t.Fatal("a stopped server was sent commands")
	}
	if list, _ := m.ListBackups("a"); len(list) != 1 || list[0].WhileRunning == nil || *list[0].WhileRunning {
		t.Fatalf("list = %+v", list)
	}

	// The world moves on.
	put(t, filepath.Join(dir, "world", "level.dat"), "LEVEL-2")
	put(t, filepath.Join(dir, "world", "new.dat"), "NEW")
	put(t, filepath.Join(dir, "logs", "latest.log"), "later\n")
	if err := os.Remove(filepath.Join(dir, "server.properties")); err != nil {
		t.Fatal(err)
	}

	opID, err := m.RequestRestore("a", first, true)
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if !res.OK || res.Kind != "restore" || res.BackupID != first || res.Warning != "" {
		t.Fatalf("result = %+v\n%s", res, logs(m, "a"))
	}
	if got := read(t, filepath.Join(dir, "world", "level.dat")); got != "LEVEL-1" {
		t.Fatalf("level.dat = %q", got)
	}
	if got := read(t, filepath.Join(dir, "server.properties")); got != "motd=original\n" {
		t.Fatalf("server.properties = %q", got)
	}
	if fileExists(filepath.Join(dir, "world", "new.dat")) {
		t.Fatal("a file that is not in the backup survived")
	}
	// What backups do not cover is left alone.
	if got := read(t, filepath.Join(dir, "logs", "latest.log")); got != "later\n" {
		t.Fatalf("the log was touched: %q", got)
	}
	s, _ := m.store.Get("a")
	if fileExists(stageDir(s)) || fileExists(asideDir(s)) {
		t.Fatal("restore leftovers next to the server")
	}

	// The state before the restore is a backup of its own.
	list, _ := m.ListBackups("a")
	if len(list) != 2 || list[0].Kind != "pre-restore" {
		t.Fatalf("list = %+v", list)
	}
	opID, err = m.RequestRestore("a", list[0].ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.OK {
		t.Fatalf("undo: %+v", res)
	}
	if got := read(t, filepath.Join(dir, "world", "level.dat")); got != "LEVEL-2" {
		t.Fatalf("after undo, level.dat = %q", got)
	}
	if fileExists(filepath.Join(dir, "server.properties")) || !fileExists(filepath.Join(dir, "world", "new.dat")) {
		t.Fatal("the undo did not bring back the state before the restore")
	}
	if list, _ := m.ListBackups("a"); len(list) != 2 {
		t.Fatalf("a restore without backupFirst made a backup: %+v", list)
	}

	// The restored server starts.
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreIsRefusedWhileTheServerRuns(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "ok", false)
	id := coldBackup(t, m, "a")
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RequestRestore("a", id, true); !IsConflict(err) || !strings.Contains(err.Error(), "Stop the server") {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreRefusesWhatIsNotAWholeBackup(t *testing.T) {
	m := newRealManager(t)
	dir, _ := minecraftServer(t, m, "a", "ok", false)
	good := coldBackup(t, m, "a")
	goodZip := filepath.Join(m.backupDir("a"), good+".zip")

	craft := func(id, comment string, entries map[string]string) {
		out, err := os.Create(filepath.Join(m.backupDir("a"), id+".zip"))
		if err != nil {
			t.Fatal(err)
		}
		zw := zip.NewWriter(out)
		_ = zw.SetComment(comment)
		for name, content := range entries {
			w, _ := zw.Create(name)
			_, _ = w.Write([]byte(content))
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		out.Close()
	}
	craft("20200101-000000-manual", "", map[string]string{"world/level.dat": "X"})
	craft("20200102-000000-manual", `{"fileCount":0,"totalBytes":0}`, nil)
	craft("20200103-000000-manual", `{"fileCount":2,"totalBytes":1}`, map[string]string{"world/level.dat": "X"})
	craft("20200104-000000-manual", `{"fileCount":1,"totalBytes":1}`, map[string]string{"../evil.dat": "X"})
	craft("20200105-000000-manual", `{"fileCount":1,"totalBytes":1}`, map[string]string{"world/level.dat": "XXXXXXXX"})

	for id, want := range map[string]string{
		"20200101-000000-manual": "not a backup made by this software",
		"20200102-000000-manual": "does not say what it contains",
		"20200103-000000-manual": "holds 1 file(s) instead of 2",
		"20200104-000000-manual": "not allowed",
		"20200105-000000-manual": "more data than it says",
	} {
		opID, err := m.RequestRestore("a", id, false)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		res := result(t, m, "a", opID)
		if res.OK || !strings.Contains(res.Error, want) {
			t.Fatalf("%s: result = %+v, want %q", id, res, want)
		}
	}
	if got := read(t, filepath.Join(dir, "world", "level.dat")); got != "LEVEL-1" {
		t.Fatalf("a refused restore changed the server: %q", got)
	}
	if fileExists(filepath.Join(filepath.Dir(dir), "evil.dat")) {
		t.Fatal("a file was written outside the server")
	}
	s, _ := m.store.Get("a")
	if fileExists(stageDir(s)) {
		t.Fatal("the stage folder was left behind")
	}

	if _, err := m.RequestRestore("a", "20990101-000000-manual", false); err != ErrBackupNotFound {
		t.Fatalf("missing backup: %v", err)
	}
	for _, bad := range []string{"", "..", "../" + good, good + ".zip", `..\x`} {
		if _, err := m.RequestRestore("a", bad, false); err == nil || err == ErrBackupNotFound {
			t.Fatalf("id %q: %v", bad, err)
		}
		if err := m.DeleteBackup("a", bad); err == nil || err == ErrBackupNotFound {
			t.Fatalf("delete id %q: %v", bad, err)
		}
	}
	if !fileExists(goodZip) {
		t.Fatal("the good backup is gone")
	}
	if err := m.DeleteBackup("a", good); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteBackup("a", good); err != ErrBackupNotFound {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := m.ListBackups("nope"); err != store.ErrNotFound {
		t.Fatalf("unknown server: %v", err)
	}
}

func TestStartIsRefusedWhileAnOperationRunsAndAfterALeftover(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "ok", false)

	op, s, _, err := m.beginOperation("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	go m.runOperation(op, s, func() (string, string, error) {
		<-release
		return "", "", nil
	})
	if err := m.Start("a"); !IsConflict(err) || !strings.Contains(err.Error(), "restore") {
		t.Fatalf("start during a restore: %v", err)
	}
	if err := m.DeleteBackup("a", "20200101-000000-manual"); !IsConflict(err) {
		t.Fatalf("delete during a restore: %v", err)
	}
	close(release)
	<-op.done

	// A restore that could not remove the previous files: starting now would
	// run the server next to a folder the next restore needs gone.
	if err := os.Mkdir(asideDir(s), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := m.Start("a"); !IsConflict(err) || !strings.Contains(err.Error(), "Delete that folder") {
		t.Fatalf("start with a leftover: %v", err)
	}
	if _, err := m.RequestRestore("a", coldBackup(t, m, "a"), false); err != nil {
		t.Fatal(err)
	}
	v, _ := m.Get("a")
	waitFor(t, "the restore to end", func() bool { v, _ = m.Get("a"); return v.Operation == nil })
	if v.LastOperation.OK || !strings.Contains(v.LastOperation.Error, "Delete that folder first") {
		t.Fatalf("restore over a leftover: %+v", v.LastOperation)
	}
	if err := os.Remove(asideDir(s)); err != nil {
		t.Fatal(err)
	}
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownCancelsABackupButWaitsForACommittedRestore(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "ok", false)
	realServer(t, m, "b", "")

	// "a": an operation that only ends when it is cancelled.
	opA, sA, _, err := m.beginOperation("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	go m.runOperation(opA, sA, func() (string, string, error) {
		<-opA.ctx.Done()
		return "", "", backup.Cancelled(opA.ctx)
	})
	// "b": a restore that is already replacing files.
	opB, sB, _, err := m.beginOperation("b", "restore")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	opB.committed = true
	m.mu.Unlock()
	release := make(chan struct{})
	go m.runOperation(opB, sB, func() (string, string, error) {
		<-release
		return "", "", nil
	})

	stopped := make(chan struct{})
	go func() {
		m.StopAll()
		close(stopped)
	}()
	<-opA.done
	if v, _ := m.Get("a"); v.LastOperation == nil || !v.LastOperation.Cancelled || !strings.Contains(v.LastOperation.Error, "shutting down") {
		t.Fatalf("a: %+v", v.LastOperation)
	}
	select {
	case <-stopped:
		t.Fatal("the shutdown did not wait for the restore")
	case <-time.After(300 * time.Millisecond):
	}
	if opB.ctx.Err() != nil {
		t.Fatal("a committed restore was cancelled")
	}
	close(release)
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("the shutdown never finished")
	}
	if _, err := m.RequestBackup("a"); !IsConflict(err) {
		t.Fatalf("backup after shutdown: %v", err)
	}
}

func TestACrashDropsTheBackupAndTheAutoRestartStillHappens(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "noflush", false)
	s, _ := m.store.Get("a")
	s.AutoStart = true
	if err := m.store.Put(s); err != nil {
		t.Fatal(err)
	}
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the server to come up", func() bool { return strings.Contains(logs(m, "a"), "Done (") })
	before := pidOf(m, "a")
	opID, err := m.RequestBackup("a")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	rs := m.running["a"]
	m.mu.Unlock()
	killTree(rs.cmd)

	res := result(t, m, "a", opID)
	if res.OK || !res.Cancelled {
		t.Fatalf("result = %+v", res)
	}
	// While the restart is pending a backup is refused rather than raced.
	if _, err := m.RequestBackup("a"); err != nil && !IsConflict(err) {
		t.Fatalf("backup while a restart is pending: %v", err)
	}
	waitFor(t, "the auto-restart", func() bool { p := pidOf(m, "a"); return p != 0 && p != before })
}
