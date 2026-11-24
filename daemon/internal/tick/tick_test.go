package tick

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

type result struct {
	samples []Sample // the complete ones (with percentiles)
	parts   []string
	all     []Line
}

func read(lines []string) result {
	var r Reader
	var out result
	for _, line := range lines {
		got := r.Feed(line)
		out.all = append(out.all, got)
		if got.Part {
			out.parts = append(out.parts, line)
		}
		if got.Sample != nil && got.Sample.SampleSize != nil {
			out.samples = append(out.samples, *got.Sample)
		}
	}
	return out
}

func f(v float64) *float64 { return &v }
func n(v int) *int         { return &v }

// The fixtures are the ones of the desktop app, byte for byte: both readers
// must agree on what a real server said.
func TestFixturesAreTheOnesOfTheApp(t *testing.T) {
	for _, name := range []string{"tick-query-paper-1.21.11.txt", "tick-query-paper-1.21.11-modes.txt"} {
		mine, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		theirs, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "shared", "utils", "__fixtures__", name))
		if err != nil {
			t.Skipf("the app's fixtures are not here: %v", err)
		}
		if !bytes.Equal(mine, theirs) {
			t.Errorf("%s differs from the app's copy", name)
		}
	}
}

func TestSupported(t *testing.T) {
	for _, v := range []string{"1.20.3", "1.20.4", "1.20.6", "1.21", "1.21.11", "26.1", "26.3.1", "1.21.5-rc1", "1.20.3-pre2"} {
		if !Supported(v) {
			t.Errorf("Supported(%q) = false", v)
		}
	}
	for _, v := range []string{"1.20.2", "1.20", "1.19.4", "1.8.9", "1.7.10", "24w10a", "", "latest", "0.9"} {
		if Supported(v) {
			t.Errorf("Supported(%q) = true", v)
		}
	}
}

func TestReadsWhatARealServerAnswered(t *testing.T) {
	got := read(fixture(t, "tick-query-paper-1.21.11.txt"))
	want := []Sample{
		{AverageMs: 0.4, TargetMs: 50, TargetRate: 20, TPS: f(20), Mode: ModeNormal, P50Ms: f(0.3), P95Ms: f(0.5), P99Ms: f(0.7), SampleSize: n(100)},
		{AverageMs: 0.1, TargetMs: 50, TargetRate: 20, TPS: f(20), Mode: ModeNormal, P50Ms: f(0.1), P95Ms: f(0.2), P99Ms: f(0.4), SampleSize: n(100)},
	}
	if !reflect.DeepEqual(got.samples, want) {
		t.Errorf("samples = %+v", got.samples)
	}
	if len(got.parts) != 8 {
		t.Errorf("%d lines taken for part of an answer, want 8: %q", len(got.parts), got.parts)
	}
	for _, line := range got.parts {
		// What a /say printed is not one of them, nor are other commands' answers.
		if strings.Contains(line, "[Server]") || strings.Contains(line, "TPS from last") {
			t.Errorf("took %q for part of an answer", line)
		}
	}
}

func TestReadsASprintingAFrozenAndAFasterGame(t *testing.T) {
	got := read(fixture(t, "tick-query-paper-1.21.11-modes.txt"))
	var modes []string
	for _, s := range got.samples {
		modes = append(modes, s.Mode)
	}
	if want := []string{ModeNormal, ModeSprinting, ModeFrozen, ModeFrozen, ModeNormal}; !reflect.DeepEqual(modes, want) {
		t.Fatalf("modes = %v, want %v", modes, want)
	}
	// Sprinting: no target is printed and none holds; no ticks per second.
	sprint := Sample{AverageMs: 0, TargetMs: 50, TargetRate: 20, Mode: ModeSprinting, P50Ms: f(0), P95Ms: f(0), P99Ms: f(0), SampleSize: n(100)}
	if !reflect.DeepEqual(got.samples[1], sprint) {
		t.Errorf("sprinting sample = %+v", got.samples[1])
	}
	// `tick rate 40`: the target is read from the answer, not assumed.
	fast := got.samples[4]
	if fast.TargetRate != 40 || fast.TargetMs != 25 || fast.TPS == nil || *fast.TPS != 40 {
		t.Errorf("sample at 40 per second = %+v", fast)
	}
	for _, line := range got.parts {
		if strings.Contains(line, "Sprint completed") || strings.Contains(line, "Stepping") || strings.Contains(line, "Set the target") {
			t.Errorf("took %q for part of an answer", line)
		}
	}
}

const (
	rateLine    = "[12:00:00] [Server thread/INFO]: Target tick rate: 20.0 per second."
	averageLine = "Average time per tick: 62.5ms (Target: 50.0ms)"
	pctLine     = "[12:00:00] [Server thread/INFO]: Percentiles: P50: 60.0ms P95: 80.5ms P99: 120.0ms, sample: 100"
	chatLine    = "[12:00:01] [Server thread/INFO]: <Steve> hello"
)

func TestReaderVanillaFormatAndASlowServer(t *testing.T) {
	got := read([]string{rateLine, averageLine, pctLine})
	want := Sample{AverageMs: 62.5, TargetMs: 50, TargetRate: 20, TPS: f(16), Mode: ModeNormal, P50Ms: f(60), P95Ms: f(80.5), P99Ms: f(120), SampleSize: n(100)}
	if len(got.samples) != 1 || !reflect.DeepEqual(got.samples[0], want) {
		t.Errorf("samples = %+v", got.samples)
	}
	// The average is reported at once, before the percentiles.
	if s := got.all[1].Sample; s == nil || s.AverageMs != 62.5 || s.SampleSize != nil || got.all[1].End {
		t.Errorf("average line = %+v", got.all[1])
	}
}

func TestReaderOfAServerThatCannotKeepUp(t *testing.T) {
	// Wording from the game's language file; not captured from a server.
	got := read([]string{
		"[12:00:00] [Server thread/INFO]: The game is running, but can't keep up with the target tick rate",
		rateLine, averageLine, pctLine,
	})
	if len(got.parts) != 4 || len(got.samples) != 1 || got.samples[0].Mode != ModeNormal || *got.samples[0].TPS != 16 {
		t.Errorf("parts %q, samples %+v", got.parts, got.samples)
	}
}

func TestReaderTakesNoNumberOfAnAbsurdLength(t *testing.T) {
	var r Reader
	r.Feed(rateLine)
	if got := r.Feed("Average time per tick: " + strings.Repeat("9", 400) + "ms (Target: 50.0ms)"); got.Sample != nil {
		t.Errorf("sample = %+v", got.Sample)
	}
}

func TestReaderEndsAnAnswerWithoutPercentiles(t *testing.T) {
	got := read([]string{rateLine, averageLine, chatLine})
	if last := got.all[2]; last.Part || !last.End {
		t.Errorf("line after the answer = %+v", last)
	}
}

func TestReaderNeverReportsMoreThanTheTarget(t *testing.T) {
	var r Reader
	r.Feed(rateLine)
	if s := r.Feed("Average time per tick: 0.0ms (Target: 50.0ms)").Sample; s == nil || *s.TPS != 20 {
		t.Errorf("sample = %+v", s)
	}
}

func TestReaderDecimalCommaAndColours(t *testing.T) {
	var r Reader
	r.Feed("[12:00:00 INFO]: \x1b[38;5;3mTarget tick rate: 20,0 per second.\x1b[0m")
	s := r.Feed("Average time per tick: 100,0ms (Target: 50,0ms)\r").Sample
	if s == nil || s.AverageMs != 100 || s.TargetMs != 50 || *s.TPS != 10 {
		t.Errorf("sample = %+v", s)
	}
}

func TestReaderIsNotFooledByPlayersOrPlugins(t *testing.T) {
	fakes := []string{
		averageLine, // no server said the target rate first
		"[12:00:00] [Server thread/INFO]: " + averageLine,
		"[12:00:00] [Server thread/INFO]: <Steve> Target tick rate: 20.0 per second.",
		averageLine,
		"[12:00:00] [Server thread/INFO]: [Not Secure] [Server] Target tick rate: 20.0 per second.",
		averageLine,
		rateLine, // something else came in between
		"[12:00:00] [Server thread/INFO]: Steve joined the game",
		averageLine,
		pctLine, // percentiles alone
		"[12:00:00] [Server thread/INFO]: The game is over, thanks for playing",
	}
	var r Reader
	var parts []string
	for _, line := range fakes {
		got := r.Feed(line)
		if got.Sample != nil {
			t.Errorf("%q gave a sample", line)
		}
		if got.Part {
			parts = append(parts, line)
		}
	}
	if !reflect.DeepEqual(parts, []string{rateLine}) {
		t.Errorf("parts = %q", parts)
	}
}

func TestIsReadyLine(t *testing.T) {
	yes := []string{
		`[19:25:27 INFO]: Done (11.138s)! For help, type "help"`,
		`[12:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: Done (4.2s)! For help, type "help"`,
	}
	no := []string{
		"[12:00:00] [Server thread/INFO]: <Steve> Done (1s)!",
		"[12:00:00] [Server thread/INFO]: Done preparing level",
		"Done (1s)!",
	}
	for _, line := range yes {
		if !IsReadyLine(line) {
			t.Errorf("IsReadyLine(%q) = false", line)
		}
	}
	for _, line := range no {
		if IsReadyLine(line) {
			t.Errorf("IsReadyLine(%q) = true", line)
		}
	}
}

var answer = []string{
	"[19:25:33 INFO]: The game is running normally",
	"[19:25:33 INFO]: Target tick rate: 20.0 per second.",
	"Average time per tick: 0.4ms (Target: 50.0ms)",
	"[19:25:33 INFO]: Percentiles: P50: 0.3ms P95: 0.5ms P99: 0.7ms. Sample: 100",
}

func owns(f *AnswerFilter, at time.Time, lines ...string) []bool {
	var out []bool
	for _, line := range lines {
		own, _ := f.Feed(line, at)
		out = append(out, own)
	}
	return out
}

func TestAnswerFilter(t *testing.T) {
	t0 := time.Unix(1000, 0)
	yes, no := []bool{true, true, true, true}, []bool{false, false, false, false}

	t.Run("takes the answer to its own question and nothing after it", func(t *testing.T) {
		var f AnswerFilter
		f.Asked(t0)
		at := t0.Add(100 * time.Millisecond)
		if got := owns(&f, at, chatLine); got[0] {
			t.Error("took a chat line")
		}
		if got := owns(&f, at, answer...); !reflect.DeepEqual(got, yes) {
			t.Errorf("own answer = %v", got)
		}
		if got := owns(&f, at, answer...); !reflect.DeepEqual(got, no) {
			t.Errorf("second answer = %v", got)
		}
	})

	t.Run("leaves alone an answer nobody here asked for, and still reads it", func(t *testing.T) {
		var f AnswerFilter
		var last *Sample
		for _, line := range answer {
			own, s := f.Feed(line, t0)
			if own {
				t.Errorf("took %q", line)
			}
			if s != nil {
				last = s
			}
		}
		if last == nil || last.P95Ms == nil || *last.P95Ms != 0.5 {
			t.Errorf("sample = %+v", last)
		}
		// Asked, but the server answered too late to be sure it is ours.
		f.Asked(t0)
		if got := owns(&f, t0.Add(AnswerWindow), answer...); !reflect.DeepEqual(got, no) {
			t.Errorf("late answer = %v", got)
		}
	})

	t.Run("does not take a line that only resembles the start of an answer", func(t *testing.T) {
		var f AnswerFilter
		f.Asked(t0)
		if got := owns(&f, t0, "[19:25:33 INFO]: The game is over, thanks for playing"); got[0] {
			t.Error("took the lookalike")
		}
		if got := owns(&f, t0, answer...); !reflect.DeepEqual(got, yes) {
			t.Errorf("own answer = %v", got)
		}
	})

	t.Run("takes one answer per question", func(t *testing.T) {
		var f AnswerFilter
		f.Asked(t0)
		owns(&f, t0, answer...)
		later := t0.Add(20 * time.Second)
		f.Asked(later)
		if got := owns(&f, later, answer...); !reflect.DeepEqual(got, yes) {
			t.Errorf("answer to the second question = %v", got)
		}
	})
}

func TestPolicy(t *testing.T) {
	t0 := time.Unix(1000, 0)

	t.Run("waits for the server, leaves a stopping one alone, then asks once per interval", func(t *testing.T) {
		p := NewPolicy("1.21.4")
		if p.ShouldAsk(t0, true) {
			t.Error("asked before the server was ready")
		}
		p.ServerReady()
		if p.ShouldAsk(t0, false) {
			t.Error("asked a stopping server")
		}
		asked := 0
		for now := t0; now.Before(t0.Add(4 * QueryInterval)); now = now.Add(5 * time.Second) {
			if p.ShouldAsk(now, true) {
				p.Asked(now)
				p.Answered()
				asked++
			}
		}
		if asked != 4 {
			t.Errorf("asked %d times in four intervals", asked)
		}
	})

	t.Run("never asks a version without the command", func(t *testing.T) {
		p := NewPolicy("1.20.1")
		p.ServerReady()
		if p.ShouldAsk(t0, true) || p.Status() != StatusUnsupported {
			t.Errorf("asked, or status = %q", p.Status())
		}
	})

	t.Run("gives up after a few questions without an answer, until one comes", func(t *testing.T) {
		p := NewPolicy("1.21.4")
		p.ServerReady()
		asked := 0
		now := t0
		for ; now.Before(t0.Add(20 * QueryInterval)); now = now.Add(5 * time.Second) {
			if p.ShouldAsk(now, true) {
				p.Asked(now)
				asked++
			}
		}
		if asked != MaxMisses || p.Status() != StatusUnavailable {
			t.Errorf("asked %d times, status %q", asked, p.Status())
		}
		p.Answered() // to a question somebody typed
		if p.Status() != "" || !p.ShouldAsk(now, true) {
			t.Error("did not start asking again after an answer")
		}
	})
}
