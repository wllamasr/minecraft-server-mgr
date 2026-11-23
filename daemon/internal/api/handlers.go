package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/loader"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/software"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "agent": AgentVersion})
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(s.token)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid pairing token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"apiToken":    s.token,
		"fingerprint": s.fpr,
		"info":        s.info(),
	})
}

func (s *Server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.info())
}

func (s *Server) info() map[string]any {
	host, _ := os.Hostname()
	now := time.Now()
	return map[string]any{
		// Scheduled restarts use the host's clock: let clients show which one.
		"time":         now.Format(time.RFC3339),
		"timeZone":     now.Format("MST"),
		"agentVersion": AgentVersion,
		"apiVersions":  []string{"v1"},
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"hostname":     host,
		"javaOverride": s.cfg.JavaPath,
		"java":         s.mgr.JavaInstallations(),
		"serversRoot":  s.cfg.ServersRoot,
	}
}

func (s *Server) handleLoaderVersions(w http.ResponseWriter, r *http.Request) {
	l := r.PathValue("loader")
	// Plugin platforms answer with their build numbers for the Minecraft version.
	if software.Valid(l) {
		mc := r.URL.Query().Get("mc")
		if !software.IsReleaseVersion(mc) {
			writeError(w, http.StatusBadRequest, "mc must be a Minecraft release version")
			return
		}
		builds, err := software.Builds(software.Platform(l), mc)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if builds == nil {
			builds = []software.Build{}
		}
		writeJSON(w, http.StatusOK, builds)
		return
	}
	if !loader.Valid(l) {
		writeError(w, http.StatusBadRequest, "unknown mod loader")
		return
	}
	versions, err := loader.Versions(loader.Type(l), r.URL.Query().Get("mc"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

// handleSoftwareVersions lists the Minecraft versions a plugin platform
// (paper, purpur, folia) publishes builds for, newest first.
func (s *Server) handleSoftwareVersions(w http.ResponseWriter, r *http.Request) {
	p := r.PathValue("platform")
	if !software.Valid(p) {
		writeError(w, http.StatusBadRequest, "unknown server software")
		return
	}
	versions, err := software.Versions(software.Platform(p))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if versions == nil {
		versions = []string{}
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *Server) handleList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.List())
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in server.CreateInput
	if err := readJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	sv, err := s.mgr.Create(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, sv)
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	v, err := s.mgr.Get(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	pending, err := s.mgr.RequestDelete(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if pending {
		// It is running: it stops first and is removed once its process is gone.
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.Start(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.RequestStop(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.RequestRestart(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

// handleUpdate changes settings of an existing server. Only the fields present
// in the body change; unknown fields are rejected rather than silently dropped.
func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var in server.UpdateInput
	for field, raw := range body {
		switch field {
		case "restartSchedule":
			// null clears the schedule, like an empty string.
			var v *string
			if err := json.Unmarshal(raw, &v); err != nil {
				writeError(w, http.StatusBadRequest, "restartSchedule must be a string or null")
				return
			}
			if v == nil {
				v = new(string)
			}
			in.RestartSchedule = v
		default:
			writeError(w, http.StatusBadRequest, "unknown or read-only field: "+field)
			return
		}
	}
	view, err := s.mgr.Update(r.PathValue("id"), in)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Command string `json:"command"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.mgr.SendCommand(r.PathValue("id"), body.Command); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.Hub().Buffer(r.PathValue("id")))
}

// handleConsole streams a server's log history followed by live lines (SSE).
func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	id := r.PathValue("id")
	ch, cancel := s.mgr.Hub().SubscribeLogs(id)
	defer cancel()

	sseHeaders(w)
	flusher.Flush()

	for _, entry := range s.mgr.Hub().Buffer(id) {
		sseSend(w, entry)
	}
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case entry, ok := <-ch:
			if !ok {
				return
			}
			sseSend(w, entry)
			flusher.Flush()
		}
	}
}

// handleEvents streams host-wide events (status changes) via SSE.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	ch, cancel := s.mgr.Hub().SubscribeEvents()
	defer cancel()

	sseHeaders(w)
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			sseSend(w, e)
			flusher.Flush()
		}
	}
}

func sseHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
}

func sseSend(w http.ResponseWriter, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "data: %s\n\n", b)
}

// handleListBackups lists the backups of a server, newest first.
func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request) {
	list, err := s.mgr.ListBackups(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleCreateBackup starts a backup and answers at once: it can take minutes.
// The server's "operation" shows the progress, and its "lastOperation" (with
// the same id) the outcome.
func (s *Server) handleCreateBackup(w http.ResponseWriter, r *http.Request) {
	opID, err := s.mgr.RequestBackup(r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "operationId": opID})
}

func (s *Server) handleDeleteBackup(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.DeleteBackup(r.PathValue("id"), r.PathValue("backupId")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRestoreBackup starts replacing a stopped server's files with a backup
// and answers at once. The current files are backed up first unless the body
// says {"backupFirst": false}.
func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	body := struct {
		BackupFirst *bool `json:"backupFirst"`
	}{}
	// The body is optional.
	if err := readJSON(r, &body); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	backupFirst := body.BackupFirst == nil || *body.BackupFirst
	opID, err := s.mgr.RequestRestore(r.PathValue("id"), r.PathValue("backupId"), backupFirst)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "operationId": opID})
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	if errors.Is(err, server.ErrBackupNotFound) {
		writeError(w, http.StatusNotFound, "backup not found")
		return
	}
	if server.IsConflict(err) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}
