package backup

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// tree returns every file under dir with its content, and empty directories
// as "<rel>/".
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if info.IsDir() {
			entries, _ := os.ReadDir(p)
			if len(entries) == 0 {
				out[rel+"/"] = ""
			}
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[rel] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func sampleServer(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "server")
	writeFile(t, filepath.Join(dir, "server.properties"), "motd=hi\n")
	writeFile(t, filepath.Join(dir, "world", "level.dat"), "LEVEL")
	writeFile(t, filepath.Join(dir, "world", "region", "r.0.0.mca"), strings.Repeat("R", 5000))
	writeFile(t, filepath.Join(dir, "world", "session.lock"), "lock")
	writeFile(t, filepath.Join(dir, "plugins", "Thing", "config.yml"), "a: 1\n")
	writeFile(t, filepath.Join(dir, "logs", "latest.log"), "log")
	writeFile(t, filepath.Join(dir, "Libraries", "x.jar"), "jar")
	writeFile(t, filepath.Join(dir, "cache", "c.bin"), "c")
	if err := os.MkdirAll(filepath.Join(dir, "world", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRoundTrip(t *testing.T) {
	dir := sampleServer(t)
	linked := false
	if err := os.Symlink(filepath.Join(dir, "logs"), filepath.Join(dir, "world", "link")); err == nil {
		linked = true
	}

	plan, err := MakePlan(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, f := range plan.Files {
		rels = append(rels, f.Rel)
	}
	sort.Strings(rels)
	want := []string{"plugins/Thing/config.yml", "server.properties", "world/level.dat", "world/region/r.0.0.mca"}
	if strings.Join(rels, ",") != strings.Join(want, ",") {
		t.Fatalf("plan files = %v, want %v", rels, want)
	}
	if len(plan.EmptyDirs) != 1 || plan.EmptyDirs[0] != "world/empty" {
		t.Fatalf("empty dirs = %v", plan.EmptyDirs)
	}
	if linked && (len(plan.Skipped) != 1 || plan.Skipped[0] != "world/link") {
		t.Fatalf("skipped = %v, want the link", plan.Skipped)
	}

	dest := filepath.Join(t.TempDir(), "backups", "b.zip")
	var last int64
	if err := Write(context.Background(), plan, dest, `{"fileCount":4}`, func(done, total int64) { last = done }); err != nil {
		t.Fatal(err)
	}
	if last != plan.TotalBytes {
		t.Fatalf("progress ended at %d, want %d", last, plan.TotalBytes)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatalf(".part left behind: %v", err)
	}
	comment, err := ReadComment(dest)
	if err != nil || comment != `{"fileCount":4}` {
		t.Fatalf("comment = %q, %v", comment, err)
	}

	// Region files are stored, text is compressed.
	zr, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		switch f.Name {
		case "world/region/r.0.0.mca":
			if f.Method != zip.Store {
				t.Errorf("%s is compressed", f.Name)
			}
		case "server.properties":
			if f.Method != zip.Deflate {
				t.Errorf("%s is stored", f.Name)
			}
		}
	}
	zr.Close()

	stage := filepath.Join(t.TempDir(), "stage")
	if err := os.Mkdir(stage, 0o755); err != nil {
		t.Fatal(err)
	}
	n, err := Extract(context.Background(), dest, stage, plan.TotalBytes, nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Fatalf("extracted %d files, want 4", n)
	}
	got := tree(t, stage)
	if len(got) != 5 || got["world/level.dat"] != "LEVEL" || got["plugins/Thing/config.yml"] != "a: 1\n" {
		t.Fatalf("extracted tree = %v", keys(got))
	}
	if _, ok := got["world/empty/"]; !ok {
		t.Fatalf("the empty directory was lost: %v", keys(got))
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestWriteCancelledLeavesNothing(t *testing.T) {
	dir := sampleServer(t)
	plan, err := MakePlan(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	dest := filepath.Join(t.TempDir(), "b.zip")
	// Cancelled from inside the copy, as a stop request would.
	err = Write(ctx, plan, dest, "{}", func(done, total int64) { cancel(errors.New("the server is stopping")) })
	if !errors.Is(err, ErrCancelled) {
		t.Fatalf("err = %v, want cancelled", err)
	}
	if !strings.Contains(err.Error(), "the server is stopping") {
		t.Fatalf("the reason is missing: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(dest))
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestWriteFailsWhenAFileIsGone(t *testing.T) {
	dir := sampleServer(t)
	plan, err := MakePlan(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "world", "level.dat")); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "b.zip")
	err = Write(context.Background(), plan, dest, "{}", nil)
	if err == nil || !strings.Contains(err.Error(), "could not read world/level.dat") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("an incomplete backup got its final name")
	}
}

type rawEntry struct {
	name    string
	content string
	mode    os.FileMode
}

func rawZip(t *testing.T, entries ...rawEntry) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "raw.zip")
	out, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(out)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractRefusesDangerousArchives(t *testing.T) {
	cases := map[string][]rawEntry{
		"parent":         {{name: "../evil.txt", content: "x"}},
		"nested parent":  {{name: "world/../../evil.txt", content: "x"}},
		"absolute":       {{name: "/etc/passwd", content: "x"}},
		"backslash":      {{name: `world\evil.txt`, content: "x"}},
		"drive":          {{name: "C:/evil.txt", content: "x"}},
		"stream":         {{name: "world/a.txt:evil", content: "x"}},
		"trailing dot":   {{name: "world./a.txt", content: "x"}},
		"trailing space": {{name: "world/a.txt ", content: "x"}},
		"device":         {{name: "world/CON.txt", content: "x"}},
		"device bare":    {{name: "nul", content: "x"}},
		"uncovered":      {{name: "logs/latest.log", content: "x"}},
		"uncovered case": {{name: "LIBRARIES/x.jar", content: "x"}},
		"double slash":   {{name: "world//a.txt", content: "x"}},
		"dot segment":    {{name: "./world/a.txt", content: "x"}},
		"duplicate":      {{name: "world/a.txt", content: "x"}, {name: "World/A.txt", content: "y"}},
		"link":           {{name: "world/link", content: "/etc", mode: os.ModeSymlink | 0o777}},
		"device file":    {{name: "world/dev", content: "", mode: os.ModeDevice | 0o666}},
		"control char":   {{name: "world/a\nb", content: "x"}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			// A good entry first: nothing of it may be written either.
			all := append([]rawEntry{{name: "server.properties", content: "ok"}}, entries...)
			archive := rawZip(t, all...)
			root := t.TempDir()
			stage := filepath.Join(root, "stage")
			if err := os.Mkdir(stage, 0o755); err != nil {
				t.Fatal(err)
			}
			if _, err := Extract(context.Background(), archive, stage, 1<<20, nil); err == nil {
				t.Fatal("the archive was accepted")
			}
			if left, _ := os.ReadDir(stage); len(left) != 0 {
				t.Fatalf("files were written before the archive was refused: %v", left)
			}
			if left, _ := os.ReadDir(root); len(left) != 1 {
				t.Fatalf("something was written outside the stage: %v", left)
			}
		})
	}
}

func TestExtractRefusesMoreDataThanAnnounced(t *testing.T) {
	archive := rawZip(t, rawEntry{name: "world/big.bin", content: strings.Repeat("A", 4096)})
	stage := t.TempDir()
	if _, err := Extract(context.Background(), archive, stage, 100, nil); err == nil {
		t.Fatal("an archive bigger than its manifest was accepted")
	}
}

func TestExtractCancelled(t *testing.T) {
	archive := rawZip(t, rawEntry{name: "world/a.bin", content: "A"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Extract(ctx, archive, t.TempDir(), 100, nil); !errors.Is(err, ErrCancelled) {
		t.Fatalf("err = %v", err)
	}
}

func TestSwap(t *testing.T) {
	dir := sampleServer(t)
	root := filepath.Dir(dir)
	stage := filepath.Join(root, "stage")
	writeFile(t, filepath.Join(stage, "server.properties"), "motd=restored\n")
	writeFile(t, filepath.Join(stage, "world", "level.dat"), "OLD")

	aside := filepath.Join(root, "aside")
	if err := Swap(dir, stage, aside); err != nil {
		t.Fatal(err)
	}
	got := tree(t, dir)
	if got["server.properties"] != "motd=restored\n" || got["world/level.dat"] != "OLD" {
		t.Fatalf("the backup is not in place: %v", got)
	}
	// Covered files that the backup does not have are gone...
	if _, ok := got["plugins/Thing/config.yml"]; ok {
		t.Fatal("a covered file outside the backup survived")
	}
	if _, ok := got["world/region/r.0.0.mca"]; ok {
		t.Fatal("the world is a mix of two points in time")
	}
	// ...and what backups do not cover stays.
	if got["logs/latest.log"] != "log" || got["Libraries/x.jar"] != "jar" {
		t.Fatalf("uncovered entries were touched: %v", keys(got))
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatal("the aside folder was left behind")
	}
}

func TestSwapPutsEverythingBack(t *testing.T) {
	dir := sampleServer(t)
	before := tree(t, dir)
	root := filepath.Dir(dir)
	stage := filepath.Join(root, "stage")
	writeFile(t, filepath.Join(stage, "a.txt"), "new")
	// Cannot be moved in: the server has a non-empty "logs" that stays where
	// it is. (Extract never stages such an entry; this only forces a failure
	// half-way.)
	writeFile(t, filepath.Join(stage, "logs", "x.log"), "new")

	aside := filepath.Join(root, "aside")
	err := Swap(dir, stage, aside)
	if err == nil {
		t.Fatal("the swap went through")
	}
	var leftover *LeftoverError
	if errors.As(err, &leftover) {
		t.Fatalf("reported as restored: %v", err)
	}
	if !strings.Contains(err.Error(), "left as they were") {
		t.Fatalf("err = %v", err)
	}
	after := tree(t, dir)
	if len(after) != len(before) {
		t.Fatalf("the server changed: %v -> %v", keys(before), keys(after))
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("%s changed", k)
		}
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatal("the aside folder was left behind")
	}
}

func TestSwapRefusesAnExistingAside(t *testing.T) {
	dir := sampleServer(t)
	root := filepath.Dir(dir)
	stage := filepath.Join(root, "stage")
	writeFile(t, filepath.Join(stage, "a.txt"), "new")
	aside := filepath.Join(root, "aside")
	writeFile(t, filepath.Join(aside, "old.txt"), "old")
	if err := Swap(dir, stage, aside); err == nil {
		t.Fatal("swapped over a leftover of an earlier restore")
	}
	if got := tree(t, dir); got["server.properties"] != "motd=hi\n" {
		t.Fatal("the server changed")
	}
}

func TestASCIIJSON(t *testing.T) {
	in := Manifest{Format: 1, ServerName: "Мой сервер 🎮 <a&b>", FileCount: 3, TotalBytes: 9}
	out, err := ASCIIJSON(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range out {
		if r < 0x20 || r > 0x7e {
			t.Fatalf("non-ASCII in %q", out)
		}
	}
	var back Manifest
	if err := json.Unmarshal([]byte(out), &back); err != nil {
		t.Fatal(err)
	}
	if back.ServerName != in.ServerName {
		t.Fatalf("name = %q, want %q", back.ServerName, in.ServerName)
	}
	// The emoji is one surrogate pair, as JavaScript reads it.
	if !strings.Contains(out, `\ud83c\udfae`) {
		t.Fatalf("no surrogate pair in %q", out)
	}
}

func TestRestorableManifest(t *testing.T) {
	good := `{"format":1,"serverId":"s","fileCount":3,"totalBytes":10,"whileRunning":true}`
	m, err := RestorableManifest(good)
	if err != nil || m.FileCount != 3 || m.TotalBytes != 10 || !m.WhileRunning {
		t.Fatalf("m = %+v, err = %v", m, err)
	}
	for name, comment := range map[string]string{
		"empty":          "",
		"not json":       "hello",
		"array":          "[1]",
		"no counts":      `{"format":1}`,
		"zero files":     `{"fileCount":0,"totalBytes":0}`,
		"fraction":       `{"fileCount":1.5,"totalBytes":0}`,
		"negative bytes": `{"fileCount":1,"totalBytes":-1}`,
		"string count":   `{"fileCount":"3","totalBytes":1}`,
		"null":           `{"fileCount":null,"totalBytes":1}`,
	} {
		if _, err := RestorableManifest(comment); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestIDs(t *testing.T) {
	at := time.Date(2026, 3, 4, 5, 6, 7, 0, time.FixedZone("x", 3600))
	id := NewID(at, "manual")
	if id != "20260304-040607-manual" {
		t.Fatalf("id = %s", id)
	}
	got, kind, ok := IDTime(id)
	if !ok || kind != "manual" || !got.Equal(at) {
		t.Fatalf("IDTime = %v %s %v", got, kind, ok)
	}
	for _, bad := range []string{"", "x", "../20260304-040607-manual", "20260304-040607-manual.zip", "20260304-040607-other", "20260304-040607-manual\n", "20261340-999999-manual"} {
		if ValidID(bad) {
			if _, _, ok := IDTime(bad); ok {
				t.Errorf("%q accepted", bad)
			}
		}
	}
	if ValidID("20260304-040607-manual/..") || ValidID(`..\20260304-040607-manual`) {
		t.Fatal("a path was accepted as an id")
	}
}

func TestListAndSweep(t *testing.T) {
	dir := t.TempDir()
	server := sampleServer(t)
	plan, _ := MakePlan(context.Background(), server)
	comment, _ := ASCIIJSON(Manifest{Format: 1, FileCount: len(plan.Files), TotalBytes: plan.TotalBytes, MinecraftVersion: "1.21", WhileRunning: true})
	for _, id := range []string{"20260101-000000-manual", "20260102-000000-pre-restore"} {
		if err := Write(context.Background(), plan, filepath.Join(dir, id+".zip"), comment, nil); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(dir, "notes.zip"), "x")
	writeFile(t, filepath.Join(dir, "20260103-000000-manual.zip.part"), "half")

	if list, err := List(filepath.Join(dir, "missing"), "s"); err != nil || len(list) != 0 {
		t.Fatalf("missing dir: %v %v", list, err)
	}
	list, err := List(dir, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != "20260102-000000-pre-restore" || list[1].Kind != "manual" {
		t.Fatalf("list = %+v", list)
	}
	if list[0].FileCount != 4 || list[0].MinecraftVersion != "1.21" || list[0].WhileRunning == nil || !*list[0].WhileRunning {
		t.Fatalf("manifest not read: %+v", list[0])
	}
	SweepPartials(dir)
	if _, err := os.Stat(filepath.Join(dir, "20260103-000000-manual.zip.part")); !os.IsNotExist(err) {
		t.Fatal("the partial archive is still there")
	}
}

func TestSaveLines(t *testing.T) {
	off := map[string]string{
		"[12:00:00] [Server thread/INFO]: Automatic saving is now disabled":          "disabled",
		"[12:00:00 INFO]: Automatic saving is now disabled":                          "disabled",
		"[12:00:00] [Server thread/INFO]: Turned off world auto-saving":              "disabled",
		"[12:00:00] [Server thread/INFO]: Saving is already turned off":              "already-off",
		"[12:00:00] [Server thread/INFO]: <Steve> Automatic saving is now disabled":  "",
		"[12:00:00] [Server thread/INFO]: [Server] Automatic saving is now disabled": "",
		"[12:00:00] [Server thread/INFO]: [Not Secure] <Steve> Saved the game":       "",
		"Automatic saving is now disabled":                                           "",
		"[12:00:00] [Server thread/INFO]: Automatic saving is now disabled and more": "",
	}
	for line, want := range off {
		if got := SaveOffAnswer(line); got != want {
			t.Errorf("SaveOffAnswer(%q) = %q, want %q", line, got, want)
		}
	}
	done := map[string]bool{
		"[12:00:00] [Server thread/INFO]: Saved the game":          true,
		"[12:00:00 INFO]: Saved the world":                         true,
		"[12:00:00] [Server thread/INFO]: Saved the game  ":        true,
		"[12:00:00] [Server thread/INFO]: <Steve> Saved the game":  false,
		"[12:00:00] [Server thread/INFO]: [Server] Saved the game": false,
		"[12:00:00] [Server thread/INFO]: Saving the game":         false,
	}
	for line, want := range done {
		if got := IsSaveFinished(line); got != want {
			t.Errorf("IsSaveFinished(%q) = %v, want %v", line, got, want)
		}
	}
}
