package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/addons"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// pluginJar is a jar that declares itself as the plugin name.
func pluginJar(t *testing.T, name string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("plugin.yml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("name: " + name + "\nversion: 1.0\n"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fakeModrinth answers for Modrinth with one version, "VER1" of project
// "PROJ1": the plugin Demo, in Demo-1.0.jar, for the given loaders. With hold,
// the download of the file waits until the returned function is called (or
// the request is given up).
func fakeModrinth(t *testing.T, loaders []string, hold bool) (release func()) {
	t.Helper()
	content := pluginJar(t, "Demo")
	sum := sha512.Sum512(content)
	record, _ := json.Marshal(map[string]any{
		"id": "VER1", "project_id": "PROJ1", "version_number": "1.0", "loaders": loaders,
		"files": []map[string]any{{
			"url": "https://cdn.modrinth.com/data/PROJ1/versions/VER1/Demo-1.0.jar", "filename": "Demo-1.0.jar",
			"primary": true, "size": len(content), "hashes": map[string]string{"sha512": hex.EncodeToString(sum[:])},
		}},
	})
	gate := make(chan struct{})
	if !hold {
		close(gate)
	}
	old := addons.Transport
	addons.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		answer := func(status int, body []byte) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, Request: r}, nil
		}
		switch r.URL.Host + r.URL.Path {
		case "api.modrinth.com/v2/version/VER1":
			return answer(http.StatusOK, record)
		case "cdn.modrinth.com/data/PROJ1/versions/VER1/Demo-1.0.jar":
			// The answer begins at once; the file itself waits.
			body := &gatedBody{gate: gate, done: r.Context().Done(), r: bytes.NewReader(content)}
			return &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{}, Request: r}, nil
		}
		return answer(http.StatusNotFound, nil)
	})
	t.Cleanup(func() { addons.Transport = old })
	return func() { close(gate) }
}

// gatedBody is a download that does not come until its gate opens, and fails
// when the request is given up first.
type gatedBody struct {
	gate <-chan struct{}
	done <-chan struct{}
	r    io.Reader
}

func (b *gatedBody) Read(p []byte) (int, error) {
	select {
	case <-b.gate:
		return b.r.Read(p)
	case <-b.done:
		return 0, errors.New("request cancelled")
	}
}

func (b *gatedBody) Close() error { return nil }

// paperServer is minecraftServer on the Paper platform.
func paperServer(t *testing.T, m *Manager, id string, start bool) (dir string) {
	t.Helper()
	dir, _ = minecraftServer(t, m, id, "ok", false)
	if _, err := m.mutate(id, func(s *store.Server) { s.ModLoader = "paper" }); err != nil {
		t.Fatal(err)
	}
	if start {
		if err := m.Start(id); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func pluginFiles(t *testing.T, dir string) string {
	t.Helper()
	list, err := os.ReadDir(filepath.Join(dir, "plugins"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		if !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	return strings.Join(out, " ")
}

func TestAddonsOfAStoppedServer(t *testing.T) {
	m := newRealManager(t)
	fakeModrinth(t, []string{"paper"}, false)
	dir := paperServer(t, m, "a", false)

	if list, err := m.ListAddons("a"); err != nil || len(list) != 0 {
		t.Fatalf("a server without plugins: %+v, %v", list, err)
	}
	opID, err := m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if !res.OK || res.Kind != "install" || res.Addon != "Demo-1.0.jar" || res.Warning != "" || res.BackupID != "" {
		t.Fatalf("result = %+v\n%s", res, logs(m, "a"))
	}
	list, err := m.ListAddons("a")
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if p := list[0]; p.File != "Demo-1.0.jar" || !p.Enabled || p.Name != "Demo" || p.Version != "1.0" || p.ProjectID != "PROJ1" || p.VersionID != "VER1" {
		t.Errorf("plugin = %+v", p)
	}
	if out := logs(m, "a"); !strings.Contains(out, "Plugin Demo-1.0.jar installed (checksum OK).") {
		t.Errorf("console:\n%s", out)
	}

	// Once more is refused, by the operation: asking is not the error.
	opID, err = m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); res.OK || res.Cancelled || !strings.Contains(res.Error, "already installed") {
		t.Errorf("the second installation: %+v", res)
	}

	if err := m.SetAddonEnabled("a", "Demo-1.0.jar", false); err != nil {
		t.Fatal(err)
	}
	if got := pluginFiles(t, dir); got != "Demo-1.0.jar.disabled" {
		t.Fatalf("turned off: %s", got)
	}
	if list, _ := m.ListAddons("a"); len(list) != 1 || list[0].Enabled || list[0].ProjectID != "PROJ1" {
		t.Errorf("turned off: %+v", list)
	}
	if err := m.SetAddonEnabled("a", "Demo-1.0.jar", true); err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveAddon("a", "Demo-1.0.jar"); err != nil {
		t.Fatal(err)
	}
	if got := pluginFiles(t, dir); got != "" {
		t.Fatalf("removed: %s", got)
	}
	for _, missing := range []string{"Demo-1.0.jar", "../server.jar", "x"} {
		if err := m.RemoveAddon("a", missing); !errors.Is(err, ErrAddonNotFound) {
			t.Errorf("RemoveAddon(%q) = %v", missing, err)
		}
		if err := m.SetAddonEnabled("a", missing, false); !errors.Is(err, ErrAddonNotFound) {
			t.Errorf("SetAddonEnabled(%q) = %v", missing, err)
		}
	}
	// Nothing outside the plugins folder was touched.
	if _, err := os.Stat(filepath.Join(dir, "server.jar")); err != nil {
		t.Error(err)
	}
}

func TestAddonsOfARunningServer(t *testing.T) {
	m := newRealManager(t)
	fakeModrinth(t, []string{"bukkit"}, false)
	dir := paperServer(t, m, "a", true)

	// A plugin can be added while the server runs; it is not loaded yet.
	opID, err := m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", opID)
	if !res.OK || !strings.Contains(res.Warning, "restart the server") {
		t.Fatalf("result = %+v", res)
	}
	// A loaded jar is not taken from under the server.
	if err := m.RemoveAddon("a", "Demo-1.0.jar"); !IsConflict(err) {
		t.Errorf("removing from a running server: %v", err)
	}
	if err := m.SetAddonEnabled("a", "Demo-1.0.jar", false); !IsConflict(err) {
		t.Errorf("turning off on a running server: %v", err)
	}
	if got := pluginFiles(t, dir); got != "Demo-1.0.jar" {
		t.Fatalf("plugins: %s", got)
	}
	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	if err := m.SetAddonEnabled("a", "Demo-1.0.jar", false); err != nil {
		t.Errorf("turning off once it stopped: %v", err)
	}
}

func TestAddonsNeedAPluginPlatform(t *testing.T) {
	m := newRealManager(t)
	fakeModrinth(t, []string{"fabric"}, false)
	minecraftServer(t, m, "vanilla", "ok", false)
	if _, err := m.ListAddons("vanilla"); !IsConflict(err) {
		t.Errorf("list: %v", err)
	}
	if _, err := m.RequestAddonInstall("vanilla", "VER1"); !IsConflict(err) {
		t.Errorf("install: %v", err)
	}
	if err := m.RemoveAddon("vanilla", "x.jar"); !IsConflict(err) {
		t.Errorf("remove: %v", err)
	}
	if _, err := m.ListAddons("nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown server: %v", err)
	}

	// A version for another platform is not installed on a Paper server.
	dir := paperServer(t, m, "a", false)
	if _, err := m.RequestAddonInstall("a", "not an id"); err == nil || IsConflict(err) {
		t.Errorf("a bad version id: %v", err)
	}
	opID, err := m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); res.OK || !strings.Contains(res.Error, "not built for paper") {
		t.Errorf("result = %+v", res)
	}
	if got := pluginFiles(t, dir); got != "" {
		t.Errorf("plugins: %s", got)
	}
}

// An installation holds the server's one slot for operations, and is not tied
// to whether the server runs.
func TestAddonInstallAndTheRestOfTheServer(t *testing.T) {
	m := newRealManager(t)
	release := fakeModrinth(t, []string{"paper"}, true)
	dir := paperServer(t, m, "a", false)

	opID, err := m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the download to begin", func() bool {
		v, _ := m.Get("a")
		return v.Operation != nil && v.Operation.Kind == "install" && v.Operation.Phase == "downloading"
	})
	if _, err := m.RequestBackup("a"); !IsConflict(err) || !strings.Contains(err.Error(), "plugin is being installed") {
		t.Errorf("a backup meanwhile: %v", err)
	}
	if _, err := m.RequestAddonInstall("a", "VER1"); !IsConflict(err) {
		t.Errorf("a second installation meanwhile: %v", err)
	}
	if err := m.RemoveAddon("a", "Demo-1.0.jar"); !IsConflict(err) {
		t.Errorf("a removal meanwhile: %v", err)
	}
	// The server starts and stops with the installation under way, and
	// neither ends it.
	if err := m.Start("a"); err != nil {
		t.Fatalf("starting meanwhile: %v", err)
	}
	if err := m.Stop("a"); err != nil {
		t.Fatalf("stopping meanwhile: %v", err)
	}
	if v, _ := m.Get("a"); v.Operation == nil {
		t.Fatal("the stop ended the installation")
	}
	// Nothing the server would load is in the folder until the file is whole.
	waitFor(t, "the unfinished file", func() bool { return pluginFiles(t, dir) == "Demo-1.0.jar.part" })
	release()
	if res := result(t, m, "a", opID); !res.OK || res.Warning != "" {
		t.Fatalf("result = %+v", res)
	}
	if got := pluginFiles(t, dir); got != "Demo-1.0.jar" {
		t.Errorf("plugins: %s", got)
	}
}

func TestDeletingAServerEndsAnInstallation(t *testing.T) {
	m := newRealManager(t)
	fakeModrinth(t, []string{"paper"}, true) // never released
	dir := paperServer(t, m, "a", false)
	if _, err := m.RequestAddonInstall("a", "VER1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the download to begin", func() bool { return pluginFiles(t, dir) != "" })
	if _, err := m.RequestDelete("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("the server's folder after the delete: %v", err)
	}
}
