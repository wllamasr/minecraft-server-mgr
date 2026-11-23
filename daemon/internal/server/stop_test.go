package server

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/console"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

// The test binary doubles as a stand-in for a Minecraft server: when
// fakeServerEnv is set it behaves like one instead of running the tests. Every
// stand-in gives up after fakeLifetime, so a failed test cannot leak it.
const fakeServerEnv = "MSMD_TEST_FAKE_SERVER"

func TestMain(m *testing.M) {
	if mode := os.Getenv(fakeServerEnv); mode != "" {
		runFakeServer(mode)
		return
	}
	os.Exit(m.Run())
}

const fakeLifetime = time.Minute

func runFakeServer(mode string) {
	switch mode {
	case "obey": // exits cleanly when told to stop, like a healthy server
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "stop" {
				fmt.Println("Stopping the server")
				os.Exit(0)
			}
		}
		os.Exit(0)
	case "ignore": // a hung server: never reacts to anything
		time.Sleep(fakeLifetime)
	case "crash":
		os.Exit(1)
	case "heartbeat": // touches a file for as long as it lives
		for i := 0; i < int(fakeLifetime/(20*time.Millisecond)); i++ {
			_ = os.WriteFile(os.Getenv("MSMD_TEST_HEARTBEAT"), []byte(fmt.Sprint(i)), 0o600)
			time.Sleep(20 * time.Millisecond)
		}
	case "wrapper": // like run.sh: the real work happens in a child process
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), fakeServerEnv+"=heartbeat")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		time.Sleep(fakeLifetime)
	}
}

func fakeServer(mode string, extraEnv ...string) *exec.Cmd {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(append(os.Environ(), fakeServerEnv+"="+mode), extraEnv...)
	return cmd
}

func newTestManager(t *testing.T, grace time.Duration) *Manager {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "servers.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(config.Config{ServersRoot: dir, JavaPath: "java", StopGrace: grace}, st, console.New())
	t.Cleanup(func() {
		// Whatever a failed test left behind must not outlive it.
		m.mu.Lock()
		left := make([]*runningServer, 0, len(m.running))
		for _, rs := range m.running {
			left = append(left, rs)
		}
		m.mu.Unlock()
		for _, rs := range left {
			killTree(rs.cmd)
			<-rs.exited
		}
	})
	return m
}

// statuses collects the status events of one server.
func statuses(t *testing.T, m *Manager, id string) func() []string {
	t.Helper()
	events, cancel := m.hub.SubscribeEvents()
	t.Cleanup(cancel)
	var seen []string
	return func() []string {
		for {
			select {
			case e := <-events:
				if e.ServerID == id {
					seen = append(seen, e.Status)
				}
			case <-time.After(time.Second):
				return seen
			}
		}
	}
}

func logs(m *Manager, id string) string {
	var b strings.Builder
	for _, l := range m.hub.Buffer(id) {
		b.WriteString(l.Line + "\n")
	}
	return b.String()
}

func TestStopLetsAnObedientServerExit(t *testing.T) {
	m := newTestManager(t, 30*time.Second)
	seen := statuses(t, m, "a")
	if err := m.launch("a", store.Server{ID: "a", Name: "a"}, fakeServer("obey")); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	if err := m.Stop("a"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if took := time.Since(start); took > 10*time.Second {
		t.Errorf("Stop took %s for a server that obeys", took)
	}
	if n := m.RunningCount(); n != 0 {
		t.Errorf("RunningCount after Stop = %d", n)
	}
	if got := strings.Join(seen(), ","); got != "running,stopping,stopped" {
		t.Errorf("statuses = %s", got)
	}
	if out := logs(m, "a"); strings.Contains(out, "killing the process") {
		t.Errorf("an obedient server was killed:\n%s", out)
	}
}

func TestStopKillsAServerThatIgnoresIt(t *testing.T) {
	m := newTestManager(t, 200*time.Millisecond)
	seen := statuses(t, m, "a")
	if err := m.launch("a", store.Server{ID: "a", Name: "a", AutoStart: true}, fakeServer("ignore")); err != nil {
		t.Fatal(err)
	}
	if err := m.Stop("a"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	// Stop returned, so the process is gone and the server can start again.
	if n := m.RunningCount(); n != 0 {
		t.Errorf("RunningCount after Stop = %d", n)
	}
	// A kill we asked for is a stop, not a crash, and must not auto-restart.
	if got := strings.Join(seen(), ","); got != "running,stopping,stopped" {
		t.Errorf("statuses = %s", got)
	}
	if out := logs(m, "a"); !strings.Contains(out, "did not stop within") {
		t.Errorf("no warning about the forced stop:\n%s", out)
	}
	m.mu.Lock()
	pending := len(m.restartTimers)
	m.mu.Unlock()
	if pending != 0 {
		t.Errorf("a forced stop scheduled %d auto-restart(s)", pending)
	}
}

func TestStopKillsTheWholeProcessTree(t *testing.T) {
	m := newTestManager(t, 200*time.Millisecond)
	beat := filepath.Join(t.TempDir(), "beat")
	if err := m.launch("a", store.Server{ID: "a", Name: "a"}, fakeServer("wrapper", "MSMD_TEST_HEARTBEAT="+beat)); err != nil {
		t.Fatal(err)
	}
	read := func() string { b, _ := os.ReadFile(beat); return string(b) }
	deadline := time.Now().Add(10 * time.Second)
	for read() == "" {
		if time.Now().After(deadline) {
			t.Fatal("the wrapped process never started")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := m.Stop("a"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let a write that was in flight land
	before := read()
	time.Sleep(300 * time.Millisecond)
	if after := read(); after != before {
		t.Errorf("the wrapped process survived the stop (heartbeat %s -> %s)", before, after)
	}
}

func TestConcurrentStopsShareOneShutdown(t *testing.T) {
	m := newTestManager(t, 2*time.Second)
	if err := m.launch("a", store.Server{ID: "a", Name: "a"}, fakeServer("ignore")); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 2)
	go func() { errs <- m.Stop("a") }()
	// The second call must arrive while the first is still waiting.
	for m.statusOf("a") != StatusStopping {
		time.Sleep(5 * time.Millisecond)
	}
	go func() { errs <- m.Stop("a") }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Stop #%d: %v", i+1, err)
		}
	}
	if n := strings.Count(logs(m, "a"), "did not stop within"); n != 1 {
		t.Errorf("the server was force-killed %d times, want once", n)
	}
}

func TestRequestStopReturnsBeforeTheServerIsDown(t *testing.T) {
	m := newTestManager(t, 2*time.Second)
	if err := m.RequestStop("a"); err == nil {
		t.Error("RequestStop of a server that is not running succeeded")
	}
	if err := m.launch("a", store.Server{ID: "a", Name: "a"}, fakeServer("ignore")); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := m.RequestStop("a"); err != nil {
		t.Fatalf("RequestStop: %v", err)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("RequestStop blocked for %s", took)
	}
	if got := m.statusOf("a"); got != StatusStopping {
		t.Errorf("status right after RequestStop = %s, want stopping", got)
	}
	// A second request while it is stopping is accepted, not an error.
	if err := m.RequestStop("a"); err != nil {
		t.Errorf("second RequestStop: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for m.RunningCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the server never went down")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n := strings.Count(logs(m, "a"), "did not stop within"); n != 1 {
		t.Errorf("the server was force-killed %d times, want once", n)
	}
}

func TestStopAllStopsEverythingAndBlocksStarts(t *testing.T) {
	m := newTestManager(t, 300*time.Millisecond)
	for id, mode := range map[string]string{"a": "obey", "b": "obey", "c": "ignore"} {
		if err := m.launch(id, store.Server{ID: id, Name: id, AutoStart: true}, fakeServer(mode)); err != nil {
			t.Fatal(err)
		}
	}
	m.StopAll()
	if n := m.RunningCount(); n != 0 {
		t.Fatalf("RunningCount after StopAll = %d", n)
	}
	if err := m.Start("a"); err == nil || !strings.Contains(err.Error(), "shutting down") {
		t.Errorf("Start after StopAll = %v, want a shutting-down error", err)
	}
	if err := m.launch("d", store.Server{ID: "d", Name: "d"}, fakeServer("obey")); err == nil {
		t.Error("launch after StopAll succeeded")
	}
}

func TestStopAllCancelsAPendingAutoRestart(t *testing.T) {
	m := newTestManager(t, time.Second)
	if err := m.launch("a", store.Server{ID: "a", Name: "a", AutoStart: true}, fakeServer("crash")); err != nil {
		t.Fatal(err)
	}
	pending := func() int {
		m.mu.Lock()
		defer m.mu.Unlock()
		return len(m.restartTimers)
	}
	deadline := time.Now().Add(10 * time.Second)
	for pending() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the crash never scheduled an auto-restart:\n%s", logs(m, "a"))
		}
		time.Sleep(20 * time.Millisecond)
	}
	m.StopAll()
	if n := pending(); n != 0 {
		t.Errorf("%d auto-restart(s) still pending after StopAll", n)
	}
}

// realServer registers a server that the manager can start for real: the test
// binary stands in for java (see TestMain), so Start, Stop and Restart run
// their actual code paths.
func realServer(t *testing.T, m *Manager, id, schedule string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), id)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "server.jar"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := m.store.Put(store.Server{
		ID: id, Name: id, Dir: dir, MinecraftVersion: "1.21.4",
		MinRAM: "1G", MaxRAM: "1G", RestartSchedule: schedule,
	})
	if err != nil {
		t.Fatal(err)
	}
}

// selfPath is the test binary as an absolute path: servers start in their own
// directory, where a relative path would not resolve.
func selfPath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func newRealManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv(fakeServerEnv, "obey")
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "servers.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(config.Config{ServersRoot: dir, JavaPath: selfPath(t), StopGrace: 10 * time.Second}, st, console.New())
	t.Cleanup(m.StopAll)
	return m
}

func pidOf(m *Manager, id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rs := m.running[id]; rs != nil && rs.cmd.Process != nil {
		return rs.cmd.Process.Pid
	}
	return 0
}

// waitFor polls until cond holds.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRestartReplacesTheProcess(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "a", "")
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	before := pidOf(m, "a")
	if before == 0 {
		t.Fatal("server did not start")
	}
	if err := m.Restart("a"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	after := pidOf(m, "a")
	if after == 0 || after == before {
		t.Errorf("pid before = %d, after = %d: the process was not replaced", before, after)
	}
	if got := m.statusOf("a"); got != StatusRunning {
		t.Errorf("status after Restart = %s", got)
	}
	// It went down the graceful way, not by force.
	if out := logs(m, "a"); strings.Contains(out, "killing the process") {
		t.Errorf("the restart killed the server:\n%s", out)
	}
}

func TestDeleteWinsOverARestartInFlight(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "a", "")
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.deleting["a"] = true // a delete has begun
	m.mu.Unlock()
	if err := m.Restart("a"); err == nil || !strings.Contains(err.Error(), "being deleted") {
		t.Errorf("Restart during a delete = %v, want a being-deleted error", err)
	}
	if pidOf(m, "a") != 0 {
		t.Error("a server that is being deleted was started again")
	}
	v := "04:30"
	if _, err := m.Update("a", UpdateInput{RestartSchedule: &v}); err == nil {
		t.Error("Update of a server that is being deleted succeeded")
	}
	m.mu.Lock()
	delete(m.deleting, "a")
	m.mu.Unlock()
	if err := m.Delete("a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := m.Start("a"); err == nil {
		t.Error("a deleted server could be started")
	}
}

func TestRestartStartsAStoppedServer(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "a", "")
	if err := m.Restart("a"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if pidOf(m, "a") == 0 {
		t.Error("a stopped server was not started by Restart")
	}
}

func TestRequestRestart(t *testing.T) {
	m := newRealManager(t)
	if err := m.RequestRestart("missing"); err == nil {
		t.Error("RequestRestart of an unknown server succeeded")
	}
	realServer(t, m, "a", "")
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	before := pidOf(m, "a")
	// Two requests in a row are one restart.
	for i := 0; i < 2; i++ {
		if err := m.RequestRestart("a"); err != nil {
			t.Fatalf("RequestRestart: %v", err)
		}
	}
	waitFor(t, "the restarted process", func() bool {
		pid := pidOf(m, "a")
		return pid != 0 && pid != before && m.statusOf("a") == StatusRunning
	})
	waitFor(t, "the restart to finish", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return !m.restarting["a"]
	})
	if n := strings.Count(logs(m, "a"), "Restarting server..."); n != 1 {
		t.Errorf("the server was restarted %d times, want once", n)
	}
}

func TestUpdateRestartSchedule(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "a", "")
	set := func(v string) (View, error) { return m.Update("a", UpdateInput{RestartSchedule: &v}) }

	v, err := set("04:30")
	if err != nil || v.RestartSchedule != "04:30" {
		t.Fatalf("set: %v, %q", err, v.RestartSchedule)
	}
	if s, _ := m.store.Get("a"); s.RestartSchedule != "04:30" {
		t.Errorf("stored schedule = %q", s.RestartSchedule)
	}
	for _, bad := range []string{"4:30", "25:00", "soon", "04:30; stop"} {
		if _, err := set(bad); err == nil {
			t.Errorf("schedule %q was accepted", bad)
		}
	}
	// Nothing given: nothing changes.
	if v, err := m.Update("a", UpdateInput{}); err != nil || v.RestartSchedule != "04:30" {
		t.Errorf("empty update: %v, %q", err, v.RestartSchedule)
	}
	if v, err := set(""); err != nil || v.RestartSchedule != "" {
		t.Errorf("clear: %v, %q", err, v.RestartSchedule)
	}
	if _, err := m.Update("missing", UpdateInput{}); err == nil {
		t.Error("Update of an unknown server succeeded")
	}
}

func TestScheduleTickRestartsOnlyRunningServers(t *testing.T) {
	m := newRealManager(t)
	realServer(t, m, "up", "04:30")
	realServer(t, m, "down", "04:30")
	realServer(t, m, "none", "")
	for _, id := range []string{"up", "none"} {
		if err := m.Start(id); err != nil {
			t.Fatal(err)
		}
	}
	upBefore, noneBefore := pidOf(m, "up"), pidOf(m, "none")

	day := func(h, mi, s int) time.Time { return time.Date(2026, 6, 10, h, mi, s, 0, time.Local) }
	m.scheduleTick(day(4, 20, 0)) // first look
	m.scheduleTick(day(4, 25, 0)) // 5-minute warning
	if out := logs(m, "up"); !strings.Contains(out, "Scheduled restart in 5 minutes") {
		t.Errorf("no warning in the console:\n%s", out)
	}
	if out := logs(m, "down"); strings.Contains(out, "Scheduled restart") {
		t.Errorf("a stopped server was warned:\n%s", out)
	}
	m.scheduleTick(day(4, 30, 5)) // due

	waitFor(t, "the scheduled restart", func() bool {
		pid := pidOf(m, "up")
		return pid != 0 && pid != upBefore && m.statusOf("up") == StatusRunning
	})
	if pidOf(m, "down") != 0 {
		t.Error("a stopped server was started by its schedule")
	}
	if pidOf(m, "none") != noneBefore {
		t.Error("a server without a schedule was restarted")
	}
	// The same occurrence is not acted on twice.
	afterFirst := pidOf(m, "up")
	m.scheduleTick(day(4, 30, 20))
	time.Sleep(300 * time.Millisecond)
	if pidOf(m, "up") != afterFirst {
		t.Error("the same occurrence restarted the server twice")
	}
}
