package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/loader"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
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
	return map[string]any{
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
	if err := s.mgr.Delete(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
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
	if err := s.mgr.Stop(r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
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

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}
