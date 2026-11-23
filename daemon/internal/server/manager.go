// Package server is the daemon's server engine: it creates, provisions, runs,
// and supervises Minecraft server processes on the host.
package server

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/console"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/java"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/jvm"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/loader"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/schedule"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/software"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

// Status is a server's runtime state.
type Status string

const (
	StatusStopped      Status = "stopped"
	StatusRunning      Status = "running"
	StatusStopping     Status = "stopping"
	StatusCrashed      Status = "crashed"
	StatusProvisioning Status = "provisioning"
	StatusError        Status = "error"
)

const (
	maxRestarts     = 3
	restartWindow   = time.Minute
	restartCooldown = 5 * time.Second
	// killWait bounds the wait for the exit after a forced kill.
	killWait = 10 * time.Second
)

// CreateInput describes a new server request.
type CreateInput struct {
	Name             string      `json:"name"`
	MinecraftVersion string      `json:"minecraftVersion"`
	ModLoader        string      `json:"modLoader,omitempty"`
	ModLoaderVersion string      `json:"modLoaderVersion,omitempty"`
	Port             int         `json:"port,omitempty"`
	MinRAM           string      `json:"minRam,omitempty"`
	MaxRAM           string      `json:"maxRam,omitempty"`
	JVMProfile       string      `json:"jvmProfile,omitempty"`
	AutoStart        bool        `json:"autoStart,omitempty"`
	Modpack          *ModpackRef `json:"modpack,omitempty"`
}

// ModpackRef points at a Modrinth modpack to deploy from.
type ModpackRef struct {
	Source    string `json:"source"`
	ProjectID string `json:"projectId"`
	VersionID string `json:"versionId"`
	MrpackURL string `json:"mrpackUrl"`
	Name      string `json:"name"`
}

// View is a server record plus its runtime status and PID.
type View struct {
	store.Server
	Status Status `json:"status"`
	PID    int    `json:"pid,omitempty"`
}

type runningServer struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	status   Status
	stopping bool
	exited   chan struct{}
}

// Manager owns all servers and their processes.
type Manager struct {
	cfg   config.Config
	store *store.Store
	hub   *console.Hub
	java  *java.Manager

	// updateMu serializes changes to stored server records.
	updateMu sync.Mutex

	// stopGrace is how long a server gets to save and exit after "stop"
	// before it is killed.
	stopGrace time.Duration

	mu            sync.Mutex
	running       map[string]*runningServer
	provisioning  map[string]Status
	restarts      map[string][]time.Time
	restartTimers map[string]*time.Timer
	// deleting marks servers that are being removed: they must not be started
	// (by a restart in flight, say) or have their record written back.
	deleting map[string]bool
	// restarting marks servers with a restart in flight; a second request
	// joins the first instead of stopping the server again.
	restarting map[string]bool
	// schedules is the scheduler's memory. Only the scheduler goroutine uses it.
	schedules map[string]*schedule.State
	// shuttingDown is set by StopAll: nothing is started or restarted after it.
	shuttingDown bool
}

// NewManager constructs a Manager.
func NewManager(cfg config.Config, st *store.Store, hub *console.Hub) *Manager {
	if cfg.StopGrace <= 0 {
		cfg.StopGrace = config.DefaultStopGrace
	}
	return &Manager{
		cfg:           cfg,
		store:         st,
		hub:           hub,
		java:          java.New(cfg.JavaDir, cfg.JavaPath),
		stopGrace:     cfg.StopGrace,
		running:       map[string]*runningServer{},
		provisioning:  map[string]Status{},
		restarts:      map[string][]time.Time{},
		restartTimers: map[string]*time.Timer{},
		restarting:    map[string]bool{},
		deleting:      map[string]bool{},
		schedules:     map[string]*schedule.State{},
	}
}

// Hub exposes the console/event hub for the API layer.
func (m *Manager) Hub() *console.Hub { return m.hub }

// JavaInstallations reports the JDKs discovered on the host (for /v1/info).
func (m *Manager) JavaInstallations() []java.Installation { return m.java.Detect() }

// List returns every server with its current status.
func (m *Manager) List() []View {
	servers := m.store.List()
	out := make([]View, 0, len(servers))
	for _, s := range servers {
		out = append(out, m.view(s))
	}
	return out
}

// Get returns one server view.
func (m *Manager) Get(id string) (View, error) {
	s, err := m.store.Get(id)
	if err != nil {
		return View{}, err
	}
	return m.view(s), nil
}

func (m *Manager) view(s store.Server) View {
	v := View{Server: s, Status: m.statusOf(s.ID)}
	m.mu.Lock()
	if rs := m.running[s.ID]; rs != nil && rs.cmd.Process != nil {
		v.PID = rs.cmd.Process.Pid
	}
	m.mu.Unlock()
	return v
}

func (m *Manager) statusOf(id string) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rs := m.running[id]; rs != nil {
		return rs.status
	}
	if p, ok := m.provisioning[id]; ok {
		return p
	}
	return StatusStopped
}

// Create registers a server and provisions it in the background.
func (m *Manager) Create(in CreateInput) (store.Server, error) {
	if strings.TrimSpace(in.Name) == "" {
		return store.Server{}, errors.New("name is required")
	}
	if in.MinecraftVersion == "" {
		return store.Server{}, errors.New("minecraftVersion is required")
	}
	if in.ModLoader != "" {
		if !loader.Valid(in.ModLoader) && !software.Valid(in.ModLoader) {
			return store.Server{}, fmt.Errorf("unknown mod loader: %s", in.ModLoader)
		}
		if in.ModLoaderVersion == "" {
			return store.Server{}, fmt.Errorf("modLoaderVersion is required for %s", in.ModLoader)
		}
		// The version ends up in download URLs and installer arguments.
		if !engineVersionPattern.MatchString(in.ModLoaderVersion) {
			return store.Server{}, fmt.Errorf("invalid modLoaderVersion: %s", in.ModLoaderVersion)
		}
	}
	if (in.Modpack == nil || in.Modpack.MrpackURL == "") && software.Valid(in.ModLoader) {
		if !software.IsReleaseVersion(in.MinecraftVersion) {
			return store.Server{}, fmt.Errorf("invalid minecraftVersion: %s", in.MinecraftVersion)
		}
		if !software.ValidBuildID(in.ModLoaderVersion) {
			return store.Server{}, fmt.Errorf("modLoaderVersion must be a %s build number", in.ModLoader)
		}
	}
	minRAM, maxRAM := orStr(in.MinRAM, "1G"), orStr(in.MaxRAM, "2G")
	if !jvm.ValidRAM(minRAM) {
		return store.Server{}, fmt.Errorf("invalid minRam: %s", minRAM)
	}
	if !jvm.ValidRAM(maxRAM) {
		return store.Server{}, fmt.Errorf("invalid maxRam: %s", maxRAM)
	}
	if !jvm.ValidProfile(in.JVMProfile) {
		return store.Server{}, fmt.Errorf("unknown jvmProfile: %s", in.JVMProfile)
	}
	if err := jvm.Validate(minRAM, maxRAM, in.JVMProfile); err != nil {
		// Only one bound was given and it crosses the other's default: follow it.
		switch {
		case in.MinRAM == "" && in.MaxRAM != "":
			minRAM = maxRAM
		case in.MaxRAM == "" && in.MinRAM != "":
			maxRAM = minRAM
		default:
			return store.Server{}, err
		}
	}

	dir := filepath.Join(m.cfg.ServersRoot, sanitizeName(in.Name))
	if _, err := os.Stat(dir); err == nil {
		return store.Server{}, fmt.Errorf("server directory already exists: %s", dir)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return store.Server{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	s := store.Server{
		ID:               newID(),
		Name:             in.Name,
		Dir:              dir,
		MinecraftVersion: in.MinecraftVersion,
		ModLoader:        in.ModLoader,
		ModLoaderVersion: in.ModLoaderVersion,
		Port:             orInt(in.Port, 25565),
		MinRAM:           minRAM,
		MaxRAM:           maxRAM,
		JVMProfile:       in.JVMProfile,
		AutoStart:        in.AutoStart,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if in.Modpack != nil {
		s.ModpackSource = in.Modpack.Source
		s.ModpackProjectID = in.Modpack.ProjectID
		s.ModpackVersionID = in.Modpack.VersionID
		s.ModpackName = in.Modpack.Name
		s.ModpackURL = in.Modpack.MrpackURL
	}
	if err := m.store.Put(s); err != nil {
		return store.Server{}, err
	}

	m.setProvisioning(s.ID, StatusProvisioning)
	m.broadcast(s.ID, StatusProvisioning)
	go m.provision(s)

	return s, nil
}

// Start launches a server process.
func (m *Manager) Start(id string) error {
	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return errors.New("the daemon is shutting down")
	}
	if m.deleting[id] {
		m.mu.Unlock()
		return errors.New("server is being deleted")
	}
	m.cancelRestartLocked(id)
	if _, ok := m.running[id]; ok {
		m.mu.Unlock()
		return errors.New("server is already running")
	}
	if m.provisioning[id] == StatusProvisioning {
		m.mu.Unlock()
		return errors.New("server is still being provisioned")
	}
	m.mu.Unlock()

	s, err := m.store.Get(id)
	if err != nil {
		return err
	}

	jar := filepath.Join(s.Dir, "server.jar")
	if _, err := os.Stat(jar); err != nil {
		return fmt.Errorf("server.jar not found in %s", s.Dir)
	}

	javaPath, err := m.java.Ensure(s.MinecraftVersion, func(line string) {
		m.hub.PushLog(id, line, "INFO")
	})
	if err != nil {
		return err
	}

	return m.launch(id, s, buildLaunchCmd(s, javaPath))
}

// launch starts cmd as the process of server id and tracks it until it exits.
func (m *Manager) launch(id string, s store.Server, cmd *exec.Cmd) error {
	isolate(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	rs := &runningServer{cmd: cmd, stdin: stdin, status: StatusRunning, exited: make(chan struct{})}
	m.mu.Lock()
	if m.shuttingDown || m.deleting[id] || m.running[id] != nil {
		// Lost a race with a shutdown, a delete or another start of this server.
		shuttingDown, deleting := m.shuttingDown, m.deleting[id]
		m.mu.Unlock()
		killTree(cmd)
		_ = cmd.Wait()
		switch {
		case shuttingDown:
			return errors.New("the daemon is shutting down")
		case deleting:
			return errors.New("server is being deleted")
		}
		return errors.New("server is already running")
	}
	m.running[id] = rs
	m.mu.Unlock()

	go m.stream(id, stdout, false)
	go m.stream(id, stderr, true)
	m.broadcast(id, StatusRunning)
	go m.waitExit(id, rs, s)

	return nil
}

// Stop asks a server to shut down and returns once its process is gone. The
// server gets the stop grace period to save and exit on its own; only then is
// it killed, together with everything it started.
func (m *Manager) Stop(id string) error {
	rs, first, err := m.beginStop(id)
	if err != nil {
		return err
	}
	if !first {
		// Another caller is driving the stop: share its outcome.
		select {
		case <-rs.exited:
			return nil
		case <-time.After(m.stopGrace + 2*killWait):
			return errors.New("server process could not be killed")
		}
	}
	return m.finishStop(id, rs)
}

// RequestStop starts stopping a server and returns at once: the server is
// "stopping" when it returns and becomes "stopped" when its process is gone.
// A shutdown can take minutes, far longer than an API call should block.
func (m *Manager) RequestStop(id string) error {
	rs, first, err := m.beginStop(id)
	if err != nil {
		return err
	}
	if first {
		go func() {
			if err := m.finishStop(id, rs); err != nil {
				m.hub.PushLog(id, "Stop failed: "+err.Error(), "ERROR")
			}
		}()
	}
	return nil
}

// beginStop marks the server as stopping and sends it the stop command. first
// is false when a stop was already in progress.
func (m *Manager) beginStop(id string) (rs *runningServer, first bool, err error) {
	m.mu.Lock()
	m.cancelRestartLocked(id)
	rs = m.running[id]
	if rs == nil {
		m.mu.Unlock()
		return nil, false, errors.New("server is not running")
	}
	first = !rs.stopping
	rs.stopping = true
	rs.status = StatusStopping
	m.mu.Unlock()

	if first {
		m.broadcast(id, StatusStopping)
		_, _ = io.WriteString(rs.stdin, "stop\n")
	}
	return rs, first, nil
}

// finishStop waits for a stopping server to exit and kills it when the grace
// period runs out.
func (m *Manager) finishStop(id string, rs *runningServer) error {
	grace := time.NewTimer(m.stopGrace)
	defer grace.Stop()
	select {
	case <-rs.exited:
	case <-grace.C:
		m.hub.PushLog(id, fmt.Sprintf("Server did not stop within %s — killing the process. Recent changes may not have been saved.", m.stopGrace), "WARN")
		killTree(rs.cmd)
		select {
		case <-rs.exited:
		case <-time.After(killWait):
			return errors.New("server process could not be killed")
		}
	}
	return nil
}

// StopAll stops every running server and refuses to start any from then on.
// It is the daemon's shutdown path: no server is left running without the
// daemon that controls it, and none is cut off in the middle of a save.
func (m *Manager) StopAll() {
	m.mu.Lock()
	m.shuttingDown = true
	for id := range m.restartTimers {
		m.cancelRestartLocked(id)
	}
	ids := make([]string, 0, len(m.running))
	for id := range m.running {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_ = m.Stop(id)
		}(id)
	}
	wg.Wait()
}

// RunningCount reports how many server processes are alive.
func (m *Manager) RunningCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.running)
}

// cancelRestartLocked drops a pending crash auto-restart. m.mu must be held.
func (m *Manager) cancelRestartLocked(id string) {
	if t := m.restartTimers[id]; t != nil {
		t.Stop()
		delete(m.restartTimers, id)
	}
}

// Delete stops (if running) and removes a server and its files.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	m.deleting[id] = true
	running := m.running[id] != nil
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.deleting, id)
		m.mu.Unlock()
	}()
	if running {
		_ = m.Stop(id)
	}

	s, err := m.store.Get(id)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.cancelRestartLocked(id)
	delete(m.provisioning, id)
	delete(m.restarts, id)
	m.mu.Unlock()

	m.updateMu.Lock()
	err = m.store.Delete(id)
	m.updateMu.Unlock()
	if err != nil {
		return err
	}
	m.hub.ClearBuffer(id)
	if err := os.RemoveAll(s.Dir); err != nil {
		// Non-fatal: the record is already gone.
		m.hub.PushLog(id, "Warning: could not remove server directory: "+err.Error(), "WARN")
	}
	return nil
}

// Restart stops a server, waits until its process is gone and starts it again.
// A server that is not running is simply started. While a restart is in
// flight, further requests for the same server return at once.
func (m *Manager) Restart(id string) error {
	m.mu.Lock()
	if m.restarting[id] {
		m.mu.Unlock()
		return nil
	}
	m.restarting[id] = true
	running := m.running[id] != nil
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.restarting, id)
		m.mu.Unlock()
	}()

	if running {
		m.hub.PushLog(id, "Restarting server...", "INFO")
		if err := m.Stop(id); err != nil {
			// It may have exited on its own in the meantime; anything else is real.
			m.mu.Lock()
			still := m.running[id] != nil
			m.mu.Unlock()
			if still {
				return err
			}
		}
	}
	// The server may have been deleted, or the daemon may be shutting down,
	// meanwhile: Start then says so.
	return m.Start(id)
}

// RequestRestart starts a restart and returns at once; progress shows in the
// server's status and console.
func (m *Manager) RequestRestart(id string) error {
	if _, err := m.store.Get(id); err != nil {
		return err
	}
	m.mu.Lock()
	down := m.shuttingDown
	provisioning := m.provisioning[id] == StatusProvisioning
	m.mu.Unlock()
	if down {
		return errors.New("the daemon is shutting down")
	}
	if provisioning {
		return errors.New("server is still being provisioned")
	}
	go func() {
		if err := m.Restart(id); err != nil {
			m.hub.PushLog(id, "Restart failed: "+err.Error(), "ERROR")
		}
	}()
	return nil
}

// UpdateInput changes settings of an existing server. Nil fields are left alone.
type UpdateInput struct {
	// RestartSchedule is "HH:MM" (host time), or "" for no scheduled restart.
	RestartSchedule *string
}

// Update applies in to a server and returns the updated server.
func (m *Manager) Update(id string, in UpdateInput) (View, error) {
	// Read-modify-write under the lock, so a delete cannot slip in between
	// and have its record written back.
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	m.mu.Lock()
	deleting := m.deleting[id]
	m.mu.Unlock()
	if deleting {
		return View{}, store.ErrNotFound
	}
	s, err := m.store.Get(id)
	if err != nil {
		return View{}, err
	}
	if in.RestartSchedule != nil {
		v := *in.RestartSchedule
		if v != "" && !schedule.Valid(v) {
			return View{}, errors.New("restartSchedule must be HH:MM in 24-hour time, for example 04:30")
		}
		s.RestartSchedule = v
	}
	s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := m.store.Put(s); err != nil {
		return View{}, err
	}
	return m.view(s), nil
}

// schedulerInterval is how often scheduled restarts are checked.
const schedulerInterval = 15 * time.Second

// RunScheduler carries out scheduled restarts until stop is closed. Times are
// in the host's time zone.
func (m *Manager) RunScheduler(stop <-chan struct{}) {
	ticker := time.NewTicker(schedulerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-ticker.C:
			m.scheduleTick(now)
		}
	}
}

// scheduleTick warns about and carries out the scheduled restarts due at now.
func (m *Manager) scheduleTick(now time.Time) {
	m.mu.Lock()
	down := m.shuttingDown
	m.mu.Unlock()
	if down {
		return
	}

	seen := map[string]bool{}
	for _, s := range m.store.List() {
		if s.RestartSchedule == "" {
			continue
		}
		id := s.ID
		running := m.statusOf(id) == StatusRunning
		st, act, err := schedule.Tick(now, s.RestartSchedule, running, m.schedules[id])
		if err != nil {
			continue // not a schedule: stored by hand, ignore
		}
		seen[id] = true
		m.schedules[id] = st

		if act.Warn != 0 {
			msg := schedule.WarningMessage(act.Warn)
			m.hub.PushLog(id, msg+".", "INFO")
			_ = m.SendCommand(id, "say "+msg)
		}
		if act.Restart {
			m.hub.PushLog(id, fmt.Sprintf("Scheduled restart (%s) — restarting now.", s.RestartSchedule), "INFO")
			_ = m.SendCommand(id, "say Server is restarting now")
			go func() {
				if err := m.Restart(id); err != nil {
					m.hub.PushLog(id, "Scheduled restart failed: "+err.Error(), "ERROR")
				}
			}()
		}
	}
	// Forget servers that were deleted or had their schedule removed.
	for id := range m.schedules {
		if !seen[id] {
			delete(m.schedules, id)
		}
	}
}

// SendCommand writes a line to a running server's stdin.
func (m *Manager) SendCommand(id, command string) error {
	m.mu.Lock()
	rs := m.running[id]
	m.mu.Unlock()
	if rs == nil {
		return errors.New("server is not running")
	}
	_, err := io.WriteString(rs.stdin, command+"\n")
	return err
}

// ─── internals ─────────────────────────────────────────────

func (m *Manager) stream(id string, r io.Reader, isErr bool) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		level := extractLevel(line)
		if isErr && level == "" {
			level = "ERROR"
		}
		m.hub.PushLog(id, line, level)
	}
}

func (m *Manager) waitExit(id string, rs *runningServer, s store.Server) {
	err := rs.cmd.Wait()

	m.mu.Lock()
	wasStopping := rs.stopping || m.shuttingDown
	if m.running[id] == rs {
		delete(m.running, id)
	}
	m.mu.Unlock()
	// Tell Stop last, after the final status went out: once Stop returns, the
	// server can be started again and its events must not trail behind.
	defer close(rs.exited)

	crashed := err != nil && !wasStopping
	if crashed {
		m.hub.PushLog(id, "Server process exited unexpectedly: "+err.Error(), "ERROR")
		m.broadcast(id, StatusCrashed)
		if s.AutoStart {
			m.scheduleRestart(id, s.Name)
		}
	} else {
		m.hub.PushLog(id, "Server stopped.", "INFO")
		m.broadcast(id, StatusStopped)
		m.mu.Lock()
		delete(m.restarts, id)
		m.mu.Unlock()
	}
}

func (m *Manager) scheduleRestart(id, name string) {
	now := time.Now()
	m.mu.Lock()
	recent := m.restarts[id][:0:0]
	for _, t := range m.restarts[id] {
		if now.Sub(t) < restartWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) >= maxRestarts {
		m.restarts[id] = nil
		m.mu.Unlock()
		m.hub.PushLog(id, fmt.Sprintf("Auto-restart aborted: %q crashed %d times within a minute.", name, maxRestarts), "ERROR")
		return
	}
	recent = append(recent, now)
	m.restarts[id] = recent
	if m.shuttingDown {
		m.mu.Unlock()
		return
	}
	m.cancelRestartLocked(id)
	var timer *time.Timer
	timer = time.AfterFunc(restartCooldown, func() {
		m.mu.Lock()
		// A stop, delete or shutdown since then replaced or removed this timer.
		current := m.restartTimers[id] == timer
		if current {
			delete(m.restartTimers, id)
		}
		_, running := m.running[id]
		m.mu.Unlock()
		if !current || running {
			return
		}
		if err := m.Start(id); err != nil {
			m.hub.PushLog(id, "Auto-restart failed: "+err.Error(), "ERROR")
		}
	})
	m.restartTimers[id] = timer
	m.mu.Unlock()

	m.hub.PushLog(id, fmt.Sprintf("Server crashed — auto-restarting in %ds...", int(restartCooldown.Seconds())), "WARN")
}

func (m *Manager) setProvisioning(id string, status Status) {
	m.mu.Lock()
	m.provisioning[id] = status
	m.mu.Unlock()
}

func (m *Manager) clearProvisioning(id string) {
	m.mu.Lock()
	delete(m.provisioning, id)
	m.mu.Unlock()
}

func (m *Manager) broadcast(id string, status Status) {
	m.hub.BroadcastEvent(console.Event{Type: "status", ServerID: id, Status: string(status)})
}

var levelRe = regexp.MustCompile(`(?i)INFO|WARN|ERROR|DEBUG|FATAL|SEVERE`)

func extractLevel(line string) string {
	m := levelRe.FindString(line)
	switch strings.ToUpper(m) {
	case "":
		return ""
	case "SEVERE", "FATAL":
		return "ERROR"
	default:
		return strings.ToUpper(m)
	}
}

func orInt(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func orStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// engineVersionPattern is what a loader version or build number may look like.
var engineVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$`)

// buildLaunchCmd constructs the process launch command for a server, using the
// right entrypoint for its loader and putting the resolved Java on PATH (so a
// Forge/NeoForge run.sh finds it).
func buildLaunchCmd(s store.Server, javaPath string) *exec.Cmd {
	dir := s.Dir
	ram := jvm.Args(s.MinRAM, s.MaxRAM, s.JVMProfile)
	var cmd *exec.Cmd

	switch loader.Type(s.ModLoader) {
	case loader.Forge, loader.NeoForge:
		_ = os.WriteFile(filepath.Join(dir, "user_jvm_args.txt"),
			[]byte(strings.Join(ram, "\n")+"\n"), 0o640)
		if fileExists(filepath.Join(dir, "run.sh")) {
			cmd = exec.Command("sh", "run.sh", "nogui")
		} else {
			cmd = exec.Command(javaPath, append(ram, "-jar", "server.jar", "nogui")...)
		}
	case loader.Fabric:
		cmd = exec.Command(javaPath, append(ram, "-jar", launchJar(dir, "fabric-server-launch.jar"), "nogui")...)
	case loader.Quilt:
		cmd = exec.Command(javaPath, append(ram, "-jar", launchJar(dir, "quilt-server-launch.jar"), "nogui")...)
	default:
		cmd = exec.Command(javaPath, append(ram, "-jar", "server.jar", "nogui")...)
	}

	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+filepath.Dir(javaPath)+string(os.PathListSeparator)+os.Getenv("PATH"))
	return cmd
}

func launchJar(dir, preferred string) string {
	if fileExists(filepath.Join(dir, preferred)) {
		return preferred
	}
	return "server.jar"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
