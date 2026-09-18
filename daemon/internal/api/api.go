// Package api exposes the daemon's HTTP + SSE interface over TLS.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
)

// AgentVersion is the daemon version reported by /v1/info.
const AgentVersion = "0.1.0"

// Server wires the manager and configuration to HTTP handlers.
type Server struct {
	cfg   config.Config
	mgr   *server.Manager
	token string
	fpr   string
}

// New builds the API server.
func New(cfg config.Config, mgr *server.Manager, token, fingerprint string) *Server {
	return &Server{cfg: cfg, mgr: mgr, token: token, fpr: fingerprint}
}

// Handler returns the fully-wired HTTP handler (with auth middleware).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/pair", s.handlePair)

	// Authenticated
	mux.HandleFunc("GET /v1/info", s.handleInfo)
	mux.HandleFunc("GET /v1/loaders/{loader}/versions", s.handleLoaderVersions)
	mux.HandleFunc("GET /v1/servers", s.handleList)
	mux.HandleFunc("POST /v1/servers", s.handleCreate)
	mux.HandleFunc("GET /v1/servers/{id}", s.handleGet)
	mux.HandleFunc("DELETE /v1/servers/{id}", s.handleDelete)
	mux.HandleFunc("POST /v1/servers/{id}/start", s.handleStart)
	mux.HandleFunc("POST /v1/servers/{id}/stop", s.handleStop)
	mux.HandleFunc("POST /v1/servers/{id}/command", s.handleCommand)
	mux.HandleFunc("GET /v1/servers/{id}/logs", s.handleLogs)
	mux.HandleFunc("GET /v1/servers/{id}/console", s.handleConsole)
	mux.HandleFunc("GET /v1/events", s.handleEvents)

	return s.auth(mux)
}

// auth requires a bearer token on every route except health and pairing.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/v1/health" || path == "/v1/pair" {
			next.ServeHTTP(w, r)
			return
		}
		if !s.validToken(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) validToken(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	got := strings.TrimSpace(h[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

// ─── response helpers ──────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}
