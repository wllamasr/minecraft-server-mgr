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
	stopGrace       = 30 * time.Second
	maxRestarts     = 3
	restartWindow   = time.Minute
	restartCooldown = 5 * time.Second
)

// CreateInput describes a new server request.
type CreateInput struct {
	Name             string `json:"name"`
	MinecraftVersion string `json:"minecraftVersion"`
	ModLoader        string `json:"modLoader,omitempty"`
	Port             int    `json:"port,omitempty"`
	MinRAM           string `json:"minRam,omitempty"`
	MaxRAM           string `json:"maxRam,omitempty"`
	AutoStart        bool   `json:"autoStart,omitempty"`
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

	mu           sync.Mutex
	running      map[string]*runningServer
	provisioning map[string]Status
	restarts     map[string][]time.Time
}

// NewManager constructs a Manager.
func NewManager(cfg config.Config, st *store.Store, hub *console.Hub) *Manager {
	return &Manager{
		cfg:          cfg,
		store:        st,
		hub:          hub,
		running:      map[string]*runningServer{},
		provisioning: map[string]Status{},
		restarts:     map[string][]time.Time{},
	}
}

// Hub exposes the console/event hub for the API layer.
func (m *Manager) Hub() *console.Hub { return m.hub }

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
		return store.Server{}, errors.New("mod loaders are not supported by the daemon yet (vanilla only)")
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
		Port:             orInt(in.Port, 25565),
		MinRAM:           orStr(in.MinRAM, "1G"),
		MaxRAM:           orStr(in.MaxRAM, "2G"),
		AutoStart:        in.AutoStart,
		CreatedAt:        now,
		UpdatedAt:        now,
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

	args := []string{"-Xms" + s.MinRAM, "-Xmx" + s.MaxRAM, "-jar", "server.jar", "nogui"}
	cmd := exec.Command(m.cfg.JavaPath, args...)
	cmd.Dir = s.Dir

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
	m.running[id] = rs
	m.mu.Unlock()

	go m.stream(id, stdout, false)
	go m.stream(id, stderr, true)
	m.broadcast(id, StatusRunning)
	go m.waitExit(id, rs, s)

	return nil
}

// Stop asks a server to shut down gracefully, then force-kills after a grace period.
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	rs := m.running[id]
	if rs == nil {
		m.mu.Unlock()
		return errors.New("server is not running")
	}
	rs.stopping = true
	rs.status = StatusStopping
	m.mu.Unlock()

	m.broadcast(id, StatusStopping)
	_, _ = io.WriteString(rs.stdin, "stop\n")

	select {
	case <-rs.exited:
	case <-time.After(stopGrace):
		if rs.cmd.Process != nil {
			_ = rs.cmd.Process.Kill()
		}
		<-rs.exited
	}
	return nil
}

// Delete stops (if running) and removes a server and its files.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	running := m.running[id] != nil
	m.mu.Unlock()
	if running {
		_ = m.Stop(id)
	}

	s, err := m.store.Get(id)
	if err != nil {
		return err
	}

	m.mu.Lock()
	delete(m.provisioning, id)
	delete(m.restarts, id)
	m.mu.Unlock()

	if err := m.store.Delete(id); err != nil {
		return err
	}
	m.hub.ClearBuffer(id)
	if err := os.RemoveAll(s.Dir); err != nil {
		// Non-fatal: the record is already gone.
		m.hub.PushLog(id, "Warning: could not remove server directory: "+err.Error(), "WARN")
	}
	return nil
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
	close(rs.exited)

	m.mu.Lock()
	wasStopping := rs.stopping
	if m.running[id] == rs {
		delete(m.running, id)
	}
	m.mu.Unlock()

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
	m.mu.Unlock()

	m.hub.PushLog(id, fmt.Sprintf("Server crashed — auto-restarting in %ds...", int(restartCooldown.Seconds())), "WARN")
	time.AfterFunc(restartCooldown, func() {
		m.mu.Lock()
		_, running := m.running[id]
		m.mu.Unlock()
		if running {
			return
		}
		if err := m.Start(id); err != nil {
			m.hub.PushLog(id, "Auto-restart failed: "+err.Error(), "ERROR")
		}
	})
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
