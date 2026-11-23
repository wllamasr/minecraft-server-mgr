package schedule

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
	_ "time/tzdata" // the daylight-saving tests need a real zone on every runner
)

var newYork = mustLoad("America/New_York")

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// at is a local wall-clock time in the test zone.
func at(y int, mo time.Month, d, h, mi, s int) time.Time {
	return time.Date(y, mo, d, h, mi, s, 0, newYork)
}

// run ticks every 15 s from 'from' to 'to' and collects what the scheduler did.
func run(t *testing.T, schedule string, from, to time.Time, running func(time.Time) bool, st *State) ([]string, *State) {
	t.Helper()
	var events []string
	for now := from; !now.After(to); now = now.Add(15 * time.Second) {
		isRunning := running == nil || running(now)
		next, act, err := Tick(now, schedule, isRunning, st)
		if err != nil {
			t.Fatal(err)
		}
		st = next
		stamp := now.Format("15:04")
		if act.Warn != 0 {
			events = append(events, fmt.Sprintf("%s warn %d", stamp, int(act.Warn.Seconds())))
		}
		if act.Restart {
			events = append(events, stamp+" restart")
		}
	}
	return events, st
}

func expect(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("events = %v, want %v", got, want)
	}
}

func TestValid(t *testing.T) {
	for _, ok := range []string{"00:00", "04:30", "23:59"} {
		if !Valid(ok) {
			t.Errorf("Valid(%q) = false", ok)
		}
	}
	for _, bad := range []string{"24:00", "4:30", "04:60", "04:30:00", "", " 04:30", "04:30\n", "0४:30"} {
		if Valid(bad) {
			t.Errorf("Valid(%q) = true", bad)
		}
	}
}

func TestOccurrences(t *testing.T) {
	prev, next, err := Occurrences(at(2026, 6, 10, 12, 0, 0), "04:30")
	if err != nil {
		t.Fatal(err)
	}
	if !prev.Equal(at(2026, 6, 10, 4, 30, 0)) || !next.Equal(at(2026, 6, 11, 4, 30, 0)) {
		t.Errorf("got %s / %s", prev, next)
	}

	// An occurrence that is exactly now has passed.
	prev, next, _ = Occurrences(at(2026, 6, 10, 4, 30, 0), "04:30")
	if !prev.Equal(at(2026, 6, 10, 4, 30, 0)) || !next.Equal(at(2026, 6, 11, 4, 30, 0)) {
		t.Errorf("at the scheduled time: got %s / %s", prev, next)
	}

	// Clocks go back on 2026-11-01: the wall-clock time stays, the day is 25 h.
	prev, next, _ = Occurrences(at(2026, 10, 31, 12, 0, 0), "04:30")
	if next.Hour() != 4 || next.Sub(prev) != 25*time.Hour {
		t.Errorf("across the change: %s -> %s (%s)", prev, next, next.Sub(prev))
	}

	if _, _, err := Occurrences(time.Now(), "25:00"); err == nil {
		t.Error("a malformed schedule was accepted")
	}
}

func TestTickWarnsThenRestartsOnce(t *testing.T) {
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 5, 0, 0), nil, nil)
	expect(t, events, "04:25 warn 300", "04:29 warn 60", "04:30 restart")
}

func TestTickWarnsAcrossMidnight(t *testing.T) {
	events, _ := run(t, "00:02", at(2026, 6, 10, 23, 50, 0), at(2026, 6, 11, 0, 10, 0), nil, nil)
	expect(t, events, "23:57 warn 300", "00:01 warn 60", "00:02 restart")
}

func TestTickIgnoresAnOccurrenceBeforeItsFirstLook(t *testing.T) {
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 30, 15), at(2026, 6, 10, 6, 0, 0), nil, nil)
	expect(t, events)
}

func TestTickScheduleSetShortlyAhead(t *testing.T) {
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 28, 0), at(2026, 6, 10, 4, 40, 0), nil, nil)
	expect(t, events, "04:29 warn 60", "04:30 restart")

	events, _ = run(t, "04:30", at(2026, 6, 10, 4, 25, 10), at(2026, 6, 10, 4, 31, 0), nil, nil)
	expect(t, events, "04:25 warn 300", "04:29 warn 60", "04:30 restart")
}

func TestTickLeavesAStoppedServerAlone(t *testing.T) {
	stopAt := at(2026, 6, 10, 4, 27, 0)
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 5, 0, 0),
		func(now time.Time) bool { return now.Before(stopAt) }, nil)
	expect(t, events, "04:25 warn 300")
}

func TestTickDoesNotRestartAServerStartedJustAfter(t *testing.T) {
	startAt := at(2026, 6, 10, 4, 30, 30)
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 5, 0, 0),
		func(now time.Time) bool { return !now.Before(startAt) }, nil)
	expect(t, events)
}

func TestTickSendsNoStaleWarning(t *testing.T) {
	startAt := at(2026, 6, 10, 4, 27, 0)
	events, _ := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 4, 40, 0),
		func(now time.Time) bool { return !now.Before(startAt) }, nil)
	expect(t, events, "04:29 warn 60", "04:30 restart")
}

func TestTickSkipsAnOccurrenceNoticedTooLate(t *testing.T) {
	_, st := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 4, 10, 0), nil, nil)
	events, st := run(t, "04:30", at(2026, 6, 10, 7, 0, 0), at(2026, 6, 10, 7, 10, 0), nil, st)
	expect(t, events)
	events, _ = run(t, "04:30", at(2026, 6, 11, 4, 20, 0), at(2026, 6, 11, 4, 40, 0), nil, st)
	expect(t, events, "04:25 warn 300", "04:29 warn 60", "04:30 restart")
}

func TestTickRestartsEveryDay(t *testing.T) {
	events, _ := run(t, "04:30", at(2026, 6, 10, 0, 0, 0), at(2026, 6, 13, 0, 0, 0), nil, nil)
	if len(events) != 9 || strings.Count(strings.Join(events, ","), "restart") != 3 {
		t.Errorf("events = %v", events)
	}
}

func TestTickStartsOverWhenTheScheduleChanges(t *testing.T) {
	events, st := run(t, "04:30", at(2026, 6, 10, 4, 0, 0), at(2026, 6, 10, 4, 26, 0), nil, nil)
	expect(t, events, "04:25 warn 300")
	events, _ = run(t, "06:00", at(2026, 6, 10, 4, 26, 15), at(2026, 6, 10, 6, 10, 0), nil, st)
	expect(t, events, "05:55 warn 300", "05:59 warn 60", "06:00 restart")
}

func restarts(events []string) int {
	return strings.Count(strings.Join(events, ","), "restart")
}

func TestTickFiresOnceWhenTheClocksGoBack(t *testing.T) {
	// 2026-11-01: 01:30 happens twice.
	events, _ := run(t, "01:30", at(2026, 10, 31, 12, 0, 0), at(2026, 11, 1, 12, 0, 0), nil, nil)
	if restarts(events) != 1 || len(events) != 3 {
		t.Errorf("events = %v", events)
	}
}

func TestTickFiresAnHourLateWhenTheClocksSkipTheTime(t *testing.T) {
	// 2026-03-08: 02:00 jumps to 03:00, so 02:30 does not exist. It fires once,
	// at 03:30, exactly like the desktop app.
	events, _ := run(t, "02:30", at(2026, 3, 7, 12, 0, 0), at(2026, 3, 8, 12, 0, 0), nil, nil)
	expect(t, events, "03:25 warn 300", "03:29 warn 60", "03:30 restart")

	// A zone that skips only half an hour (Lord Howe, 2026-10-04 02:00 -> 02:30).
	lordHowe := mustLoad("Australia/Lord_Howe")
	prev, _, err := Occurrences(time.Date(2026, 10, 4, 12, 0, 0, 0, lordHowe), "02:15")
	if err != nil {
		t.Fatal(err)
	}
	if got := prev.Format("2006-01-02 15:04"); got != "2026-10-04 02:45" {
		t.Errorf("02:15 in a half-hour gap fired at %s, want 02:45", got)
	}
}

func TestWarningMessage(t *testing.T) {
	for lead, want := range map[time.Duration]string{
		5 * time.Minute:  "Scheduled restart in 5 minutes",
		time.Minute:      "Scheduled restart in 1 minute",
		10 * time.Second: "Scheduled restart in 10 seconds",
	} {
		if got := WarningMessage(lead); got != want {
			t.Errorf("WarningMessage(%s) = %q, want %q", lead, got, want)
		}
	}
}
