// Package tick reads how fast a Minecraft server is ticking from its own
// answer to the "tick query" command (Minecraft 1.20.3 and newer).
//
// It mirrors src/shared/utils/tick-query.ts of the desktop app, and is tested
// against the same captured console output (testdata/).
//
// The answer is four lines, the second and third being one message:
//
//	[19:25:33 INFO]: The game is running normally
//	[19:25:33 INFO]: Target tick rate: 20.0 per second.
//	Average time per tick: 0.4ms (Target: 50.0ms)
//	[19:25:33 INFO]: Percentiles: P50: 0.3ms P95: 0.5ms P99: 0.7ms. Sample: 100
//
// While the game is sprinting the rate line ends in "(ignored, reference
// only)." and the average comes without a target.
//
// Only the server's own output counts: a chat message or a /say puts
// something between the colon and the text, so a player cannot type a tick
// time into the metrics. The line without a prefix is only accepted right
// after the one it continues.
package tick

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The states a game can be in (see /tick).
const (
	ModeNormal    = "normal"
	ModeSprinting = "sprinting"
	ModeFrozen    = "frozen"
)

// Sample is one answer to "tick query". Times are milliseconds per tick.
type Sample struct {
	// AverageMs is the average time the server needs for one tick.
	AverageMs float64 `json:"averageMs"`
	// TargetMs is the time one tick may take at the target rate (50 at 20/s).
	TargetMs float64 `json:"targetMs"`
	// TargetRate is the ticks per second the server aims for.
	TargetRate float64 `json:"targetRate"`
	// TPS is the ticks per second the server can actually do: the target
	// rate, or less when a tick takes longer than its share. Never more than
	// the target. Absent while sprinting: the target is ignored then.
	TPS *float64 `json:"tps,omitempty"`
	// Mode says what the game was doing.
	Mode       string   `json:"mode"`
	P50Ms      *float64 `json:"p50Ms,omitempty"`
	P95Ms      *float64 `json:"p95Ms,omitempty"`
	P99Ms      *float64 `json:"p99Ms,omitempty"`
	SampleSize *int     `json:"sampleSize,omitempty"`
}

var versionRE = regexp.MustCompile(`^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+ ])`)

// Supported reports whether a Minecraft version has "tick query" (1.20.3+).
// Snapshot names ("24w10a") say nothing about the version: no.
func Supported(mcVersion string) bool {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(mcVersion))
	if m == nil {
		return false
	}
	first, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	switch {
	case first >= 2: // year-based versions (26.1, ...)
		return true
	case first < 1:
		return false
	case minor > 20:
		return true
	}
	return minor == 20 && patch >= 3
}

// Of a length a tick time can have: a number of hundreds of digits is not one.
const number = `(\d{1,9}(?:[.,]\d{1,9})?)`

var (
	ansiRE        = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	messageRE     = regexp.MustCompile(`^(?:\[[^\]]*\]\s*)+:\s(.*?)\s*$`)
	rateRE        = regexp.MustCompile(`^Target tick rate: ` + number + ` per second( \(ignored, reference only\))?\.?$`)
	averageRE     = regexp.MustCompile(`^Average time per tick: ` + number + `ms(?: \(Target: ` + number + `ms\))?$`)
	percentilesRE = regexp.MustCompile(`(?i)^Percentiles: P50: ` + number + `ms P95: ` + number + `ms P99: ` + number + `ms[.,] sample: (\d+)$`)
	// "running normally", "running, but can't keep up with the target tick
	// rate", "sprinting", "frozen".
	statusRE = regexp.MustCompile(`^The game is (running|sprinting|frozen)\b`)
	readyRE  = regexp.MustCompile(`^Done \(\d`)
)

func clean(line string) string {
	return strings.TrimSuffix(ansiRE.ReplaceAllString(line, ""), "\r")
}

// serverMessage is the message of a line the server itself logged.
func serverMessage(line string) (string, bool) {
	m := messageRE.FindStringSubmatch(line)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// num reads a number as the server prints it. Some builds use the system's
// decimal comma.
func num(text string) float64 {
	v, _ := strconv.ParseFloat(strings.Replace(text, ",", ".", 1), 64)
	return v
}

// IsReadyLine reports whether line is the one a server prints when it has
// finished starting and reads its console: `Done (11.138s)! For help, ...`.
func IsReadyLine(line string) bool {
	message, ok := serverMessage(clean(line))
	return ok && readyRE.MatchString(message)
}

// Line is what the reader made of one line.
type Line struct {
	// Part: the line is part of an answer to "tick query".
	Part bool
	// Sample is set on the lines that complete a sample (the average, then
	// the percentiles).
	Sample *Sample
	// End: the answer is complete, nothing more belongs to it.
	End bool
}

const (
	stateIdle = iota
	stateStatus
	stateRate
	stateAverage
)

// Reader reads the answers to "tick query" out of a server's console, line
// by line. Feed it every line the server prints, in order. Not safe for
// concurrent use.
type Reader struct {
	state  int
	rate   float64
	mode   string
	sample *Sample
}

// Feed takes the next line of the console.
func (r *Reader) Feed(raw string) Line {
	line := clean(raw)
	message, isMessage := serverMessage(line)

	switch {
	case r.state == stateRate:
		// The second line of the message that began with the target rate. It
		// has no prefix of its own (some consoles repeat it).
		text := strings.TrimSpace(line)
		if isMessage {
			text = message
		}
		if m := averageRE.FindStringSubmatch(text); m != nil {
			average := num(m[1])
			// A sprinting game is not held to its target, and does not print it.
			target := 1000 / r.rate
			if m[2] != "" {
				target = num(m[2])
			}
			s := &Sample{AverageMs: average, TargetMs: target, TargetRate: r.rate, Mode: r.mode}
			if r.mode != ModeSprinting {
				tps := r.rate
				if average > target && average > 0 && 1000/average < tps {
					tps = 1000 / average
				}
				s.TPS = &tps
			}
			r.sample = s
			r.state = stateAverage
			out := *s
			return Line{Part: true, Sample: &out}
		}
	case r.state == stateAverage && isMessage && r.sample != nil:
		if m := percentilesRE.FindStringSubmatch(message); m != nil {
			full := *r.sample
			p50, p95, p99 := num(m[1]), num(m[2]), num(m[3])
			size, _ := strconv.Atoi(m[4])
			full.P50Ms, full.P95Ms, full.P99Ms, full.SampleSize = &p50, &p95, &p99, &size
			r.state = stateIdle
			r.sample = nil
			return Line{Part: true, Sample: &full, End: true}
		}
	}

	// Not the continuation that was expected: whatever this line is, it is
	// looked at as the possible start of an answer.
	wasOpen := r.state != stateIdle
	// What the line before said the game is doing, if it said so.
	said := ModeNormal
	if r.state == stateStatus {
		said = r.mode
	}
	r.state = stateIdle
	r.sample = nil
	if isMessage {
		if m := rateRE.FindStringSubmatch(message); m != nil && num(m[1]) > 0 {
			r.rate = num(m[1])
			r.mode = said
			if m[2] != "" {
				r.mode = ModeSprinting
			}
			r.state = stateRate
			return Line{Part: true}
		}
		if m := statusRE.FindStringSubmatch(message); m != nil {
			switch m[1] {
			case "sprinting":
				r.mode = ModeSprinting
			case "frozen":
				r.mode = ModeFrozen
			default:
				r.mode = ModeNormal
			}
			r.state = stateStatus
			return Line{Part: true}
		}
	}
	return Line{End: wasOpen}
}

// AnswerWindow is how long after a question the server's answer is taken for
// the answer to it.
const AnswerWindow = 3 * time.Second

// AnswerFilter tells the answers to the daemon's own questions from
// everything else in a server's console, so that they can be kept out of the
// console clients see. Only the first answer that begins shortly after a
// question is the daemon's: what the server answers to a "tick query"
// somebody typed, or a plugin sent, is theirs to see. Every answer is read,
// whoever asked. Not safe for concurrent use.
type AnswerFilter struct {
	reader        Reader
	expectedUntil time.Time
	inOwnAnswer   bool
}

// Asked says that the daemon has just asked.
func (f *AnswerFilter) Asked(now time.Time) {
	f.inOwnAnswer = false
	f.expectedUntil = now.Add(AnswerWindow)
}

// Feed takes a line the server printed. own: it is part of the answer to the
// daemon.
func (f *AnswerFilter) Feed(line string, now time.Time) (own bool, sample *Sample) {
	read := f.reader.Feed(line)
	if read.Part && !f.inOwnAnswer && now.Before(f.expectedUntil) {
		f.inOwnAnswer = true
		f.expectedUntil = time.Time{}
	}
	own = read.Part && f.inOwnAnswer
	if read.End || !read.Part {
		f.inOwnAnswer = false
	}
	return own, read.Sample
}

const (
	// QueryInterval is how often a server is asked at most.
	QueryInterval = 15 * time.Second
	// MaxMisses is after how many questions in a row without an answer the
	// server is left alone.
	MaxMisses = 3
	// SampleMaxAge is how old a sample may be to pass for the current state.
	SampleMaxAge = 45 * time.Second
)

// The reasons why a server is not asked at all.
const (
	StatusUnsupported = "unsupported"
	StatusUnavailable = "unavailable"
)

// Policy decides when a running server is asked for its tick time.
//
// Every question puts four lines into the server's own log file, so it is
// only asked when somebody wants the numbers (ShouldAsk is called then, and
// only then), never before it has finished starting, and no more once it has
// shown that it does not answer. An answer that does come after that, to a
// question somebody typed for instance, shows that it answers after all, and
// the asking starts again. Not safe for concurrent use.
type Policy struct {
	supported bool
	ready     bool
	asked     bool
	lastAsked time.Time
	waiting   bool
	misses    int
}

// NewPolicy returns the policy for a server of the given Minecraft version.
func NewPolicy(mcVersion string) *Policy { return &Policy{supported: Supported(mcVersion)} }

// ServerReady says that the server has finished starting.
func (p *Policy) ServerReady() { p.ready = true }

// Status is why the server is not asked at all, or "" if it is.
func (p *Policy) Status() string {
	switch {
	case !p.supported:
		return StatusUnsupported
	case p.misses >= MaxMisses:
		return StatusUnavailable
	}
	return ""
}

// ShouldAsk reports whether to ask now. running is false while the server is
// stopping.
func (p *Policy) ShouldAsk(now time.Time, running bool) bool {
	if !p.supported || !p.ready || !running {
		return false
	}
	due := !p.asked || now.Sub(p.lastAsked) >= QueryInterval
	// The last question went unanswered for a whole interval.
	if p.waiting && due {
		p.waiting = false
		p.misses++
	}
	if p.misses >= MaxMisses {
		return false
	}
	return !p.waiting && due
}

// Asked says that the question was sent.
func (p *Policy) Asked(now time.Time) {
	p.asked = true
	p.lastAsked = now
	p.waiting = true
}

// Answered says that an answer came.
func (p *Policy) Answered() {
	p.waiting = false
	p.misses = 0
}
