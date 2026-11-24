package server

import (
	"io"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/procstat"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/slp"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/tick"
)

const (
	// cpuMinInterval is the shortest stretch a processor use is worked out
	// over: two readings closer than this say little.
	cpuMinInterval = time.Second
	// playersMaxAge is how old the player count may be before the server is
	// asked again; playersTimeout how long it gets to answer.
	playersMaxAge  = 5 * time.Second
	playersTimeout = 2 * time.Second
	// cpuMaxInterval is the longest stretch a processor use is worked out
	// over. After a pause in the requests the average since the last one
	// would pass for what the server is doing now.
	cpuMaxInterval = 30 * time.Second
)

// Metrics is what a running server is doing now. Every measurement is
// optional: one that could not be taken is left out, never reported as zero.
type Metrics struct {
	ServerID string `json:"serverId"`
	// At is the host's clock when this was put together (epoch ms). The age
	// of a measurement is to be judged against it, not against the clock of
	// whoever reads this.
	At int64 `json:"at"`
	// CPU is the processor use of the server and everything it started, in
	// percent of one core (200 is two cores busy). Absent on the first
	// request (it takes two readings) and where the host cannot be asked.
	CPU *float64 `json:"cpu,omitempty"`
	// Memory is the physical memory the server uses, in bytes.
	Memory *uint64 `json:"memory,omitempty"`
	// Players is who is on, as the server tells the game's server list.
	Players *PlayerCount `json:"players,omitempty"`
	// Tick is the server's last answer to "tick query".
	Tick *TickMetrics `json:"tick,omitempty"`
	// TickStatus says why there is no tick time and none will come:
	// "unsupported" (Minecraft before 1.20.3) or "unavailable" (the server
	// does not answer the command).
	TickStatus string `json:"tickStatus,omitempty"`
}

// PlayerCount is how many players are on a server, and when it said so.
type PlayerCount struct {
	Online int   `json:"online"`
	Max    int   `json:"max"`
	At     int64 `json:"at"`
}

// TickMetrics is an answer to "tick query" and when it came (epoch ms).
type TickMetrics struct {
	tick.Sample
	At int64 `json:"at"`
}

// metricsState is what the daemon knows about one run of a server. It lives
// on the runningServer, so a restart begins with nothing. Guarded by
// Manager.mu.
type metricsState struct {
	policy  *tick.Policy
	answers tick.AnswerFilter
	tick    *TickMetrics

	usage   procstat.Usage
	usageAt time.Time
	cpu     *float64
	// noUsage: the host cannot be asked (see procstat.ErrUnsupported).
	noUsage bool

	players   *PlayerCount
	playersAt time.Time
	pinging   bool
}

func newMetricsState(s store.Server) *metricsState {
	return &metricsState{policy: tick.NewPolicy(s.MinecraftVersion)}
}

// observeLine is shown every line a server writes to its output, before
// anybody else. It reports whether the line is part of the answer to a
// question of the daemon's own, which is kept out of the console.
func (m *Manager) observeLine(rs *runningServer, line string) (own bool) {
	now := time.Now()
	ready := tick.IsReadyLine(line)

	m.mu.Lock()
	defer m.mu.Unlock()
	ms := rs.metrics
	if ms == nil {
		return false
	}
	if ready {
		ms.policy.ServerReady()
	}
	own, sample := ms.answers.Feed(line, now)
	if sample != nil {
		ms.tick = &TickMetrics{Sample: *sample, At: now.UnixMilli()}
		ms.policy.Answered()
	}
	return own
}

// Metrics reports what a running server is doing.
//
// Asking is what keeps the tick time coming: the server is sent "tick query"
// (at most every tick.QueryInterval) only when somebody asks for its metrics,
// because every question leaves four lines in the server's own log. Nothing
// here runs on a timer.
func (m *Manager) Metrics(id string) (Metrics, error) {
	s, err := m.store.Get(id)
	if err != nil {
		return Metrics{}, err
	}
	now := time.Now()

	m.mu.Lock()
	rs := m.running[id]
	if rs == nil || rs.metrics == nil || rs.cmd.Process == nil {
		m.mu.Unlock()
		return Metrics{}, conflictError("The server is not running")
	}
	ms := rs.metrics
	pid := rs.cmd.Process.Pid

	// Not while it is stopping: it no longer reads its console.
	ask := ms.policy.ShouldAsk(now, !rs.stopping && !m.shuttingDown)
	if ask {
		ms.policy.Asked(now)
		ms.answers.Asked(now)
	}
	ping := !ms.pinging && s.Port > 0 && (ms.playersAt.IsZero() || now.Sub(ms.playersAt) >= playersMaxAge)
	if ping {
		ms.pinging = true
	}
	measure := !ms.noUsage && (ms.usageAt.IsZero() || now.Sub(ms.usageAt) >= cpuMinInterval)
	m.mu.Unlock()

	// Outside the lock: the goroutine that reads the server's output takes it
	// for every line, and must never wait for a write to the server's input.
	if ask {
		_, _ = io.WriteString(rs.stdin, "tick query\n")
	}
	if ping {
		go m.refreshPlayers(rs, s.Port)
	}
	var usage procstat.Usage
	var usageErr error
	if measure {
		usage, usageErr = procstat.Tree(pid)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	out := Metrics{ServerID: id, At: now.UnixMilli(), TickStatus: ms.policy.Status()}
	if measure {
		switch {
		case usageErr == procstat.ErrUnsupported:
			ms.noUsage = true
		case usageErr != nil:
			// The process is on its way out, most likely: no numbers now.
			ms.cpu, ms.usageAt = nil, time.Time{}
		default:
			// Another request may have taken a reading while this one took
			// its own: the stretch between the two is decided here, under the
			// lock, not when the reading was started.
			elapsed := now.Sub(ms.usageAt)
			switch {
			case ms.usageAt.IsZero() || elapsed > cpuMaxInterval:
				// The first reading (of this run, or after a pause): a
				// baseline, and no processor use yet.
				ms.cpu = nil
				ms.usage, ms.usageAt = usage, now
			case elapsed >= cpuMinInterval:
				if percent, ok := procstat.Percent(ms.usage, usage, elapsed); ok {
					ms.cpu = &percent
				} else {
					ms.cpu = nil
				}
				ms.usage, ms.usageAt = usage, now
			default:
				// Too close to the last one to say anything: it stands.
			}
		}
	}
	if !ms.noUsage && !ms.usageAt.IsZero() {
		memory := ms.usage.Memory
		out.Memory = &memory
		if ms.cpu != nil {
			cpu := *ms.cpu
			out.CPU = &cpu
		}
	}
	if ms.players != nil {
		players := *ms.players
		out.Players = &players
	}
	if ms.tick != nil {
		t := *ms.tick
		out.Tick = &t
	}
	return out, nil
}

// refreshPlayers asks the server who is on. It runs beside the request that
// noticed the count was old: a server that is still starting, or has its
// status turned off, must not make the metrics wait.
func (m *Manager) refreshPlayers(rs *runningServer, port int) {
	players, err := slp.Query("127.0.0.1", port, playersTimeout)
	now := time.Now()

	m.mu.Lock()
	defer m.mu.Unlock()
	ms := rs.metrics
	ms.pinging = false
	ms.playersAt = now
	if err != nil {
		// Not answering (yet, or at all): no count, instead of an old one.
		ms.players = nil
		return
	}
	ms.players = &PlayerCount{Online: players.Online, Max: players.Max, At: now.UnixMilli()}
}
