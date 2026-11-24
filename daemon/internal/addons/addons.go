// Package addons manages the plugins of a server: what is in its plugins
// folder, turning one off and on, removing one, and installing one from
// Modrinth.
//
// The folder is the list. A jar somebody copied in by hand, or one a restored
// backup brought back, is a plugin like any other; what this package knows
// about where a file came from (kept in a small file next to the jars) is an
// addition to that, never the source of it.
package addons

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// ErrNotFound says that the folder has no such plugin.
var ErrNotFound = errors.New("plugin not found")

// disabledSuffix is added to the name of a jar the server must not load.
const disabledSuffix = ".disabled"

// originsFile is where the origin of the installed files is kept. The server
// ignores it: it loads jars only.
const originsFile = ".msmd-addons.json"

// Dir is the folder, inside a server's own, that a platform loads its plugins
// from. ok is false for platforms whose add-ons this package does not manage.
func Dir(platform string) (dir string, ok bool) {
	switch platform {
	case "paper", "purpur", "folia":
		return "plugins", true
	}
	return "", false
}

// compatibleLoaders are the Modrinth loader tags whose plugins run on a
// platform. Paper and Purpur load anything built for Bukkit, Spigot or Paper;
// Folia only what declares Folia support.
func compatibleLoaders(platform string) []string {
	switch platform {
	case "paper", "purpur":
		return []string{"paper", "purpur", "spigot", "bukkit"}
	case "folia":
		return []string{"folia"}
	}
	return nil
}

// Info is one plugin in a server's folder.
type Info struct {
	// File is the name of the jar, without the suffix of a disabled one. It
	// is what the plugin is called by in every request.
	File       string `json:"file"`
	Enabled    bool   `json:"enabled"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt"`
	// Name and Version are what the jar says of itself, when it does.
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	// ProjectID and VersionID are set for a file installed from Modrinth.
	ProjectID string `json:"projectId,omitempty"`
	VersionID string `json:"versionId,omitempty"`
}

// origin is where an installed file came from.
type origin struct {
	ProjectID string `json:"projectId"`
	VersionID string `json:"versionId"`
	SHA512    string `json:"sha512"`
	SizeBytes int64  `json:"sizeBytes"`
}

var (
	fileNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+()\[\] -]{0,120}\.jar$`)
	reservedRE = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])$`)
)

// ValidFileName reports whether name can be the name of a plugin's jar: a
// plain file name, of characters every file system takes, ending in ".jar".
// Names come from Modrinth and from requests; neither chooses a path.
func ValidFileName(name string) bool {
	if !fileNameRE.MatchString(name) || strings.Contains(name, "..") {
		return false
	}
	// Windows keeps some names for devices, whatever follows the first dot.
	stem, _, _ := strings.Cut(name, ".")
	return !reservedRE.MatchString(strings.TrimSpace(stem))
}

// entry is a plugin file as found in the folder.
type entry struct {
	file    string // without the disabled suffix
	onDisk  string
	enabled bool
	info    os.FileInfo
}

// scan returns the plugin files of dir: regular files directly in it that are
// called like a jar, loaded or disabled. A folder that does not exist has none.
func scan(dir string) ([]entry, error) {
	list, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("the plugins folder could not be read: %w", plain(err))
	}
	var out []entry
	for _, de := range list {
		onDisk := de.Name()
		file, disabled := strings.CutSuffix(onDisk, disabledSuffix)
		if !ValidFileName(file) {
			continue
		}
		// Lstat: a link is not followed out of the folder.
		info, err := os.Lstat(filepath.Join(dir, onDisk))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, entry{file: file, onDisk: onDisk, enabled: !disabled, info: info})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].file), strings.ToLower(out[j].file)
		if a != b {
			return a < b
		}
		// The same jar both loaded and disabled (done by hand): loaded first.
		return out[i].enabled && !out[j].enabled
	})
	return out, nil
}

// find returns the file of a plugin; of a jar that is there both loaded and
// disabled, the loaded one.
func find(dir, file string) (entry, error) {
	if !ValidFileName(file) {
		return entry{}, ErrNotFound
	}
	list, err := scan(dir)
	if err != nil {
		return entry{}, err
	}
	for _, e := range list {
		if e.file == file {
			return e, nil
		}
	}
	return entry{}, ErrNotFound
}

func readOrigins(dir string) map[string]origin {
	out := map[string]origin{}
	b, err := os.ReadFile(filepath.Join(dir, originsFile))
	if err != nil {
		return out
	}
	// A file that cannot be read is no reason to fail: origins are an extra.
	_ = json.Unmarshal(b, &out)
	if out == nil {
		out = map[string]origin{}
	}
	return out
}

func writeOrigins(dir string, origins map[string]origin) error {
	b, err := json.MarshalIndent(origins, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, originsFile+".tmp")
	f, err := createNew(tmp)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, originsFile))
}

// createNew makes a file that this call creates: whatever has that name (a
// leftover, or a link somebody put there to have another file written to) is
// removed first, and the file is not opened if something takes its place.
func createNew(path string) (*os.File, error) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
}

// plain is an error of the file system without the path it happened at: the
// path is the host's business, the reason is the caller's.
func plain(err error) error {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return linkErr.Err
	}
	return err
}

// forgetOrigin drops what is known of a file that is gone.
func forgetOrigin(dir, file string) {
	origins := readOrigins(dir)
	if _, ok := origins[file]; !ok {
		return
	}
	delete(origins, file)
	_ = writeOrigins(dir, origins)
}

// List returns the plugins in dir, by name.
func List(dir string) ([]Info, error) {
	entries, err := scan(dir)
	if err != nil {
		return nil, err
	}
	origins := readOrigins(dir)
	out := make([]Info, 0, len(entries))
	for _, e := range entries {
		info := Info{
			File:       e.file,
			Enabled:    e.enabled,
			SizeBytes:  e.info.Size(),
			ModifiedAt: e.info.ModTime().UTC().Format(time.RFC3339),
		}
		info.Name, info.Version = describe(filepath.Join(dir, e.onDisk))
		// An origin is believed only for the file it was recorded for: one
		// of another size, put there by hand under the same name, is not it.
		if o, ok := origins[e.file]; ok && o.SizeBytes == e.info.Size() {
			info.ProjectID, info.VersionID = o.ProjectID, o.VersionID
		}
		out = append(out, info)
	}
	return out, nil
}

// SetEnabled turns a plugin on or off, by the name of its file: a disabled
// jar carries a suffix the server does not load.
func SetEnabled(dir, file string, enabled bool) error {
	e, err := find(dir, file)
	if err != nil {
		return err
	}
	if e.enabled == enabled {
		return nil
	}
	target := file
	if !enabled {
		target += disabledSuffix
	}
	if _, err := os.Lstat(filepath.Join(dir, target)); err == nil {
		return fmt.Errorf("%s is already in the folder", target)
	}
	if err := os.Rename(filepath.Join(dir, e.onDisk), filepath.Join(dir, target)); err != nil {
		return fmt.Errorf("the plugin's file could not be renamed: %w", plain(err))
	}
	return nil
}

// Remove deletes a plugin's jar. What the plugin wrote (its folder of
// settings and data) stays.
func Remove(dir, file string) error {
	e, err := find(dir, file)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, e.onDisk)); err != nil {
		return fmt.Errorf("the plugin's file could not be deleted: %w", plain(err))
	}
	// The same jar may also be there in its other state; then it is still
	// installed.
	if _, err := find(dir, file); err != nil {
		forgetOrigin(dir, file)
	}
	return nil
}

// descriptorLimit is how much of a plugin's descriptor is read.
const descriptorLimit = 64 << 10

var descriptorLineRE = regexp.MustCompile(`^(name|version)\s*:\s*(.+?)\s*$`)

// describe reads the name and the version a plugin's jar declares, from its
// paper-plugin.yml or plugin.yml. Both are optional: a jar that cannot be
// read, or that is no plugin, has neither.
func describe(path string) (name, version string) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", ""
	}
	defer zr.Close()
	for _, want := range []string{"paper-plugin.yml", "plugin.yml"} {
		for _, f := range zr.File {
			if f.Name != want {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(io.LimitReader(rc, descriptorLimit))
			rc.Close()
			name, version = parseDescriptor(string(b))
			if name != "" {
				return name, version
			}
			break
		}
	}
	return "", ""
}

// parseDescriptor takes the top-level "name" and "version" of a descriptor.
// It reads those two lines and nothing else of the YAML.
func parseDescriptor(text string) (name, version string) {
	for _, line := range strings.Split(text, "\n") {
		m := descriptorLineRE.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		value := cleanValue(m[2])
		if m[1] == "name" && name == "" {
			name = value
		} else if m[1] == "version" && version == "" {
			version = value
		}
	}
	return name, version
}

// cleanValue makes a value of a descriptor fit to show: without its quotes or
// a trailing comment, of printable characters, and short.
func cleanValue(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
		if end := strings.IndexByte(v[1:], v[0]); end >= 0 {
			v = v[1 : 1+end]
		}
	} else if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	v = strings.Map(func(r rune) rune {
		if !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(v))
	if r := []rune(v); len(r) > 80 {
		v = string(r[:80])
	}
	return v
}
