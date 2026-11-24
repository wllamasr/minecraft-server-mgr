package server

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/addons"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/backup"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

// ErrAddonNotFound says that a server has no plugin with the given file name.
var ErrAddonNotFound = addons.ErrNotFound

const noAddonsMessage = "Plugins are managed for Paper, Purpur and Folia servers only"

// addonDir is the folder a server loads its plugins from.
func addonDir(s store.Server) (string, error) {
	dir, ok := addons.Dir(s.ModLoader)
	if !ok {
		return "", conflictError(noAddonsMessage)
	}
	return filepath.Join(s.Dir, dir), nil
}

// ListAddons returns the plugins of a server, by name.
func (m *Manager) ListAddons(id string) ([]addons.Info, error) {
	s, err := m.store.Get(id)
	if err != nil {
		return nil, err
	}
	dir, err := addonDir(s)
	if err != nil {
		return nil, err
	}
	return addons.List(dir)
}

// RequestAddonInstall starts installing a version of a Modrinth project as a
// plugin of a server, and returns at once with the id of the operation. The
// server may be running: the plugin is loaded the next time it starts.
//
// Only the version's id comes from the caller. What file that is, where it is
// downloaded from and what its checksum must be is asked of Modrinth.
func (m *Manager) RequestAddonInstall(id, versionID string) (string, error) {
	s, err := m.store.Get(id)
	if err != nil {
		return "", err
	}
	dir, err := addonDir(s)
	if err != nil {
		return "", err
	}
	if !addons.ValidVersionID(versionID) {
		return "", errors.New("invalid version id")
	}
	op, s, _, err := m.beginOperation(id, kindInstall)
	if err != nil {
		return "", err
	}
	go m.runOperation(op, s, func() (string, string, error) {
		file, err := m.runAddonInstall(op, s, dir, versionID)
		if err != nil {
			m.hub.PushLog(id, "Plugin not installed: "+err.Error(), "ERROR")
			return "", "", err
		}
		m.hub.PushLog(id, "Plugin "+file+" installed (checksum OK).", "INFO")
		// Told as things are when it ends: the server may have been started
		// or stopped while the file came down.
		m.mu.Lock()
		up := m.running[id] != nil || m.starting[id] > 0 || m.restarting[id]
		m.mu.Unlock()
		if up {
			return file, "The server loads it the next time it starts: restart the server to use it", nil
		}
		return file, "", nil
	})
	return op.state.ID, nil
}

func (m *Manager) runAddonInstall(op *operation, s store.Server, dir, versionID string) (string, error) {
	ctx, cancel := context.WithTimeout(op.ctx, addons.InstallTimeout())
	defer cancel()
	// Why it ended early, in words for whoever asked.
	explain := func(err error) error {
		if cause := context.Cause(op.ctx); cause != nil {
			return fmt.Errorf("%w: %s", backup.ErrCancelled, cause.Error())
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errors.New("Modrinth took too long to answer; nothing was installed")
		}
		return err
	}

	v, err := addons.Resolve(ctx, versionID)
	if err != nil {
		return "", explain(err)
	}
	if !v.RunsOn(s.ModLoader) {
		return "", fmt.Errorf("This version is not built for %s servers; it was not installed", s.ModLoader)
	}
	m.hub.PushLog(s.ID, "Installing plugin "+v.FileName+" from Modrinth…", "INFO")
	if err := addons.Install(ctx, dir, v, m.progress(op)); err != nil {
		return "", explain(err)
	}
	return v.FileName, nil
}

// changeAddon runs a change to the plugin files of a stopped server. A jar
// the server has loaded is not taken from under it (Windows would not even
// allow it), and the folder is not touched while a backup, a restore or an
// installation works in it.
func (m *Manager) changeAddon(id, file string, change func(dir string) error) error {
	s, err := m.store.Get(id)
	if err != nil {
		return err
	}
	dir, err := addonDir(s)
	if err != nil {
		return err
	}
	if !addons.ValidFileName(file) {
		return ErrAddonNotFound
	}

	// The change is a rename or a delete of one file: short enough to make
	// under the lock, where nothing can start the server or a restore meanwhile.
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.store.Get(id); err != nil {
		return err
	}
	switch {
	case m.shuttingDown:
		return conflictError("the daemon is shutting down")
	case m.deleting[id]:
		return conflictError("server is being deleted")
	case m.provisioning[id] != "":
		return conflictError("The server is not set up")
	case m.ops[id] != nil && m.ops[id].state.Kind == kindInstall:
		return conflictError("A plugin is being installed on this server; try again once that is done")
	case m.ops[id] != nil:
		return conflictError("A backup or a restore of this server is in progress; try again once that is done")
	case m.running[id] != nil || m.starting[id] > 0 || m.restarting[id] || m.restartTimers[id] != nil:
		return conflictError("Stop the server before removing a plugin or turning one off or on")
	}
	return change(dir)
}

// SetAddonEnabled turns a plugin of a stopped server off or on.
func (m *Manager) SetAddonEnabled(id, file string, enabled bool) error {
	err := m.changeAddon(id, file, func(dir string) error { return addons.SetEnabled(dir, file, enabled) })
	if err == nil {
		state := "turned off"
		if enabled {
			state = "turned on"
		}
		m.hub.PushLog(id, "Plugin "+file+" "+state+".", "INFO")
	}
	return err
}

// RemoveAddon deletes the jar of a plugin of a stopped server. The plugin's
// own folder of settings and data stays.
func (m *Manager) RemoveAddon(id, file string) error {
	err := m.changeAddon(id, file, func(dir string) error { return addons.Remove(dir, file) })
	if err == nil {
		m.hub.PushLog(id, "Plugin "+file+" removed.", "INFO")
	}
	return err
}
