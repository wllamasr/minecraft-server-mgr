// Package schedule decides when a server's daily scheduled restart is due.
//
// A schedule is a wall-clock time, "HH:MM" (24 h), in the time zone of the
// host. The scheduler is a stateless tick: every few seconds it asks Tick what
// to do right now. The only memory is which occurrence was already handled or
// warned about, so nothing has to be cancelled when a server is stopped,
// edited or deleted.
//
// The desktop app implements the same rules for local servers
// (src/shared/utils/restart-schedule.ts).
package schedule

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// Warnings lists how long before a scheduled restart players are warned,
// widest first.
var Warnings = []time.Duration{5 * time.Minute, time.Minute}

// LateTolerance bounds how late an occurrence may be noticed and still be
// carried out. Past it (the host was suspended) the occurrence is skipped.
const LateTolerance = time.Minute

var pattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):([0-5][0-9])$`)

// Valid reports whether s is a schedule: "HH:MM" in 24-hour time.
func Valid(s string) bool { return pattern.MatchString(s) }

// Occurrences returns the last occurrence at or before now and the first one
// after it, in now's location.
func Occurrences(now time.Time, schedule string) (prev, next time.Time, err error) {
	m := pattern.FindStringSubmatch(schedule)
	if m == nil {
		return prev, next, fmt.Errorf("invalid restart schedule %q", schedule)
	}
	hour, _ := strconv.Atoi(m[1])
	minute, _ := strconv.Atoi(m[2])

	// Built from calendar dates, not by adding 24 h, so the schedule keeps its
	// wall-clock time across daylight-saving changes.
	y, mo, d := now.Date()
	for offset := -2; offset <= 2; offset++ {
		at := time.Date(y, mo, d+offset, hour, minute, 0, 0, now.Location())
		// On the day the clocks skip this time, time.Date may land on either
		// side of the gap. Always take the later side (02:30 becomes 03:30), as
		// the desktop app does.
		if missed := time.Duration(hour-at.Hour())*time.Hour + time.Duration(minute-at.Minute())*time.Minute; missed > 0 && missed <= 3*time.Hour {
			at = at.Add(missed)
		}
		if !at.After(now) {
			if prev.IsZero() || at.After(prev) {
				prev = at
			}
		} else if next.IsZero() || at.Before(next) {
			next = at
		}
	}
	return prev, next, nil
}

// State is what the scheduler remembers about one server between ticks.
type State struct {
	// Schedule this state was built for; a changed schedule starts over.
	Schedule string
	// Handled is the newest occurrence that was already dealt with.
	Handled time.Time
	// WarnedFor is the occurrence the warnings below belong to.
	WarnedFor time.Time
	// Warned lists the warnings already sent, or skipped, for WarnedFor.
	Warned map[time.Duration]bool
}

// Action is what to do for one server right now.
type Action struct {
	// Warn, when non-zero, is the lead time of the warning to announce.
	Warn time.Duration
	// Restart says to restart the server now.
	Restart bool
}

// Tick decides what to do for one server at now and returns the state to pass
// to the next tick. previous is nil on the first tick.
//
//   - A restart is due when an occurrence has passed since the last tick. It is
//     only carried out if the server is running at that moment and the tick is
//     not too late; either way the occurrence counts as handled, so a server
//     that is started a minute later is not restarted at once.
//   - Warnings go only to a running server, each once per occurrence. A
//     schedule that is set less than a warning's lead time ahead skips that
//     warning instead of sending it late.
func Tick(now time.Time, schedule string, running bool, previous *State) (*State, Action, error) {
	prev, next, err := Occurrences(now, schedule)
	if err != nil {
		return previous, Action{}, err
	}
	remaining := next.Sub(now)

	var st State
	if previous == nil || previous.Schedule != schedule {
		// First look at this schedule: nothing in the past is due, and warnings
		// whose moment has already gone by are not sent late.
		st = State{Schedule: schedule, Handled: prev, WarnedFor: next, Warned: map[time.Duration]bool{}}
		for _, w := range Warnings {
			if remaining < w-30*time.Second {
				st.Warned[w] = true
			}
		}
	} else {
		st = *previous
		st.Warned = make(map[time.Duration]bool, len(previous.Warned))
		for w, sent := range previous.Warned {
			st.Warned[w] = sent
		}
	}

	var act Action
	if prev.After(st.Handled) {
		act.Restart = running && now.Sub(prev) <= LateTolerance
		st.Handled = prev
	}

	if !st.WarnedFor.Equal(next) {
		st.WarnedFor = next
		st.Warned = map[time.Duration]bool{}
	}

	// The tightest warning whose moment has come; wider ones are then moot.
	var tightest time.Duration
	for _, w := range Warnings {
		if remaining <= w {
			tightest = w
		}
	}
	if tightest != 0 && !st.Warned[tightest] {
		// Nobody to warn on a stopped server: the warning counts as skipped, so
		// a server started three minutes before is not told "in 5 minutes".
		if running && !act.Restart {
			act.Warn = tightest
		}
		for _, w := range Warnings {
			if remaining <= w {
				st.Warned[w] = true
			}
		}
	}

	return &st, act, nil
}

// WarningMessage is the line announced to players.
func WarningMessage(lead time.Duration) string {
	if lead >= time.Minute {
		minutes := int(lead.Round(time.Minute) / time.Minute)
		if minutes == 1 {
			return "Scheduled restart in 1 minute"
		}
		return fmt.Sprintf("Scheduled restart in %d minutes", minutes)
	}
	return fmt.Sprintf("Scheduled restart in %d seconds", int(lead/time.Second))
}
