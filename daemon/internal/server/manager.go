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
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/modpack"
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
	// Operation is the backup, the restore or the installation of a plugin in
	// flight, if any.
	Operation *OperationState `json:"operation,omitempty"`
	// LastOperation is how the last of those ended, if one ran since the
	// daemon started.
	LastOperation *OperationResult `json:"lastOperation,omitempty"`
}

type runningServer struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	status   Status
	stopping bool
	exited   chan struct{}
	// metrics is what is known about this run (see metrics.go).
	metrics *metricsState
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
	// deletes counts the deletions still finishing in the background.
	deletes sync.WaitGroup
	// restarting marks servers with a restart in flight; a second request
	// joins the first instead of stopping the server again.
	restarting map[string]bool
	// schedules, backupSchedules and deferredRestarts are the scheduler's
	// memory. Only the scheduler goroutine uses them.
	schedules       map[string]*schedule.State
	backupSchedules map[string]*schedule.BackupState
	// deferredRestarts holds the scheduled restarts that are waiting for a
	// backup in progress.
	deferredRestarts map[string]deferredRestart
	// backupRetries holds, per server, the scheduled backup that turned out
	// not to be possible yet and is to be tried again.
	backupRetries map[string]time.Time
	// shuttingDown is set by StopAll: nothing is started or restarted after it.
	shuttingDown bool

	// starting counts the starts of each server that are between their checks
	// and the launch of the process: a backup or restore must not slip in there.
	starting map[string]int
	// ops holds the backup or restore in flight of each server. A server with
	// one is not started; stopping or deleting it cancels the operation.
	ops map[string]*operation
	// opsWG counts the operations in flight, for the shutdown to wait on.
	opsWG sync.WaitGroup
	// lastOps is how the last operation of each server ended.
	lastOps map[string]*OperationResult
	// watchers are told every line a server writes to its output.
	watchers map[string][]*lineWatcher

	saveOffTimeout time.Duration
	saveAllTimeout time.Duration
}

// NewManager constructs a Manager.
func NewManager(cfg config.Config, st *store.Store, hub *console.Hub) *Manager {
	if cfg.StopGrace <= 0 {
		cfg.StopGrace = config.DefaultStopGrace
	}
	if cfg.BackupsRoot == "" {
		// A server folder never has a dot in its name, so this cannot be one.
		cfg.BackupsRoot = filepath.Join(cfg.ServersRoot, ".backups")
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

		backupSchedules:  map[string]*schedule.BackupState{},
		deferredRestarts: map[string]deferredRestart{},
		backupRetries:    map[string]time.Time{},

		starting:       map[string]int{},
		ops:            map[string]*operation{},
		lastOps:        map[string]*OperationResult{},
		watchers:       map[string][]*lineWatcher{},
		saveOffTimeout: defaultSaveOffTimeout,
		saveAllTimeout: defaultSaveAllTimeout,
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
	if op := m.ops[s.ID]; op != nil {
		state := op.state
		v.Operation = &state
	}
	if last := m.lastOps[s.ID]; last != nil {
		result := *last
		v.LastOperation = &result
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
	// The .mrpack URL is downloaded as given, so it must be a Modrinth one.
	if in.Modpack != nil && in.Modpack.MrpackURL != "" && !modpack.ValidMrpackURL(in.Modpack.MrpackURL) {
		return store.Server{}, fmt.Errorf("modpack.mrpackUrl must be an https URL on %s", modpack.MrpackHost)
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
	for {
		if m.shuttingDown {
			m.mu.Unlock()
			return errors.New("the daemon is shutting down")
		}
		if m.deleting[id] {
			m.mu.Unlock()
			return errors.New("server is being deleted")
		}
		op := m.ops[id]
		if op == nil || op.state.Kind == kindInstall {
			break
		}
		if op.committed || op.ctx.Err() == nil {
			kind := op.state.Kind
			m.mu.Unlock()
			return conflictError(fmt.Sprintf("A %s of this server is in progress; start it once that is done", kind))
		}
		// Cancelled (by the stop of a restart, say) and on its way out.
		m.mu.Unlock()
		<-op.done
		m.mu.Lock()
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
	m.starting[id]++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.starting[id]--; m.starting[id] <= 0 {
			delete(m.starting, id)
		}
		m.mu.Unlock()
	}()

	s, err := m.store.Get(id)
	if err != nil {
		return err
	}

	if aside := asideDir(s); fileExists(aside) {
		return conflictError(fmt.Sprintf("A restore left the previous files of this server in %s. Delete that folder before starting the server.", aside))
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

	rs := &runningServer{cmd: cmd, stdin: stdin, status: StatusRunning, exited: make(chan struct{}), metrics: newMetricsState(s)}
	m.mu.Lock()
	busyOp := m.ops[id] != nil && m.ops[id].state.Kind != kindInstall
	if m.shuttingDown || m.deleting[id] || m.running[id] != nil || busyOp {
		// Lost a race with a shutdown, a delete, another start of this server,
		// or a backup or restore of it.
		shuttingDown, deleting, busy := m.shuttingDown, m.deleting[id], busyOp
		m.mu.Unlock()
		killTree(cmd)
		_ = cmd.Wait()
		switch {
		case shuttingDown:
			return errors.New("the daemon is shutting down")
		case deleting:
			return errors.New("server is being deleted")
		case busy:
			return conflictError("A backup or a restore of this server is in progress; start it once that is done")
		}
		return errors.New("server is already running")
	}
	m.running[id] = rs
	m.mu.Unlock()

	go m.stream(id, rs, stdout, false)
	go m.stream(id, rs, stderr, true)
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
	return m.awaitStop(id, rs, first)
}

// awaitStop waits until a server that beginStop marked as stopping is gone.
func (m *Manager) awaitStop(id string, rs *runningServer, first bool) error {
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
	// A backup of a server that is going down would catch it writing its
	// world; the stop wins and the backup is dropped.
	resumeSaving := false
	if op := m.cancelBackupLocked(id, "the server is stopping"); op != nil {
		resumeSaving = op.savePaused
	}
	m.mu.Unlock()

	if first {
		m.broadcast(id, StatusStopping)
		if resumeSaving {
			_, _ = io.WriteString(rs.stdin, "save-on\n")
		}
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
	for id := range m.ops {
		m.cancelOpLocked(id, "the daemon is shutting down")
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
	// Cancelled backups clean up after themselves, and a restore that was
	// already replacing files finishes: neither is cut off halfway.
	m.opsWG.Wait()
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

// RequestDelete removes a server and its files. A server that is not running
// is gone when it returns. A running one is told to stop and pending is true:
// it is "stopping" now and disappears once its process has exited, which can
// take minutes, far longer than an API call should block. Asking again while
// that is under way changes nothing.
func (m *Manager) RequestDelete(id string) (pending bool, err error) {
	if _, err := m.store.Get(id); err != nil {
		return false, err
	}

	m.mu.Lock()
	if m.deleting[id] {
		m.mu.Unlock()
		return true, nil
	}
	m.deleting[id] = true
	running := m.running[id] != nil
	if running {
		m.deletes.Add(1)
	}
	// A backup or a restore of it is dropped, unless the restore is already
	// replacing files: that one is waited for.
	op := m.cancelOpLocked(id, "the server is being deleted")
	m.mu.Unlock()
	waitOp := func() {
		if op != nil {
			<-op.done
		}
	}

	if !running {
		waitOp()
		return false, m.remove(id)
	}

	rs, first, err := m.beginStop(id)
	if err != nil {
		// It exited on its own in the meantime.
		defer m.deletes.Done()
		waitOp()
		return false, m.remove(id)
	}
	go func() {
		defer m.deletes.Done()
		waitOp()
		if err := m.awaitStop(id, rs, first); err != nil {
			// Its files are still in use: keep the server so it can be dealt with.
			m.mu.Lock()
			delete(m.deleting, id)
			m.mu.Unlock()
			m.hub.PushLog(id, "Delete failed: "+err.Error(), "ERROR")
			return
		}
		if err := m.remove(id); err != nil {
			m.hub.PushLog(id, "Delete failed: "+err.Error(), "ERROR")
		}
	}()
	return true, nil
}

// WaitDeletes blocks until the deletions running in the background are done.
// The daemon calls it on shutdown, after StopAll, so none is cut off halfway.
func (m *Manager) WaitDeletes() { m.deletes.Wait() }

// remove deletes the record and the files of a server whose process is gone,
// and lifts its "deleting" mark whatever the outcome.
func (m *Manager) remove(id string) error {
	defer func() {
		m.mu.Lock()
		delete(m.deleting, id)
		m.mu.Unlock()
	}()

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
	m.mu.Lock()
	delete(m.lastOps, id)
	delete(m.backupRetries, id)
	m.mu.Unlock()
	if err := os.RemoveAll(s.Dir); err != nil {
		// Non-fatal: the record is already gone.
		m.hub.PushLog(id, "Warning: could not remove server directory: "+err.Error(), "WARN")
	}
	// What a restore may have left next to it, and its backups: they are of
	// no use without the server, and the app has no other way to reach them.
	_ = os.RemoveAll(stageDir(s))
	_ = os.RemoveAll(asideDir(s))
	if safeID.MatchString(id) {
		if err := os.RemoveAll(m.backupDir(id)); err != nil {
			m.hub.PushLog(id, "Warning: could not remove the server's backups: "+err.Error(), "WARN")
		}
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
	// BackupSchedule is "HH:MM" (host time), or "" for no scheduled backups.
	BackupSchedule *string
	// BackupKeep is how many scheduled backups to keep (1 to 365).
	BackupKeep *int
}

// Update applies in to a server and returns the updated server.
func (m *Manager) Update(id string, in UpdateInput) (View, error) {
	// Everything is checked before anything is changed.
	if v := in.RestartSchedule; v != nil && *v != "" && !schedule.Valid(*v) {
		return View{}, errors.New("restartSchedule must be HH:MM in 24-hour time, for example 04:30")
	}
	if v := in.BackupSchedule; v != nil && *v != "" && !schedule.Valid(*v) {
		return View{}, errors.New("backupSchedule must be HH:MM in 24-hour time, for example 03:30")
	}
	if v := in.BackupKeep; v != nil && !schedule.ValidKeep(*v) {
		return View{}, fmt.Errorf("backupKeep must be a whole number from %d to %d", schedule.KeepMin, schedule.KeepMax)
	}
	s, err := m.mutate(id, func(s *store.Server) {
		if in.RestartSchedule != nil {
			s.RestartSchedule = *in.RestartSchedule
		}
		if in.BackupSchedule != nil {
			s.BackupSchedule = *in.BackupSchedule
		}
		if in.BackupKeep != nil {
			s.BackupKeep = *in.BackupKeep
		}
		s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	})
	if err != nil {
		return View{}, err
	}
	return m.view(s), nil
}

// mutate changes the stored record of a server: read, change, write, under
// the lock, so a delete cannot slip in between and have its record written
// back. Nothing else may write a record it read earlier.
func (m *Manager) mutate(id string, change func(s *store.Server)) (store.Server, error) {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	m.mu.Lock()
	deleting := m.deleting[id]
	m.mu.Unlock()
	if deleting {
		return store.Server{}, store.ErrNotFound
	}
	s, err := m.store.Get(id)
	if err != nil {
		return store.Server{}, err
	}
	change(&s)
	if err := m.store.Put(s); err != nil {
		return store.Server{}, err
	}
	return s, nil
}

// schedulerInterval is how often schedules are checked.
const schedulerInterval = 15 * time.Second

// deferredRestart is a scheduled restart that is waiting for a backup.
type deferredRestart struct {
	// schedule is the restart schedule it came from; a changed one drops it.
	schedule string
	// deadline is when it stops waiting.
	deadline time.Time
}

// RunScheduler carries out scheduled restarts and backups until stop is
// closed. Times are in the host's time zone.
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

// scheduleTick starts the scheduled backups, and warns about and carries out
// the scheduled restarts, that are due at now.
func (m *Manager) scheduleTick(now time.Time) {
	m.mu.Lock()
	down := m.shuttingDown
	m.mu.Unlock()
	if down {
		return
	}

	seen := map[string]bool{}
	seenBackup := map[string]bool{}
	restartSchedules := map[string]string{}
	for _, s := range m.store.List() {
		id := s.ID
		// Backups first: a restart that is due in the same tick then finds the
		// backup and waits for it.
		if s.BackupSchedule != "" && m.backupTick(now, s) {
			seenBackup[id] = true
		}
		if s.RestartSchedule == "" {
			continue
		}
		restartSchedules[id] = s.RestartSchedule
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
			if m.backupInFlight(id) {
				// Restarting would throw the backup away; give it time first.
				m.deferredRestarts[id] = deferredRestart{schedule: s.RestartSchedule, deadline: now.Add(schedule.RestartWaitForBackup)}
				m.hub.PushLog(id, fmt.Sprintf("Scheduled restart (%s) is waiting for the backup in progress (%d minutes at most).",
					s.RestartSchedule, int(schedule.RestartWaitForBackup/time.Minute)), "INFO")
			} else {
				m.scheduledRestart(id, s.RestartSchedule)
			}
		}
	}

	// Restarts that were put off for a backup.
	for id, d := range m.deferredRestarts {
		if restartSchedules[id] != d.schedule {
			delete(m.deferredRestarts, id) // deleted, or its schedule changed
			continue
		}
		running := m.statusOf(id) == StatusRunning
		switch schedule.DeferredRestartAction(now, d.deadline, running, m.backupInFlight(id)) {
		case schedule.DeferredWait:
		case schedule.DeferredRestart:
			delete(m.deferredRestarts, id)
			m.scheduledRestart(id, d.schedule)
		default:
			delete(m.deferredRestarts, id)
		}
	}

	// Forget servers that were deleted or had their schedule removed.
	for id := range m.schedules {
		if !seen[id] {
			delete(m.schedules, id)
		}
	}
	for id := range m.backupSchedules {
		if !seenBackup[id] {
			delete(m.backupSchedules, id)
		}
	}
}

// scheduledRestart restarts a running server because its schedule says so.
func (m *Manager) scheduledRestart(id, restartSchedule string) {
	m.hub.PushLog(id, fmt.Sprintf("Scheduled restart (%s) — restarting now.", restartSchedule), "INFO")
	_ = m.SendCommand(id, "say Server is restarting now")
	go func() {
		if err := m.Restart(id); err != nil {
			m.hub.PushLog(id, "Scheduled restart failed: "+err.Error(), "ERROR")
		}
	}()
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

func (m *Manager) stream(id string, rs *runningServer, r io.Reader, isErr bool) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		level := extractLevel(line)
		if isErr && level == "" {
			level = "ERROR"
		}
		// The answer to a question the daemon asked by itself (see metrics.go)
		// is not console output anybody asked to see. The watchers are told
		// about every line all the same.
		if isErr || !m.observeLine(rs, line) {
			m.hub.PushLog(id, line, level)
		}
		if !isErr {
			m.notifyWatchers(id, line)
		}
	}
}

func (m *Manager) waitExit(id string, rs *runningServer, s store.Server) {
	err := rs.cmd.Wait()

	m.mu.Lock()
	wasStopping := rs.stopping || m.shuttingDown
	if m.running[id] == rs {
		delete(m.running, id)
	}
	// A backup that was reading the files of this process cannot vouch for
	// them any more: the server writes its world on the way out.
	m.cancelBackupLocked(id, "the server stopped")
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
		_, running := m.running[id]
		if current && running {
			delete(m.restartTimers, id)
		}
		m.mu.Unlock()
		if !current || running {
			return
		}
		// The entry stays until Start takes it away under the same lock
		// that marks the server as starting: a backup must not find a gap
		// in which the server looks idle.
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
