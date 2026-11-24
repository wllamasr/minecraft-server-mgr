package server

import (
	"bytes"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/addons"
)

// fakeModrinthUpdates answers for two versions of one project: VER1, the plugin
// Demo in Demo-1.0.jar, and VER2, the same plugin in Demo-2.0.jar. Both are
// for paper.
func fakeModrinthUpdates(t *testing.T) {
	t.Helper()
	answers := map[string][]byte{}
	for _, v := range []struct{ id, file, number string }{
		{"VER1", "Demo-1.0.jar", "1.0"},
		{"VER2", "Demo-2.0.jar", "2.0"},
	} {
		content := pluginJar(t, "Demo")
		sum := sha512.Sum512(content)
		record, _ := json.Marshal(map[string]any{
			"id": v.id, "project_id": "PROJ1", "version_number": v.number, "loaders": []string{"paper"},
			"files": []map[string]any{{
				"url":      "https://cdn.modrinth.com/data/PROJ1/versions/" + v.id + "/" + v.file,
				"filename": v.file, "primary": true, "size": len(content),
				"hashes": map[string]string{"sha512": hex.EncodeToString(sum[:])},
			}},
		})
		answers["api.modrinth.com/v2/version/"+v.id] = record
		answers["cdn.modrinth.com/data/PROJ1/versions/"+v.id+"/"+v.file] = content
	}
	old := addons.Transport
	addons.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		body, ok := answers[r.URL.Host+r.URL.Path]
		status := http.StatusOK
		if !ok {
			status = http.StatusNotFound
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, Request: r}, nil
	})
	t.Cleanup(func() { addons.Transport = old })
}

func TestAddonUpdate(t *testing.T) {
	m := newRealManager(t)
	fakeModrinthUpdates(t)
	dir := paperServer(t, m, "a", false)

	opID, err := m.RequestAddonInstall("a", "VER1")
	if err != nil {
		t.Fatal(err)
	}
	if res := result(t, m, "a", opID); !res.OK {
		t.Fatalf("install: %+v", res)
	}

	// Not while the server runs: the jar is loaded, and a start must not
	// find it half replaced.
	if err := m.Start("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.RequestAddonUpdate("a", "Demo-1.0.jar", "VER2"); !IsConflict(err) {
		t.Errorf("an update of a running server: %v", err)
	}
	if err := m.Stop("a"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the server to stop", func() bool {
		v, _ := m.Get("a")
		return v.Status == StatusStopped
	})

	if _, err := m.RequestAddonUpdate("a", "Missing-1.0.jar", "VER2"); err == nil || err.Error() != ErrAddonNotFound.Error() {
		t.Errorf("an update of a plugin that is not there: %v", err)
	}
	if _, err := m.RequestAddonUpdate("a", "Demo-1.0.jar", "not an id!"); err == nil {
		t.Error("an invalid version id was accepted")
	}

	updateID, err := m.RequestAddonUpdate("a", "Demo-1.0.jar", "VER2")
	if err != nil {
		t.Fatal(err)
	}
	res := result(t, m, "a", updateID)
	if !res.OK || res.Addon != "Demo-2.0.jar" || res.Kind != "update" {
		t.Fatalf("update = %+v", res)
	}
	if got := pluginFiles(t, dir); got != "Demo-2.0.jar" {
		t.Errorf("plugins after update: %s", got)
	}
}
