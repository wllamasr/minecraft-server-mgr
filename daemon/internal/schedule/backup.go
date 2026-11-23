package schedule

import (
	"regexp"
	"sort"
	"time"
)

// Daily scheduled backups, and which of them to keep.
//
// Like a scheduled restart, a backup schedule is a wall-clock time, "HH:MM",
// in the time zone of the host. Unlike a restart, a backup that cannot start
// at its minute (the server is starting, stopping, or already being backed
// up) is tried again for a while before it is given up on.
//
// The desktop app implements the same rules for local servers
// (src/shared/utils/backup-schedule.ts).

// BackupStartWindow is how long after its time a scheduled backup may still
// be started. Past it (the server stayed busy, or the host was suspended) the
// occurrence is given up on and reported as missed.
const BackupStartWindow = 10 * time.Minute

// How many scheduled backups are kept.
const (
	KeepDefault = 7
	KeepMin     = 1
	KeepMax     = 365
)

// ValidKeep reports whether n is a number of scheduled backups to keep.
func ValidKeep(n int) bool { return n >= KeepMin && n <= KeepMax }

// BackupState is what the scheduler remembers about the backups of one server
// between ticks.
type BackupState struct {
	// Schedule this state was built for; a changed schedule starts over.
	Schedule string
	// Handled is the newest occurrence that was started or given up on.
	Handled time.Time
}

// BackupAction is what to do about the scheduled backup of one server now.
// At most one of the two is set.
type BackupAction struct {
	// Due is an occurrence whose backup should be started now. It stays due on
	// the following ticks until the caller reports it with BackupStarted.
	Due time.Time
	// Missed is an occurrence that could not be started in time and is given
	// up on. It is reported once.
	Missed time.Time
}

// TickBackup decides what to do about the scheduled backup of one server at
// now and returns the state to pass to the next tick. previous is nil on the
// first tick.
func TickBackup(now time.Time, schedule string, previous *BackupState) (*BackupState, BackupAction, error) {
	prev, _, err := Occurrences(now, schedule)
	if err != nil {
		return previous, BackupAction{}, err
	}
	if previous == nil || previous.Schedule != schedule {
		// First look at this schedule: nothing in the past is due.
		return &BackupState{Schedule: schedule, Handled: prev}, BackupAction{}, nil
	}
	if !prev.After(previous.Handled) {
		return previous, BackupAction{}, nil
	}
	if now.Sub(prev) > BackupStartWindow {
		return &BackupState{Schedule: schedule, Handled: prev}, BackupAction{Missed: prev}, nil
	}
	return previous, BackupAction{Due: prev}, nil
}

// BackupStarted returns state with occurrence counted as handled: from the
// moment a backup starts it is reported, not repeated, if it fails.
func BackupStarted(state *BackupState, occurrence time.Time) *BackupState {
	next := *state
	if occurrence.After(next.Handled) {
		next.Handled = occurrence
	}
	return &next
}

// BackupRetry returns state with occurrence due again, when it is the one
// that was last handled: its backup turned out not to be possible yet.
func BackupRetry(state *BackupState, occurrence time.Time) *BackupState {
	if state == nil || !state.Handled.Equal(occurrence) {
		return state
	}
	next := *state
	next.Handled = occurrence.Add(-time.Second)
	return &next
}

var scheduledID = regexp.MustCompile(`^\d{8}-\d{6}-scheduled$`)

// ScheduledToPrune returns the ids, among those of the backups of one server,
// of the scheduled backups to delete so that only the newest keep remain.
// Backups of other kinds are never chosen. justCreated, when not empty, is a
// backup that was just made: it always counts as kept, wherever it sorts (the
// clock may have gone back).
func ScheduledToPrune(ids []string, keep int, justCreated string) []string {
	out := []string{}
	if !ValidKeep(keep) {
		return out
	}
	room := keep
	var others []string
	for _, id := range ids {
		switch {
		case !scheduledID.MatchString(id):
		case justCreated != "" && id == justCreated:
			room = keep - 1
		default:
			others = append(others, id)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(others)))
	if room < 0 {
		room = 0
	}
	if room < len(others) {
		out = append(out, others[room:]...)
	}
	return out
}

// RestartWaitForBackup is how long a scheduled restart waits for a backup in
// progress before going ahead (which cancels the backup).
const RestartWaitForBackup = 15 * time.Minute

// What to do with a scheduled restart that was put off.
const (
	DeferredWait    = "wait"
	DeferredRestart = "restart"
	DeferredDrop    = "drop"
)

// DeferredRestartAction decides what to do with a scheduled restart that was
// put off because a backup was running when it came due. deadline is when the
// wait ends.
func DeferredRestartAction(now, deadline time.Time, serverRunning, backupRunning bool) string {
	if !serverRunning {
		return DeferredDrop
	}
	// Noticed long after the wait was over (the host was suspended): too
	// late, like any other scheduled restart.
	if now.Sub(deadline) > LateTolerance {
		return DeferredDrop
	}
	if backupRunning && now.Before(deadline) {
		return DeferredWait
	}
	return DeferredRestart
}
