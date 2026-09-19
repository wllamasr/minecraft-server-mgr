// Package java detects usable JDKs on the host and, when none is compatible
// with the requested Minecraft version, downloads and installs an Eclipse
// Temurin JDK into the daemon's data directory. It uses only the standard
// library (archive/tar, archive/zip, compress/gzip).
package java

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/httpx"
)

// Installation is a discovered JDK.
type Installation struct {
	Path    string // path to the java binary
	Major   int
	Version string
}

// RequiredMajor returns the minimum Java major version for a Minecraft version.
func RequiredMajor(mcVersion string) int {
	parts := strings.Split(mcVersion, ".")
	minor, patch := 0, 0
	if len(parts) > 1 {
		minor, _ = strconv.Atoi(parts[1])
	}
	if len(parts) > 2 {
		patch, _ = strconv.Atoi(digits(parts[2]))
	}
	switch {
	case minor > 21, minor == 21:
		return 21
	case minor == 20 && patch >= 5:
		return 21
	case minor >= 17:
		return 17
	default:
		return 8
	}
}

// Manager resolves and installs JDKs, caching results by major version.
type Manager struct {
	dir   string // where JDKs are installed
	fixed string // explicit java binary override (skips detection)
	mu    sync.Mutex
	cache map[int]string
}

// New builds a Manager. When fixed is non-empty it is always used as-is.
func New(dir, fixed string) *Manager {
	return &Manager{dir: dir, fixed: fixed, cache: map[int]string{}}
}

// Ensure returns a java binary path compatible with the given Minecraft
// version, installing a Temurin JDK if the host has none. emit (nil-safe)
// receives human-readable progress lines.
func (m *Manager) Ensure(mcVersion string, emit func(string)) (string, error) {
	if m.fixed != "" {
		return m.fixed, nil
	}
	required := RequiredMajor(mcVersion)

	m.mu.Lock()
	defer m.mu.Unlock()

	if p, ok := m.cache[required]; ok {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		delete(m.cache, required)
	}

	if best := findBest(required, m.detect()); best != nil {
		emitf(emit, "Using Java %d found at %s", best.Major, best.Path)
		m.cache[required] = best.Path
		return best.Path, nil
	}

	emitf(emit, "No compatible Java found — installing Temurin JDK %d...", required)
	path, err := m.install(required, emit)
	if err != nil {
		return "", fmt.Errorf("automatic Java %d install failed: %w", required, err)
	}
	m.cache[required] = path
	emitf(emit, "Installed Java %d at %s", required, path)
	return path, nil
}

// Detect returns all JDKs discovered on the host (used by /v1/info).
func (m *Manager) Detect() []Installation { return m.detect() }

// ─── detection ─────────────────────────────────────────────

func (m *Manager) detect() []Installation {
	seen := map[string]bool{}
	var found []Installation
	add := func(p string) {
		if p == "" {
			return
		}
		abs, _ := filepath.Abs(p)
		if seen[abs] {
			return
		}
		seen[abs] = true
		if inst := probe(abs); inst != nil {
			found = append(found, *inst)
		}
	}

	exe := javaExe()
	if home := os.Getenv("JAVA_HOME"); home != "" {
		add(filepath.Join(home, "bin", exe))
	}
	if p, err := exec.LookPath(exe); err == nil {
		add(p)
	}
	for _, root := range candidateRoots(m.dir) {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				add(filepath.Join(root, e.Name(), "bin", exe))
			}
		}
	}
	return found
}

func candidateRoots(installDir string) []string {
	roots := []string{installDir}
	if runtime.GOOS == "windows" {
		return append(roots,
			`C:\Program Files\Java`,
			`C:\Program Files\Eclipse Adoptium`,
			`C:\Program Files\Microsoft`,
			`C:\Program Files\Zulu`,
		)
	}
	return append(roots,
		"/usr/lib/jvm",
		"/usr/java",
		"/opt/java",
		"/opt",
		filepath.Join(os.Getenv("HOME"), ".sdkman/candidates/java"),
	)
}

var versionRe = regexp.MustCompile(`version "([^"]+)"`)

func probe(path string) *Installation {
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	cmd := exec.Command(path, "-version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil
	}
	mm := versionRe.FindStringSubmatch(string(out))
	if len(mm) < 2 {
		return nil
	}
	version := mm[1]
	major := 0
	if strings.HasPrefix(version, "1.") {
		fields := strings.Split(version, ".")
		if len(fields) > 1 {
			major, _ = strconv.Atoi(fields[1])
		}
	} else {
		major, _ = strconv.Atoi(digits(strings.Split(version, ".")[0]))
	}
	if major == 0 {
		return nil
	}
	return &Installation{Path: path, Major: major, Version: version}
}

func findBest(required int, installs []Installation) *Installation {
	var ok []Installation
	for _, in := range installs {
		if in.Major >= required {
			ok = append(ok, in)
		}
	}
	if len(ok) == 0 {
		return nil
	}
	sort.Slice(ok, func(i, j int) bool { return ok[i].Major > ok[j].Major })
	return &ok[0]
}

// ─── installation (Adoptium Temurin) ───────────────────────

func (m *Manager) install(major int, emit func(string)) (string, error) {
	osName, arch := adoptiumOSArch()
	url := fmt.Sprintf(
		"https://api.adoptium.net/v3/binary/latest/%d/ga/%s/%s/jdk/hotspot/normal/eclipse",
		major, osName, arch,
	)

	emitf(emit, "Downloading JDK %d (%s/%s) from Eclipse Temurin...", major, osName, arch)

	dest := filepath.Join(m.dir, fmt.Sprintf("temurin-%d", major))
	_ = os.RemoveAll(dest)
	if err := os.MkdirAll(dest, 0o750); err != nil {
		return "", err
	}

	archive := filepath.Join(dest, "download.archive")
	if err := httpx.Download(url, archive); err != nil {
		return "", err
	}
	defer os.Remove(archive)

	f, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer f.Close()

	var top string
	if runtime.GOOS == "windows" {
		top, err = extractZip(f, dest)
	} else {
		top, err = extractTarGz(f, dest)
	}
	if err != nil {
		return "", err
	}

	javaBin := filepath.Join(dest, top, "bin", javaExe())
	if _, err := os.Stat(javaBin); err != nil {
		// Fallback: search for the binary (layout varies, e.g. macOS).
		javaBin = findJavaBinary(dest)
		if javaBin == "" {
			return "", fmt.Errorf("java binary not found after extraction")
		}
	}
	return javaBin, nil
}

func adoptiumOSArch() (string, string) {
	osName := runtime.GOOS
	if osName == "darwin" {
		osName = "mac"
	}
	arch := "x64"
	switch runtime.GOARCH {
	case "arm64":
		arch = "aarch64"
	case "arm":
		arch = "arm"
	}
	return osName, arch
}

// extractTarGz unpacks a .tar.gz stream and returns the top-level directory.
func extractTarGz(r io.Reader, dest string) (string, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return "", err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	top := ""
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		rel := cleanRel(hdr.Name)
		if rel == "" {
			continue
		}
		if top == "" {
			top = firstSegment(rel)
		}
		target := filepath.Join(dest, rel)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o750); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
				return "", err
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(hdr.Mode)&0o777)
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return "", err
			}
			out.Close()
		case tar.TypeSymlink:
			// JDK archives contain relative symlinks (e.g. man pages); best-effort.
			_ = os.Symlink(hdr.Linkname, target)
		}
	}
	return top, nil
}

// extractZip unpacks a .zip stream and returns the top-level directory.
func extractZip(r io.Reader, dest string) (string, error) {
	// zip needs a ReaderAt; buffer to a temp file.
	tmp, err := os.CreateTemp("", "temurin-*.zip")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, r)
	if err != nil {
		tmp.Close()
		return "", err
	}
	tmp.Close()

	zr, err := zip.OpenReader(tmp.Name())
	if err != nil {
		return "", err
	}
	defer zr.Close()
	_ = size

	top := ""
	for _, f := range zr.File {
		rel := cleanRel(f.Name)
		if rel == "" {
			continue
		}
		if top == "" {
			top = firstSegment(rel)
		}
		target := filepath.Join(dest, rel)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return "", err
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		mode := f.Mode()
		if mode == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode&0o777)
		if err != nil {
			rc.Close()
			return "", err
		}
		if _, err := io.Copy(out, rc); err != nil {
			out.Close()
			rc.Close()
			return "", err
		}
		out.Close()
		rc.Close()
	}
	return top, nil
}

func findJavaBinary(root string) string {
	want := javaExe()
	var found string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || found != "" || d.IsDir() {
			return nil
		}
		if d.Name() == want && filepath.Base(filepath.Dir(p)) == "bin" {
			found = p
		}
		return nil
	})
	return found
}

// ─── helpers ───────────────────────────────────────────────

func javaExe() string {
	if runtime.GOOS == "windows" {
		return "java.exe"
	}
	return "java"
}

// cleanRel rejects paths that would escape the destination (zip-slip / tar-slip).
func cleanRel(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.TrimPrefix(name, "./")
	if name == "" || strings.HasPrefix(name, "/") {
		return ""
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return ""
		}
	}
	return name
}

func firstSegment(rel string) string {
	if i := strings.IndexByte(rel, '/'); i >= 0 {
		return rel[:i]
	}
	return rel
}

func digits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}

func emitf(emit func(string), format string, a ...any) {
	if emit != nil {
		emit(fmt.Sprintf(format, a...))
	}
}
