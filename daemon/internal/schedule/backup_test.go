package schedule

import (
	"reflect"
	"testing"
	"time"
)

// The same cases as src/shared/utils/backup-schedule.test.ts in the app.

func day(d, h, m, s int) time.Time { return time.Date(2026, 6, d, h, m, s, 0, time.Local) }

func mustTickBackup(t *testing.T, now time.Time, schedule string, previous *BackupState) (*BackupState, BackupAction) {
	t.Helper()
	st, act, err := TickBackup(now, schedule, previous)
	if err != nil {
		t.Fatal(err)
	}
	return st, act
}

func TestValidKeep(t *testing.T) {
	for _, n := range []int{1, 7, 365} {
		if !ValidKeep(n) {
			t.Errorf("ValidKeep(%d) = false", n)
		}
	}
	for _, n := range []int{0, -1, 366} {
		if ValidKeep(n) {
			t.Errorf("ValidKeep(%d) = true", n)
		}
	}
}

func TestBackupTickDoesNothingOnTheFirstLook(t *testing.T) {
	st, act := mustTickBackup(t, day(10, 4, 0, 5), "04:00", nil)
	if !act.Due.IsZero() || !act.Missed.IsZero() {
		t.Fatalf("action = %+v", act)
	}
	if !st.Handled.Equal(day(10, 4, 0, 0)) {
		t.Fatalf("handled = %v", st.Handled)
	}
}

func TestBackupTickStaysDueUntilStarted(t *testing.T) {
	st, _ := mustTickBackup(t, day(10, 3, 59, 50), "04:00", nil)
	if _, act := mustTickBackup(t, day(10, 3, 59, 55), "04:00", st); !act.Due.IsZero() {
		t.Fatal("due before its time")
	}
	first, act := mustTickBackup(t, day(10, 4, 0, 5), "04:00", st)
	if !act.Due.Equal(day(10, 4, 0, 0)) {
		t.Fatalf("due = %v", act.Due)
	}
	// Could not start (server busy): the next tick asks again.
	again, act := mustTickBackup(t, day(10, 4, 0, 20), "04:00", first)
	if !act.Due.Equal(day(10, 4, 0, 0)) {
		t.Fatalf("due again = %v", act.Due)
	}
	st = BackupStarted(again, act.Due)
	if _, act := mustTickBackup(t, day(10, 4, 0, 35), "04:00", st); !act.Due.IsZero() {
		t.Fatal("due again after it was started")
	}
	// And the day after it is due again.
	if _, act := mustTickBackup(t, day(11, 4, 0, 5), "04:00", st); !act.Due.Equal(day(11, 4, 0, 0)) {
		t.Fatalf("next day due = %v", act.Due)
	}
}

func TestBackupTickGivesUpAfterTheWindow(t *testing.T) {
	st, _ := mustTickBackup(t, day(10, 3, 0, 0), "04:00", nil)
	late := day(10, 4, 0, 0).Add(BackupStartWindow + time.Second)
	next, act := mustTickBackup(t, late, "04:00", st)
	if !act.Due.IsZero() || !act.Missed.Equal(day(10, 4, 0, 0)) {
		t.Fatalf("action = %+v", act)
	}
	// Reported once.
	if _, act := mustTickBackup(t, late.Add(15*time.Second), "04:00", next); !act.Missed.IsZero() || !act.Due.IsZero() {
		t.Fatalf("second action = %+v", act)
	}
}

func TestBackupTickDoesNotCatchUpAfterASuspend(t *testing.T) {
	st, _ := mustTickBackup(t, day(10, 3, 0, 0), "04:00", nil)
	_, act := mustTickBackup(t, day(12, 9, 0, 0), "04:00", st)
	if !act.Due.IsZero() || !act.Missed.Equal(day(12, 4, 0, 0)) {
		t.Fatalf("action = %+v", act)
	}
}

func TestBackupTickStartsOverWhenTheScheduleChanges(t *testing.T) {
	st, _ := mustTickBackup(t, day(10, 3, 0, 0), "04:00", nil)
	next, act := mustTickBackup(t, day(10, 3, 30, 10), "03:30", st)
	if !act.Due.IsZero() || !act.Missed.IsZero() {
		t.Fatalf("action = %+v", act)
	}
	if next.Schedule != "03:30" || !next.Handled.Equal(day(10, 3, 30, 0)) {
		t.Fatalf("state = %+v", next)
	}
}

func TestBackupTickRejectsWhatIsNotASchedule(t *testing.T) {
	if _, _, err := TickBackup(day(10, 3, 0, 0), "24:00", nil); err == nil {
		t.Fatal("no error")
	}
}

func TestBackupRetryMakesTheOccurrenceDueAgain(t *testing.T) {
	st, _ := mustTickBackup(t, day(10, 3, 59, 50), "04:00", nil)
	st, act := mustTickBackup(t, day(10, 4, 0, 5), "04:00", st)
	st = BackupStarted(st, act.Due)
	st = BackupRetry(st, act.Due)
	if _, again := mustTickBackup(t, day(10, 4, 0, 35), "04:00", st); !again.Due.Equal(act.Due) {
		t.Fatalf("not due again: %+v", again)
	}
	// Past the window it is given up on like any other.
	if _, late := mustTickBackup(t, day(10, 4, 11, 0), "04:00", st); !late.Missed.Equal(act.Due) {
		t.Fatalf("not missed: %+v", late)
	}
	// An older occurrence than the one last handled changes nothing.
	started := BackupStarted(st, act.Due)
	if got := BackupRetry(started, act.Due.Add(-24*time.Hour)); got != started {
		t.Fatal("a stale retry changed the state")
	}
	if BackupRetry(nil, act.Due) != nil {
		t.Fatal("retry of no state")
	}
}

func TestScheduledToPrune(t *testing.T) {
	ids := []string{
		"20260601-040000-scheduled",
		"20260602-040000-scheduled",
		"20260603-040000-scheduled",
		"20260604-040000-scheduled",
		"20260101-120000-manual",
		"20260102-120000-pre-restore",
	}
	check := func(name string, got, want []string) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	// Keeps the newest scheduled ones and never touches the other kinds.
	check("keep 2", ScheduledToPrune(ids, 2, ""), []string{"20260602-040000-scheduled", "20260601-040000-scheduled"})
	check("keep 4", ScheduledToPrune(ids, 4, ""), []string{})
	check("keep 10", ScheduledToPrune(ids, 10, ""), []string{})
	if n := len(ScheduledToPrune(ids, 1, "")); n != 3 {
		t.Errorf("keep 1 prunes %d", n)
	}

	// Never the backup that was just made, even when the clock went back: it
	// takes one of the places, the newest other one takes the second.
	withOld := append(append([]string{}, ids...), "20250101-040000-scheduled")
	check("just created", ScheduledToPrune(withOld, 2, "20250101-040000-scheduled"),
		[]string{"20260603-040000-scheduled", "20260602-040000-scheduled", "20260601-040000-scheduled"})
	// A backup that is not in the list takes no place.
	check("just created, not listed", ScheduledToPrune(ids, 2, "20270101-040000-scheduled"),
		[]string{"20260602-040000-scheduled", "20260601-040000-scheduled"})

	// Nothing for a number that makes no sense.
	for _, keep := range []int{0, -3, 366} {
		check("bad keep", ScheduledToPrune(ids, keep, ""), []string{})
	}
	// Names that are not backup ids are ignored.
	check("not ids", ScheduledToPrune([]string{"x-scheduled", "../../a-scheduled", "scheduled"}, 1, ""), []string{})
}

func TestDeferredRestartAction(t *testing.T) {
	base := day(10, 4, 0, 0)
	at := func(ms int) time.Time { return base.Add(time.Duration(ms) * time.Millisecond) }
	cases := []struct {
		now, deadline         int
		running, backupActive bool
		want                  string
	}{
		{1000, 5000, true, true, DeferredWait},
		{1000, 5000, true, false, DeferredRestart},
		{5000, 5000, true, true, DeferredRestart},
		{1000, 5000, false, true, DeferredDrop},
		{1000, 5000, false, false, DeferredDrop},
		// The host slept through the wait: no restart hours later.
		{5000 + 3_600_000, 5000, true, false, DeferredDrop},
		{5000 + 30_000, 5000, true, true, DeferredRestart},
	}
	for _, c := range cases {
		if got := DeferredRestartAction(at(c.now), at(c.deadline), c.running, c.backupActive); got != c.want {
			t.Errorf("%+v = %s", c, got)
		}
	}
}
