package addons

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// installed puts version V1 of project P1 in a new folder, as the host would.
func installed(t *testing.T, m *modrinth, dir string) {
	t.Helper()
	v, err := Resolve(context.Background(), "V1")
	if err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), dir, v, nil); err != nil {
		t.Fatal(err)
	}
}

// resolveNew resolves V2 of P1, which is "X.jar" unless the test changes it.
func resolveNew(t *testing.T, m *modrinth, id string) Version {
	t.Helper()
	v, err := Resolve(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestUpdateReplacesTheJar(t *testing.T) {
	m := fakeModrinth(t)
	c1 := jar(t, "plugin.yml", "name: X\nversion: 1\n")
	c2 := jar(t, "plugin.yml", "name: X\nversion: 2\n")
	m.version(t, "V1", "P1", "X.jar", c1, []string{"paper"}, nil)
	m.version(t, "V2", "P1", "X.jar", c2, []string{"paper"}, nil)
	dir := t.TempDir()
	installed(t, m, dir)

	if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V2"), nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "X.jar")); string(b) != string(c2) {
		t.Errorf("the folder holds the old jar after the update")
	}
	list, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].VersionID != "V2" || !list[0].Enabled {
		t.Errorf("list after update = %+v", list)
	}
	if got := names(t, dir); got != originsFile+" X.jar" {
		t.Errorf("folder after update: %s", got)
	}
}

func TestUpdateKeepsAPluginOff(t *testing.T) {
	m := fakeModrinth(t)
	m.version(t, "V1", "P1", "X.jar", jar(t, "plugin.yml", "name: X\n"), []string{"paper"}, nil)
	m.version(t, "V2", "P1", "X.jar", jar(t, "plugin.yml", "name: X\nversion: 2\n"), []string{"paper"}, nil)
	dir := t.TempDir()
	installed(t, m, dir)
	if err := SetEnabled(dir, "X.jar", false); err != nil {
		t.Fatal(err)
	}

	if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V2"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "X.jar")); err == nil {
		t.Error("the update turned the plugin on")
	}
	list, _ := List(dir)
	if len(list) != 1 || list[0].Enabled || list[0].VersionID != "V2" {
		t.Errorf("list after update = %+v", list)
	}
}

func TestUpdateRemovesEveryCopyOfTheOldJar(t *testing.T) {
	m := fakeModrinth(t)
	m.version(t, "V1", "P1", "X.jar", jar(t, "plugin.yml", "name: X\n"), []string{"paper"}, nil)
	m.version(t, "V2", "P1", "X.jar", jar(t, "plugin.yml", "name: X\nversion: 2\n"), []string{"paper"}, nil)
	dir := t.TempDir()
	installed(t, m, dir)
	// The same jar also there in its other state, put in by hand.
	put(t, filepath.Join(dir, "X.jar.disabled"), jar(t, "plugin.yml", "name: X\n"))

	if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V2"), nil); err != nil {
		t.Fatal(err)
	}
	if got := names(t, dir); got != originsFile+" X.jar" {
		t.Errorf("folder after update: %s", got)
	}
}

func TestUpdateRefusesWhatIsNotAnUpdate(t *testing.T) {
	m := fakeModrinth(t)
	m.version(t, "V1", "P1", "X.jar", jar(t, "plugin.yml", "name: X\n"), []string{"paper"}, nil)
	m.version(t, "V2", "P1", "X.jar", jar(t, "plugin.yml", "name: X\nversion: 2\n"), []string{"paper"}, nil)
	m.version(t, "VX", "P2", "X.jar", jar(t, "plugin.yml", "name: Other\n"), []string{"paper"}, nil)
	m.version(t, "VY", "P1", "Y.jar", jar(t, "plugin.yml", "name: Y\n"), []string{"paper"}, nil)
	m.version(t, "V1B", "P1", "X.jar", jar(t, "plugin.yml", "name: X\n"), []string{"paper"}, func(f *fakeFile) {
		f.URL = "https://cdn.modrinth.com/data/P1/versions/V1B/nothing-there.jar"
	})

	t.Run("the same version", func(t *testing.T) {
		dir := t.TempDir()
		installed(t, m, dir)
		if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V1"), nil); err == nil {
			t.Error("updated to the version that is installed")
		}
	})

	t.Run("another project", func(t *testing.T) {
		dir := t.TempDir()
		installed(t, m, dir)
		before, _ := os.ReadFile(filepath.Join(dir, "X.jar"))
		if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "VX"), nil); err == nil {
			t.Error("replaced a plugin of another project")
		}
		if after, _ := os.ReadFile(filepath.Join(dir, "X.jar")); string(after) != string(before) {
			t.Error("the plugin changed")
		}
	})

	t.Run("copied by hand", func(t *testing.T) {
		dir := t.TempDir()
		put(t, filepath.Join(dir, "X.jar"), jar(t, "plugin.yml", "name: X\n"))
		if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V2"), nil); err == nil {
			t.Error("updated a plugin that was not installed from Modrinth")
		}
		if got := names(t, dir); got != "X.jar" {
			t.Errorf("folder: %s", got)
		}
	})

	t.Run("a name another plugin has", func(t *testing.T) {
		dir := t.TempDir()
		installed(t, m, dir)
		put(t, filepath.Join(dir, "Y.jar"), jar(t, "plugin.yml", "name: Y\n"))
		if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "VY"), nil); err == nil {
			t.Error("took the name of a plugin that is there")
		}
		if _, err := os.Stat(filepath.Join(dir, "X.jar")); err != nil {
			t.Errorf("the old jar is gone: %v", err)
		}
	})

	t.Run("a failed download keeps the old jar", func(t *testing.T) {
		dir := t.TempDir()
		installed(t, m, dir)
		before, _ := os.ReadFile(filepath.Join(dir, "X.jar"))
		if err := Update(context.Background(), dir, "X.jar", resolveNew(t, m, "V1B"), nil); err == nil {
			t.Error("a version whose file cannot be had was installed")
		}
		if after, _ := os.ReadFile(filepath.Join(dir, "X.jar")); string(after) != string(before) {
			t.Error("the old jar changed after a failed download")
		}
		if got := names(t, dir); got != originsFile+" X.jar" {
			t.Errorf("folder after failed update: %s", got)
		}
	})
}
