// Package store persists the daemon's server records to a JSON file.
//
// A JSON store keeps the MVP dependency-free (pure standard library). The
// design doc calls for SQLite; swapping this implementation for one backed by
// modernc.org/sqlite later is intentionally isolated behind these methods.
package store

import (
	"encoding/json"
	"errors"
	"os"
	"sync"
)

// ErrNotFound is returned when a server id is unknown.
var ErrNotFound = errors.New("server not found")

// Server is a persisted server record. Runtime status is computed elsewhere.
type Server struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Dir              string `json:"dir"`
	MinecraftVersion string `json:"minecraftVersion"`
	ModLoader        string `json:"modLoader,omitempty"`
	ModLoaderVersion string `json:"modLoaderVersion,omitempty"`
	Port             int    `json:"port"`
	MinRAM           string `json:"minRam"`
	MaxRAM           string `json:"maxRam"`
	// JVMProfile is "" / "default" (heap only) or "aikar" (tuned G1GC flags).
	JVMProfile string `json:"jvmProfile,omitempty"`
	// RestartSchedule is a daily restart time, "HH:MM" in the host's time zone;
	// empty means no scheduled restart.
	RestartSchedule string `json:"restartSchedule,omitempty"`
	// BackupSchedule is a daily backup time, "HH:MM" in the host's time zone;
	// empty means no scheduled backups.
	BackupSchedule string `json:"backupSchedule,omitempty"`
	// BackupKeep is how many scheduled backups are kept (1 to 365); 0 means
	// the default.
	BackupKeep int `json:"backupKeep,omitempty"`
	// BackupLastRun is how the last scheduled backup went.
	BackupLastRun *BackupRun `json:"backupLastRun,omitempty"`
	AutoStart     bool       `json:"autoStart"`
	CreatedAt     string     `json:"createdAt"`
	UpdatedAt     string     `json:"updatedAt"`
	// Modpack provenance (set when the server was deployed from a modpack).
	ModpackSource    string `json:"modpackSource,omitempty"`
	ModpackProjectID string `json:"modpackProjectId,omitempty"`
	ModpackVersionID string `json:"modpackVersionId,omitempty"`
	ModpackName      string `json:"modpackName,omitempty"`
	ModpackURL       string `json:"modpackUrl,omitempty"`
}

// BackupRun is how one scheduled backup went.
type BackupRun struct {
	// At is when this was recorded (RFC 3339, UTC).
	At string `json:"at"`
	// Outcome is "ok" (a backup was made), "skipped" (nothing had changed on a
	// stopped server), "missed" (it could not be started in time) or "failed"
	// (it started and did not finish).
	Outcome string `json:"outcome"`
	Message string `json:"message,omitempty"`
}

// Store is a small, mutex-guarded, JSON-file-backed collection of servers.
type Store struct {
	path string
	mu   sync.RWMutex
	data map[string]Server
	// writeMu serializes writes of the file: they all go through one
	// temporary file, and the last one to start must be the last to land.
	writeMu sync.Mutex
}

// Open loads the store from disk, creating an empty one if the file is absent.
func Open(path string) (*Store, error) {
	s := &Store{path: path, data: map[string]Server{}}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if len(b) == 0 {
		return s, nil
	}
	var list []Server
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, err
	}
	for _, sv := range list {
		s.data[sv.ID] = sv
	}
	return s, nil
}

// List returns all servers.
func (s *Store) List() []Server {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Server, 0, len(s.data))
	for _, sv := range s.data {
		out = append(out, sv)
	}
	return out
}

// Get returns one server by id.
func (s *Store) Get(id string) (Server, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sv, ok := s.data[id]
	if !ok {
		return Server{}, ErrNotFound
	}
	return sv, nil
}

// Put inserts or replaces a server and persists the store.
func (s *Store) Put(sv Server) error {
	s.mu.Lock()
	s.data[sv.ID] = sv
	s.mu.Unlock()
	return s.persist()
}

// Delete removes a server and persists the store.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	delete(s.data, id)
	s.mu.Unlock()
	return s.persist()
}

func (s *Store) persist() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.RLock()
	list := make([]Server, 0, len(s.data))
	for _, sv := range s.data {
		list = append(list, sv)
	}
	s.mu.RUnlock()

	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
