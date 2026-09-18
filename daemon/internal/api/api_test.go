package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/console"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

const testToken = "test-token"

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Config{
		ServersRoot: filepath.Join(dir, "servers"),
		StorePath:   filepath.Join(dir, "servers.json"),
		JavaPath:    "java",
	}
	if err := os.MkdirAll(cfg.ServersRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(cfg.StorePath)
	if err != nil {
		t.Fatal(err)
	}
	mgr := server.NewManager(cfg, st, console.New())
	return httptest.NewServer(New(cfg, mgr, testToken, "fpr").Handler())
}

func get(t *testing.T, url, token string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(body)
}

func TestHealthNeedsNoAuth(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := get(t, ts.URL+"/v1/health", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", resp.StatusCode)
	}
	if !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("unexpected health body: %s", body)
	}
}

func TestProtectedRouteRequiresToken(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	if resp, _ := get(t, ts.URL+"/v1/servers", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-token status = %d, want 401", resp.StatusCode)
	}
	if resp, _ := get(t, ts.URL+"/v1/servers", "wrong"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad-token status = %d, want 401", resp.StatusCode)
	}
}

func TestListWithToken(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := get(t, ts.URL+"/v1/servers", testToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", resp.StatusCode)
	}
	var servers []any
	if err := json.Unmarshal([]byte(body), &servers); err != nil {
		t.Fatalf("list body not a JSON array: %s", body)
	}
	if len(servers) != 0 {
		t.Fatalf("expected empty list, got %d", len(servers))
	}
}

func TestInfoReportsAgentVersion(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := get(t, ts.URL+"/v1/info", testToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("info status = %d", resp.StatusCode)
	}
	if !strings.Contains(body, AgentVersion) {
		t.Fatalf("info missing agent version: %s", body)
	}
}

func TestCreateRejectsLoaderWithoutVersion(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/servers",
		strings.NewReader(`{"name":"x","minecraftVersion":"1.20.1","modLoader":"fabric"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("loader-without-version status = %d, want 400", resp.StatusCode)
	}
}

func TestCreateRejectsUnknownLoader(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/servers",
		strings.NewReader(`{"name":"y","minecraftVersion":"1.20.1","modLoader":"bogus","modLoaderVersion":"1"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown-loader status = %d, want 400", resp.StatusCode)
	}
}
