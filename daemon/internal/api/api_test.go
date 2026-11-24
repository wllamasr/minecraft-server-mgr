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
	"time"

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

func TestMetricsRoute(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	if resp, _ := get(t, ts.URL+"/v1/servers/nope/metrics", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("without a token: %d", resp.StatusCode)
	}
	// An unknown server is "server not found" in JSON: a client can tell it
	// from a daemon that has no such route (a plain-text 404).
	resp, body := get(t, ts.URL+"/v1/servers/nope/metrics", testToken)
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(body, `"error":"server not found"`) {
		t.Errorf("unknown server: %d %s", resp.StatusCode, body)
	}
}

func TestAddonRoutes(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	if resp, _ := get(t, ts.URL+"/v1/servers/nope/addons", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("without a token: %d", resp.StatusCode)
	}
	send := func(method, path, body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	// An unknown server is told apart from a daemon without these routes.
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/v1/servers/nope/addons", ""},
		{http.MethodPost, "/v1/servers/nope/addons", `{"versionId":"abc"}`},
		{http.MethodPatch, "/v1/servers/nope/addons/x.jar", `{"enabled":false}`},
		{http.MethodDelete, "/v1/servers/nope/addons/x.jar", ""},
	} {
		if status, body := send(c.method, c.path, c.body); status != http.StatusNotFound || !strings.Contains(body, `"error":"server not found"`) {
			t.Errorf("%s %s: %d %s", c.method, c.path, status, body)
		}
	}
	for _, body := range []string{``, `{}`, `{"enabled":"no"}`, `not json`} {
		if status, _ := send(http.MethodPatch, "/v1/servers/nope/addons/x.jar", body); status != http.StatusBadRequest {
			t.Errorf("PATCH with body %q: %d", body, status)
		}
	}
	if status, _ := send(http.MethodPost, "/v1/servers/nope/addons", `not json`); status != http.StatusBadRequest {
		t.Errorf("POST with a bad body: %d", status)
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

func do(t *testing.T, method, url, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(out)
}

func TestUpdateOfTheBackupSchedule(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{
		ServersRoot: filepath.Join(dir, "servers"),
		BackupsRoot: filepath.Join(dir, "backups"),
		StorePath:   filepath.Join(dir, "servers.json"),
		JavaPath:    "java",
	}
	st, err := store.Open(cfg.StorePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Put(store.Server{ID: "one", Name: "one", Dir: filepath.Join(cfg.ServersRoot, "one"), MinecraftVersion: "1.21.4"}); err != nil {
		t.Fatal(err)
	}
	mgr := server.NewManager(cfg, st, console.New())
	ts := httptest.NewServer(New(cfg, mgr, testToken, "fpr").Handler())
	defer ts.Close()
	url := ts.URL + "/v1/servers/one"

	for _, c := range []struct {
		body     string
		want     int
		contains string
	}{
		{`{"backupSchedule":"3:30"}`, 400, "backupSchedule must be HH:MM"},
		{`{"backupSchedule":330}`, 400, "backupSchedule must be a string or null"},
		{`{"backupKeep":0}`, 400, "backupKeep must be a whole number from 1 to 365"},
		{`{"backupKeep":366}`, 400, "backupKeep must be a whole number from 1 to 365"},
		{`{"backupKeep":2.5}`, 400, "backupKeep must be a whole number from 1 to 365"},
		{`{"backupKeep":"7"}`, 400, "backupKeep must be a whole number from 1 to 365"},
		{`{"backupKeep":null}`, 400, "backupKeep must be a whole number from 1 to 365"},
		// How the last one went is the daemon's to write.
		{`{"backupLastRun":{"at":"2026-01-01T00:00:00Z","outcome":"ok"}}`, 400, "unknown or read-only field"},
		// One wrong field refuses the whole update.
		{`{"backupSchedule":"03:30","backupKeep":0}`, 400, "backupKeep"},
	} {
		resp, body := do(t, "PATCH", url, c.body)
		if resp.StatusCode != c.want || !strings.Contains(body, c.contains) {
			t.Errorf("PATCH %s = %d %s, want %d with %q", c.body, resp.StatusCode, body, c.want, c.contains)
		}
	}
	if s, _ := st.Get("one"); s.BackupSchedule != "" || s.BackupKeep != 0 {
		t.Fatalf("a refused update changed the server: %+v", s)
	}

	resp, body := do(t, "PATCH", url, `{"backupSchedule":"03:30","backupKeep":14}`)
	if resp.StatusCode != 200 || !strings.Contains(body, `"backupSchedule":"03:30"`) || !strings.Contains(body, `"backupKeep":14`) {
		t.Fatalf("update = %d %s", resp.StatusCode, body)
	}
	resp, body = do(t, "PATCH", url, `{"backupSchedule":null}`)
	if resp.StatusCode != 200 || strings.Contains(body, "backupSchedule") || !strings.Contains(body, `"backupKeep":14`) {
		t.Fatalf("clearing = %d %s", resp.StatusCode, body)
	}
	if resp, body = do(t, "PATCH", ts.URL+"/v1/servers/nope", `{"backupKeep":3}`); resp.StatusCode != 404 {
		t.Fatalf("unknown server = %d %s", resp.StatusCode, body)
	}
}

func TestBackupRoutes(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{
		ServersRoot: filepath.Join(dir, "servers"),
		BackupsRoot: filepath.Join(dir, "backups"),
		StorePath:   filepath.Join(dir, "servers.json"),
		JavaPath:    "java",
	}
	serverDir := filepath.Join(cfg.ServersRoot, "one")
	if err := os.MkdirAll(filepath.Join(serverDir, "world"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(serverDir, "world", "level.dat"), []byte("LEVEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(cfg.StorePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Put(store.Server{ID: "one", Name: "one", Dir: serverDir, MinecraftVersion: "1.21.4"}); err != nil {
		t.Fatal(err)
	}
	mgr := server.NewManager(cfg, st, console.New())
	ts := httptest.NewServer(New(cfg, mgr, testToken, "fpr").Handler())
	defer ts.Close()
	base := ts.URL + "/v1/servers/"

	for _, c := range []struct {
		method, path string
		want         int
		contains     string
	}{
		{"GET", "nope/backups", 404, "server not found"},
		{"POST", "nope/backups", 404, "server not found"},
		{"DELETE", "nope/backups/20260101-000000-manual", 404, "server not found"},
		{"POST", "nope/backups/20260101-000000-manual/restore", 404, "server not found"},
		{"GET", "one/backups", 200, "[]"},
		{"DELETE", "one/backups/20260101-000000-manual", 404, "backup not found"},
		{"POST", "one/backups/20260101-000000-manual/restore", 404, "backup not found"},
		{"DELETE", "one/backups/20260101-000000-other", 400, "invalid backup id"},
		{"DELETE", "one/backups/..%2F..%2Fservers.json", 400, "invalid backup id"},
		{"POST", "one/backups/..%2Fx/restore", 400, "invalid backup id"},
	} {
		resp, body := do(t, c.method, base+c.path, "")
		if resp.StatusCode != c.want || !strings.Contains(body, c.contains) {
			t.Errorf("%s %s = %d %s, want %d %q", c.method, c.path, resp.StatusCode, body, c.want, c.contains)
		}
	}
	if _, err := os.Stat(cfg.StorePath); err != nil {
		t.Fatalf("the store file is gone: %v", err)
	}

	resp, body := do(t, "POST", base+"one/backups", "")
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("create = %d %s", resp.StatusCode, body)
	}
	var started struct {
		OperationID string `json:"operationId"`
	}
	if err := json.Unmarshal([]byte(body), &started); err != nil || started.OperationID == "" {
		t.Fatalf("create body = %s", body)
	}
	var view server.View
	for i := 0; ; i++ {
		_, body := do(t, "GET", base+"one", "")
		view = server.View{}
		if err := json.Unmarshal([]byte(body), &view); err != nil {
			t.Fatal(err)
		}
		if view.LastOperation != nil && view.LastOperation.ID == started.OperationID {
			break
		}
		if i > 500 {
			t.Fatalf("the backup never finished: %s", body)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !view.LastOperation.OK {
		t.Fatalf("backup failed: %+v", view.LastOperation)
	}
	id := view.LastOperation.BackupID
	if _, body := do(t, "GET", base+"one/backups", ""); !strings.Contains(body, `"id":"`+id+`"`) || !strings.Contains(body, `"whileRunning":false`) {
		t.Fatalf("list = %s", body)
	}
	if resp, body := do(t, "POST", base+"one/backups/"+id+"/restore", "{"); resp.StatusCode != 400 {
		t.Fatalf("malformed body = %d %s", resp.StatusCode, body)
	}
	if resp, body := do(t, "POST", base+"one/backups/"+id+"/restore", `{"backupFirst":false}`); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("restore = %d %s", resp.StatusCode, body)
	}
	for i := 0; ; i++ {
		_, body := do(t, "GET", base+"one", "")
		if strings.Contains(body, `"kind":"restore","ok":true`) && !strings.Contains(body, `"operation"`) {
			break
		}
		if i > 500 {
			t.Fatalf("the restore never finished: %s", body)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if resp, _ := do(t, "DELETE", base+"one/backups/"+id, ""); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
}
