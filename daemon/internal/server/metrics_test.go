package server

import (
	"bufio"
	"errors"
	"io"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/tick"
)

// fakeTickEnv set to "mute" makes the fake Minecraft server not know the
// "tick query" command.
const fakeTickEnv = "MSMD_TEST_TICK"

// statusListener stands in for the game port of a server: it answers every
// server list ping with 3 of 20 players.
func statusListener(t *testing.T) (port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				r := bufio.NewReader(conn)
				// The handshake packet (shorter than 128 bytes: one length
				// byte), then the two bytes of the status request.
				n, err := r.ReadByte()
				if err != nil {
					return
				}
				if _, err := io.CopyN(io.Discard, r, int64(n)+2); err != nil {
					return
				}
				json := `{"players":{"max":20,"online":3}}`
				_, _ = conn.Write(append([]byte{byte(len(json) + 2), 0x00, byte(len(json))}, json...))
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// questions is how many times the fake server was sent "tick query".
func questions(cmdLog string) int {
	b, _ := os.ReadFile(cmdLog)
	n := 0
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "tick query" {
			n++
		}
	}
	return n
}

func TestMetricsOfARunningServer(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "ok", false)
	port := statusListener(t)
	if _, err := m.mutate("a", func(s *store.Server) { s.Port = port }); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Metrics("a"); !IsConflict(err) {
		t.Fatalf("metrics of a stopped server: %v", err)
	}
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}

	var got Metrics
	waitFor(t, "the tick time and the players", func() bool {
		var err error
		if got, err = m.Metrics("a"); err != nil {
			t.Fatal(err)
		}
		return got.Tick != nil && got.Tick.P95Ms != nil && got.Players != nil
	})
	if got.ServerID != "a" || got.At == 0 || got.TickStatus != "" {
		t.Errorf("metrics = %+v", got)
	}
	tk := got.Tick
	if tk.AverageMs != 12.5 || tk.TargetMs != 50 || tk.TargetRate != 20 || tk.TPS == nil || *tk.TPS != 20 ||
		tk.Mode != tick.ModeNormal || *tk.P95Ms != 20.5 || tk.At == 0 || tk.At > got.At {
		t.Errorf("tick = %+v", *tk)
	}
	if got.Players.Online != 3 || got.Players.Max != 20 {
		t.Errorf("players = %+v", *got.Players)
	}

	// The answer to the daemon's own question is not console output.
	if out := logs(m, "a"); strings.Contains(out, "tick") || strings.Contains(out, "Percentiles") || strings.Contains(out, "The game is") {
		t.Errorf("the daemon's question shows in the console:\n%s", out)
	}
	// However often the metrics are asked for, the server is asked once per
	// interval.
	for i := 0; i < 20; i++ {
		if _, err := m.Metrics("a"); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if n := questions(cmdLog); n != 1 {
		t.Errorf("the server was asked %d times: %v", n, commands(cmdLog))
	}

	// What the server answers to somebody else's question is theirs to see.
	if err := m.SendCommand("a", "tick query"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the answer to a typed tick query", func() bool { return strings.Contains(logs(m, "a"), "Percentiles") })
	if out := logs(m, "a"); strings.Count(out, "Average time per tick") != 1 || strings.Count(out, "The game is running normally") != 1 {
		t.Errorf("the typed question's answer is not shown whole, once:\n%s", out)
	}

	// Processor and memory, where the host can be asked. The processor use
	// takes two readings.
	if runtime.GOOS == "linux" || runtime.GOOS == "windows" {
		waitFor(t, "processor and memory use", func() bool {
			got, err := m.Metrics("a")
			if err != nil {
				t.Fatal(err)
			}
			return got.CPU != nil && got.Memory != nil && *got.Memory > 0 && *got.CPU >= 0
		})
	} else if got.CPU != nil || got.Memory != nil {
		t.Errorf("processor or memory use on %s: %+v", runtime.GOOS, got)
	}
}

func TestMetricsStartAfreshWithEveryRun(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "ok", true)
	asked := func(n int) func() bool {
		return func() bool {
			if _, err := m.Metrics("a"); err != nil && !IsConflict(err) {
				t.Fatal(err)
			}
			return questions(cmdLog) == n
		}
	}
	waitFor(t, "the first question", asked(1))
	if err := m.Restart("a"); err != nil {
		t.Fatal(err)
	}
	// The new process is asked at once (once it is up), not an interval
	// after the question to the old one; and nothing of the old one is left.
	got, err := m.Metrics("a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Tick != nil || got.CPU != nil {
		t.Errorf("metrics of the previous run survived the restart: %+v", got)
	}
	waitFor(t, "the question to the new process", asked(2))
}

func TestMetricsOfAVersionWithoutTickQuery(t *testing.T) {
	m := newRealManager(t)
	_, cmdLog := minecraftServer(t, m, "a", "ok", false)
	if _, err := m.mutate("a", func(s *store.Server) { s.MinecraftVersion = "1.20.1" }); err != nil {
		t.Fatal(err)
	}
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the server to come up", func() bool { return strings.Contains(logs(m, "a"), "Done (") })
	for i := 0; i < 3; i++ {
		got, err := m.Metrics("a")
		if err != nil {
			t.Fatal(err)
		}
		if got.TickStatus != tick.StatusUnsupported || got.Tick != nil {
			t.Fatalf("metrics = %+v", got)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if n := questions(cmdLog); n != 0 {
		t.Errorf("a server without the command was asked %d times", n)
	}
}

func TestMetricsOfAServerThatDoesNotKnowTheCommand(t *testing.T) {
	m := newRealManager(t)
	t.Setenv(fakeTickEnv, "mute")
	minecraftServer(t, m, "a", "ok", true)
	waitFor(t, "the server's refusal", func() bool {
		if _, err := m.Metrics("a"); err != nil {
			t.Fatal(err)
		}
		return strings.Contains(logs(m, "a"), "Unknown or incomplete command")
	})
	got, err := m.Metrics("a")
	if err != nil {
		t.Fatal(err)
	}
	// Not given up on yet (that takes three questions, an interval apart;
	// see the tick package), and no value made up.
	if got.Tick != nil || got.TickStatus != "" {
		t.Errorf("metrics = %+v", got)
	}
}

func TestMetricsOfAnUnknownServer(t *testing.T) {
	m := newRealManager(t)
	if _, err := m.Metrics("nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("err = %v", err)
	}
}

// A backup waits for the server to confirm that it saved, in lines the
// metrics look at first. Both at once: the backup must still see its lines,
// and nothing may race (CI runs this with -race).
func TestMetricsWhileABackupRuns(t *testing.T) {
	m := newRealManager(t)
	minecraftServer(t, m, "a", "ok", true)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	var highest atomic.Int64 // the highest processor use any request was told
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					if got, err := m.Metrics("a"); err == nil && got.CPU != nil && int64(*got.CPU) > highest.Load() {
						highest.Store(int64(*got.CPU))
					}
					_, _ = m.Get("a")
				}
			}
		}()
	}
	for i := 0; i < 3; i++ {
		opID, err := m.RequestBackup("a")
		if err != nil {
			t.Fatal(err)
		}
		if res := result(t, m, "a", opID); !res.OK {
			t.Fatalf("backup %d failed with the metrics being read: %+v\n%s", i, res, logs(m, "a"))
		}
		_ = m.SendCommand("a", "tick query")
	}
	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	close(stop)
	wg.Wait()
	// Readings taken by requests that overlap must not be set against each
	// other: a stretch of microseconds makes any use look like thousands of
	// percent. The server here does next to nothing.
	if limit := int64(100 * runtime.NumCPU()); highest.Load() > limit {
		t.Errorf("a request was told the server uses %d%% of a core (this machine has %d)", highest.Load(), runtime.NumCPU())
	}
	if _, err := m.Metrics("a"); !IsConflict(err) {
		t.Errorf("metrics after the stop: %v", err)
	}
}
