package addons

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jar builds a plugin jar that declares a name and a version.
func jar(t *testing.T, descriptor, text string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if descriptor != "" {
		w, err := zw.Create(descriptor)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(text))
	}
	w, _ := zw.Create("com/example/Main.class")
	_, _ = w.Write([]byte("class"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func put(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o640); err != nil {
		t.Fatal(err)
	}
}

func names(t *testing.T, dir string) string {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		out = append(out, e.Name())
	}
	return strings.Join(out, " ")
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// modrinth stands in for Modrinth: it answers for the two hosts with what it
// was given, by "host/path", and counts what it was asked.
type modrinth struct {
	answers map[string][]byte
	asked   []string
}

func fakeModrinth(t *testing.T) *modrinth {
	t.Helper()
	m := &modrinth{answers: map[string][]byte{}}
	old := Transport
	Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		key := r.URL.Host + r.URL.Path
		m.asked = append(m.asked, r.URL.String())
		body, ok := m.answers[key]
		status := http.StatusOK
		if !ok {
			status = http.StatusNotFound
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, Request: r}, nil
	})
	t.Cleanup(func() { Transport = old })
	return m
}

type fakeFile struct {
	URL      string            `json:"url"`
	Filename string            `json:"filename"`
	Primary  bool              `json:"primary"`
	Size     int64             `json:"size"`
	Hashes   map[string]string `json:"hashes"`
}

// version publishes a version with one file on the fake Modrinth; change may
// alter what the version's record says of the file.
func (m *modrinth) version(t *testing.T, id, project, fileName string, content []byte, loaders []string, change func(*fakeFile)) {
	t.Helper()
	sum := sha512.Sum512(content)
	file := fakeFile{
		URL:      "https://cdn.modrinth.com/data/" + project + "/versions/" + id + "/" + fileName,
		Filename: fileName,
		Primary:  true,
		Size:     int64(len(content)),
		Hashes:   map[string]string{"sha512": hex.EncodeToString(sum[:])},
	}
	m.answers["cdn.modrinth.com/data/"+project+"/versions/"+id+"/"+fileName] = content
	if change != nil {
		change(&file)
	}
	record, err := json.Marshal(map[string]any{
		"id": id, "project_id": project, "version_number": "1.2.3", "loaders": loaders, "files": []fakeFile{file},
	})
	if err != nil {
		t.Fatal(err)
	}
	m.answers["api.modrinth.com/v2/version/"+id] = record
}

func TestValidFileName(t *testing.T) {
	for _, ok := range []string{"LuckPerms-Bukkit-5.4.145.jar", "a.jar", "Essentials X (2.20) [beta]+build.7.jar"} {
		if !ValidFileName(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{
		"", ".jar", "a.zip", "a.jar.disabled", "../a.jar", "a/b.jar", `a\b.jar`, "a..b.jar", ".hidden.jar",
		"con.jar", "NUL.x.jar", "com1.jar", "a:b.jar", "a\x00.jar", "ñ.jar", strings.Repeat("a", 130) + ".jar",
	} {
		if ValidFileName(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestDirAndLoaders(t *testing.T) {
	for _, p := range []string{"paper", "purpur", "folia"} {
		if dir, ok := Dir(p); !ok || dir != "plugins" {
			t.Errorf("Dir(%q) = %q, %v", p, dir, ok)
		}
	}
	for _, p := range []string{"", "fabric", "forge", "neoforge", "quilt", "Paper"} {
		if _, ok := Dir(p); ok {
			t.Errorf("Dir(%q) is managed", p)
		}
	}
	bukkit := Version{Loaders: []string{"bukkit", "spigot"}}
	if !bukkit.RunsOn("paper") || !bukkit.RunsOn("purpur") || bukkit.RunsOn("folia") || bukkit.RunsOn("fabric") {
		t.Error("a Bukkit plugin runs on Paper and Purpur, not on Folia")
	}
	if folia := (Version{Loaders: []string{"folia"}}); !folia.RunsOn("folia") || folia.RunsOn("paper") {
		t.Error("a Folia-only plugin runs on Folia only")
	}
}

func TestParseDescriptor(t *testing.T) {
	cases := []struct{ text, name, version string }{
		{"name: LuckPerms\nversion: 5.4.145\nmain: x.Y\n", "LuckPerms", "5.4.145"},
		{"name: \"Quoted Name\" # the name\r\nversion: '1.0'\r\n", "Quoted Name", "1.0"},
		{"version: 2 # two\nname:   Spaced   \n", "Spaced", "2"},
		// Only top-level keys, and the first of each.
		{"commands:\n  name: nested\nname: Top\nname: Second\n", "Top", ""},
		{"name: bad\x1b[31mname\n", "bad[31mname", ""},
		{"nothing here", "", ""},
	}
	for _, c := range cases {
		if name, version := parseDescriptor(c.text); name != c.name || version != c.version {
			t.Errorf("parseDescriptor(%q) = %q, %q", c.text, name, version)
		}
	}
	if name, _ := parseDescriptor("name: " + strings.Repeat("x", 500)); len(name) != 80 {
		t.Errorf("a name of %d characters", len(name))
	}
}

func TestListIsWhatIsInTheFolder(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "Beta.jar"), jar(t, "plugin.yml", "name: Beta\nversion: 2.0\n"))
	put(t, filepath.Join(dir, "alpha.jar.disabled"), jar(t, "paper-plugin.yml", "name: Alpha\nversion: '1'\n"))
	put(t, filepath.Join(dir, "not-a-zip.jar"), []byte("garbage"))
	// Not plugins: other files, a folder called like a jar, a plugin's data.
	put(t, filepath.Join(dir, "notes.txt"), []byte("x"))
	put(t, filepath.Join(dir, "Half.jar.part"), []byte("x"))
	put(t, filepath.Join(dir, "Beta", "config.yml"), []byte("x"))
	put(t, filepath.Join(dir, "folder.jar", "x"), []byte("x"))
	put(t, filepath.Join(dir, originsFile), []byte("{broken"))

	list, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("list = %+v", list)
	}
	a, b, c := list[0], list[1], list[2]
	if a.File != "alpha.jar" || a.Enabled || a.Name != "Alpha" || a.Version != "1" || a.SizeBytes == 0 || a.ModifiedAt == "" {
		t.Errorf("alpha = %+v", a)
	}
	if b.File != "Beta.jar" || !b.Enabled || b.Name != "Beta" || b.Version != "2.0" {
		t.Errorf("beta = %+v", b)
	}
	if c.File != "not-a-zip.jar" || !c.Enabled || c.Name != "" {
		t.Errorf("not-a-zip = %+v", c)
	}

	if list, err := List(filepath.Join(dir, "missing")); err != nil || len(list) != 0 {
		t.Errorf("a folder that is not there: %+v, %v", list, err)
	}
}

func TestSetEnabledAndRemove(t *testing.T) {
	dir := t.TempDir()
	put(t, filepath.Join(dir, "A.jar"), jar(t, "plugin.yml", "name: A\n"))
	put(t, filepath.Join(dir, "A", "data.yml"), []byte("kept"))

	if err := SetEnabled(dir, "A.jar", true); err != nil {
		t.Fatalf("turning on what is on: %v", err)
	}
	if err := SetEnabled(dir, "A.jar", false); err != nil {
		t.Fatal(err)
	}
	if got := names(t, dir); got != "A A.jar.disabled" {
		t.Fatalf("after turning off: %s", got)
	}
	if err := SetEnabled(dir, "A.jar", true); err != nil {
		t.Fatal(err)
	}
	if got := names(t, dir); got != "A A.jar" {
		t.Fatalf("after turning on: %s", got)
	}

	// The name of the suffixed file is not a plugin's name, nor is a path.
	for _, bad := range []string{"A.jar.disabled", "../A.jar", "B.jar", "A"} {
		if err := SetEnabled(dir, bad, false); err != ErrNotFound {
			t.Errorf("SetEnabled(%q) = %v", bad, err)
		}
		if err := Remove(dir, bad); err != ErrNotFound {
			t.Errorf("Remove(%q) = %v", bad, err)
		}
	}

	if err := Remove(dir, "A.jar"); err != nil {
		t.Fatal(err)
	}
	// The jar is gone; what the plugin wrote is not.
	if got := names(t, dir); got != "A" {
		t.Fatalf("after removing: %s", got)
	}
}

func TestInstall(t *testing.T) {
	m := fakeModrinth(t)
	content := jar(t, "plugin.yml", "name: LuckPerms\nversion: 5.4\n")
	m.version(t, "VER1", "PROJ1", "LuckPerms-5.4.jar", content, []string{"paper", "bukkit"}, nil)
	dir := filepath.Join(t.TempDir(), "plugins") // made on the first installation

	v, err := Resolve(context.Background(), "VER1")
	if err != nil {
		t.Fatal(err)
	}
	if v.ProjectID != "PROJ1" || v.FileName != "LuckPerms-5.4.jar" || !v.RunsOn("paper") || v.RunsOn("folia") {
		t.Fatalf("version = %+v", v)
	}
	var last, total int64
	if err := Install(context.Background(), dir, v, func(d, tot int64) { last, total = d, tot }); err != nil {
		t.Fatal(err)
	}
	if last != int64(len(content)) || total != last {
		t.Errorf("progress ended at %d of %d", last, total)
	}
	if got := names(t, dir); got != originsFile+" LuckPerms-5.4.jar" {
		t.Fatalf("folder: %s", got)
	}
	list, _ := List(dir)
	if len(list) != 1 || list[0].ProjectID != "PROJ1" || list[0].VersionID != "VER1" || list[0].Name != "LuckPerms" || !list[0].Enabled {
		t.Fatalf("list = %+v", list)
	}

	// Not twice, by file or by project (another version has another file).
	if err := Install(context.Background(), dir, v, nil); err == nil || !strings.Contains(err.Error(), "already installed") {
		t.Errorf("the same file again: %v", err)
	}
	m.version(t, "VER2", "PROJ1", "LuckPerms-5.5.jar", content, []string{"paper"}, nil)
	v2, err := Resolve(context.Background(), "VER2")
	if err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), dir, v2, nil); err == nil || !strings.Contains(err.Error(), "Remove it first") {
		t.Errorf("another version of the project: %v", err)
	}
	// Nor over one that is turned off.
	if err := SetEnabled(dir, "LuckPerms-5.4.jar", false); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), dir, v, nil); err == nil {
		t.Error("installed over a plugin that is turned off")
	}
	if got := names(t, dir); got != originsFile+" LuckPerms-5.4.jar.disabled" {
		t.Fatalf("folder after the refusals: %s", got)
	}

	// Removed, it is forgotten, and the other version can be installed.
	if err := Remove(dir, "LuckPerms-5.4.jar"); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), dir, v2, nil); err != nil {
		t.Fatalf("after removing the first: %v", err)
	}

	// A file put under an installed one's name by hand is not that version.
	put(t, filepath.Join(dir, "LuckPerms-5.5.jar"), []byte("something else"))
	if list, _ := List(dir); len(list) != 1 || list[0].ProjectID != "" {
		t.Errorf("a replaced file keeps its origin: %+v", list)
	}
}

func TestInstallKeepsOnlyWhatModrinthDescribed(t *testing.T) {
	content := jar(t, "plugin.yml", "name: X\n")
	cases := []struct {
		name   string
		change func(*fakeFile)
		tamper func(m *modrinth)
		want   string
	}{
		{name: "another checksum", change: func(f *fakeFile) { f.Hashes["sha512"] = strings.Repeat("0", 128) }, want: "checksum"},
		{name: "a longer file", tamper: func(m *modrinth) {
			m.answers["cdn.modrinth.com/data/P/versions/V/X.jar"] = append(append([]byte{}, content...), "more"...)
		}, want: "larger"},
		{name: "a shorter file", tamper: func(m *modrinth) {
			m.answers["cdn.modrinth.com/data/P/versions/V/X.jar"] = content[:len(content)-3]
		}, want: "checksum"},
		{name: "a file that is not there", tamper: func(m *modrinth) {
			delete(m.answers, "cdn.modrinth.com/data/P/versions/V/X.jar")
		}, want: "HTTP 404"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := fakeModrinth(t)
			m.version(t, "V", "P", "X.jar", content, []string{"paper"}, c.change)
			if c.tamper != nil {
				c.tamper(m)
			}
			dir := t.TempDir()
			v, err := Resolve(context.Background(), "V")
			if err != nil {
				t.Fatal(err)
			}
			err = Install(context.Background(), dir, v, nil)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v", err)
			}
			if got := names(t, dir); got != "" {
				t.Errorf("left in the folder: %s", got)
			}
		})
	}
}

func TestResolveTakesNothingOnTrust(t *testing.T) {
	content := jar(t, "plugin.yml", "name: X\n")
	cases := []struct {
		name   string
		change func(*fakeFile)
		want   string
	}{
		{"a file elsewhere", func(f *fakeFile) { f.URL = "https://example.com/X.jar" }, "not kept on Modrinth"},
		{"a look-alike host", func(f *fakeFile) { f.URL = "https://cdn.modrinth.com.example.com/X.jar" }, "not kept on Modrinth"},
		{"a host with a user", func(f *fakeFile) { f.URL = "https://cdn.modrinth.com@example.com/X.jar" }, "not kept on Modrinth"},
		{"the host with a user", func(f *fakeFile) { f.URL = "https://someone@cdn.modrinth.com/X.jar" }, "not kept on Modrinth"},
		{"plain http", func(f *fakeFile) { f.URL = "http://cdn.modrinth.com/X.jar" }, "not kept on Modrinth"},
		{"another port", func(f *fakeFile) { f.URL = "https://cdn.modrinth.com:8443/X.jar" }, "not kept on Modrinth"},
		{"a path for a name", func(f *fakeFile) { f.Filename = "../../server.jar" }, "not a plugin jar"},
		{"no jar", func(f *fakeFile) { f.Filename = "run.sh" }, "not a plugin jar"},
		{"no checksum", func(f *fakeFile) { delete(f.Hashes, "sha512") }, "no checksum"},
		{"no size", func(f *fakeFile) { f.Size = 0 }, "too large"},
		{"a huge file", func(f *fakeFile) { f.Size = maxFileSize + 1 }, "too large"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := fakeModrinth(t)
			m.version(t, "V", "P", "X.jar", content, []string{"paper"}, c.change)
			if _, err := Resolve(context.Background(), "V"); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v", err)
			}
			// Refused on what the record says: the file was not asked for.
			if len(m.asked) != 1 {
				t.Errorf("asked: %v", m.asked)
			}
		})
	}

	m := fakeModrinth(t)
	if _, err := Resolve(context.Background(), "NOPE"); err == nil || !strings.Contains(err.Error(), "no such version") {
		t.Errorf("an unknown version: %v", err)
	}
	// An id that is no id never reaches Modrinth.
	for _, bad := range []string{"", "a/b", "../project/x", "a?b", "a b", strings.Repeat("a", 33)} {
		if _, err := Resolve(context.Background(), bad); err == nil {
			t.Errorf("Resolve(%q) went through", bad)
		}
	}
	if len(m.asked) != 1 {
		t.Errorf("asked: %v", m.asked)
	}
	// An answer about another version is not this one's.
	m.answers["api.modrinth.com/v2/version/V9"] = []byte(`{"id":"OTHER","project_id":"P","files":[{"url":"https://cdn.modrinth.com/x.jar","filename":"x.jar","size":1,"hashes":{"sha512":"` + strings.Repeat("a", 128) + `"}}]}`)
	if _, err := Resolve(context.Background(), "V9"); err == nil || !strings.Contains(err.Error(), "not about this version") {
		t.Errorf("an answer about another version: %v", err)
	}
}

// Modrinth answers directly. An answer that sends the daemon elsewhere, even
// to the same host, is not followed.
func TestNoRedirectIsFollowed(t *testing.T) {
	m := fakeModrinth(t)
	content := jar(t, "plugin.yml", "name: X\n")
	m.version(t, "V", "P", "X.jar", content, []string{"paper"}, nil)
	v, err := Resolve(context.Background(), "V")
	if err != nil {
		t.Fatal(err)
	}
	var asked []string
	old := Transport
	Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		asked = append(asked, r.URL.String())
		if len(asked) > 1 {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(content)), Header: http.Header{}, Request: r}, nil
		}
		header := http.Header{"Location": []string{"https://example.com/X.jar"}}
		return &http.Response{StatusCode: http.StatusFound, Body: io.NopCloser(strings.NewReader("")), Header: header, Request: r}, nil
	})
	defer func() { Transport = old }()
	dir := t.TempDir()
	if err := Install(context.Background(), dir, v, nil); err == nil {
		t.Error("installed what a redirect led to")
	}
	if len(asked) != 1 {
		t.Errorf("asked: %v", asked)
	}
	if got := names(t, dir); got != "" {
		t.Errorf("left in the folder: %s", got)
	}
}

// A leftover of an installation that was cut short does not stand in the way,
// and a link under the name of the unfinished file is not written through.
func TestInstallOverALeftover(t *testing.T) {
	m := fakeModrinth(t)
	content := jar(t, "plugin.yml", "name: X\n")
	m.version(t, "V", "P", "X.jar", content, []string{"paper"}, nil)
	v, err := Resolve(context.Background(), "V")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim.txt")
	put(t, victim, []byte("untouched"))
	if err := os.Symlink(victim, filepath.Join(dir, "X.jar.part")); err != nil {
		// No links for this user (Windows without the privilege): a plain leftover.
		put(t, filepath.Join(dir, "X.jar.part"), []byte("half"))
	}
	if err := Install(context.Background(), dir, v, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "untouched" {
		t.Errorf("the file the link pointed at now holds %d bytes", len(b))
	}
	if got := names(t, dir); got != originsFile+" X.jar" {
		t.Errorf("folder: %s", got)
	}
}

func TestErrorsNameNoPath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "secret-location", "x")
	_, openErr := os.Open(missing)
	renameErr := os.Rename(missing, missing+"2")
	for _, err := range []error{openErr, renameErr} {
		if err == nil || !strings.Contains(err.Error(), "secret-location") {
			t.Fatalf("the test's own error: %v", err)
		}
		if got := plain(err); strings.Contains(got.Error(), "secret-location") || got.Error() == "" {
			t.Errorf("plain(%v) = %v", err, got)
		}
	}
}

func TestInstallStopsWhenToldTo(t *testing.T) {
	m := fakeModrinth(t)
	m.version(t, "V", "P", "X.jar", jar(t, "plugin.yml", "name: X\n"), []string{"paper"}, nil)
	v, err := Resolve(context.Background(), "V")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	// The transport of the tests does not look at the context; a real one
	// fails the request. Either way nothing may be left behind.
	old := Transport
	Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		cancel()
		return nil, r.Context().Err()
	})
	defer func() { Transport = old }()
	dir := t.TempDir()
	if err := Install(ctx, dir, v, nil); err == nil {
		t.Error("installed although it was told to stop")
	}
	if got := names(t, dir); got != "" {
		t.Errorf("left in the folder: %s", got)
	}
}
