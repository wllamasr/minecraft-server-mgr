// Package modpack applies a Modrinth .mrpack to a server directory: it installs
// the exact loader the pack pins, downloads the server-relevant files, and lays
// down the pack's config overrides. Standard library only (archive/zip).
package modpack

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/httpx"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/loader"
)

type mrpackFile struct {
	Path      string   `json:"path"`
	Downloads []string `json:"downloads"`
	Env       struct {
		Client string `json:"client"`
		Server string `json:"server"`
	} `json:"env"`
}

type mrpackIndex struct {
	Name         string            `json:"name"`
	VersionID    string            `json:"versionId"`
	Dependencies map[string]string `json:"dependencies"`
	Files        []mrpackFile      `json:"files"`
}

// Result reports what the pack resolved to, so the caller can persist it.
type Result struct {
	MinecraftVersion string
	Loader           string
	LoaderVersion    string
	ModCount         int
}

// MrpackHost is where Modrinth serves .mrpack files from.
const MrpackHost = "cdn.modrinth.com"

// FileHosts are the hosts a .mrpack may download its files from: the list the
// Modrinth pack format defines. Modrinth rejects packs that point elsewhere.
var FileHosts = []string{MrpackHost, "github.com", "raw.githubusercontent.com", "gitlab.com"}

// plainHTTPSHost returns the host of a plain https URL (default port, no
// credentials), or "" for anything else.
func plainHTTPSHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Opaque != "" {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// ValidMrpackURL reports whether raw may be deployed from. The daemon downloads
// that URL, and only Modrinth is supported, so only its CDN is accepted: a
// create request must not be a way to make the host fetch an arbitrary address.
func ValidMrpackURL(raw string) bool { return plainHTTPSHost(raw) == MrpackHost }

// allowedFileURL reports whether a file listed in a pack may come from raw.
func allowedFileURL(raw string) bool {
	host := plainHTTPSHost(raw)
	if host == "" {
		return false
	}
	for _, h := range FileHosts {
		if host == h {
			return true
		}
	}
	return false
}

// pickDownload returns the first URL on an allowed host, or "".
func pickDownload(urls []string) string {
	for _, u := range urls {
		if allowedFileURL(u) {
			return u
		}
	}
	return ""
}

// Apply downloads and installs a .mrpack into serverDir.
func Apply(serverDir, mrpackURL, javaPath string, emit func(string)) (Result, error) {
	if !ValidMrpackURL(mrpackURL) {
		return Result{}, fmt.Errorf("modpacks can only be downloaded from https://%s", MrpackHost)
	}
	mrpackPath := filepath.Join(serverDir, "modpack.mrpack")
	emit("Downloading modpack index (.mrpack)...")
	if err := httpx.Download(mrpackURL, mrpackPath); err != nil {
		return Result{}, err
	}
	defer os.Remove(mrpackPath)

	zr, err := zip.OpenReader(mrpackPath)
	if err != nil {
		return Result{}, err
	}
	defer zr.Close()

	index, err := readIndex(zr)
	if err != nil {
		return Result{}, err
	}

	mc, loaderType, loaderVersion := resolveLoader(index.Dependencies)
	if mc == "" {
		return Result{}, fmt.Errorf("modpack does not declare a Minecraft version")
	}

	if loaderType != "" && loaderVersion != "" {
		emit(fmt.Sprintf("Installing %s %s for MC %s...", loaderType, loaderVersion, mc))
		if err := loader.Install(loader.Type(loaderType), loaderVersion, mc, serverDir, javaPath, emit); err != nil {
			return Result{}, err
		}
	}

	serverRoot, _ := filepath.Abs(serverDir)
	modCount := 0
	files := index.Files
	emit(fmt.Sprintf("Downloading %d modpack file(s)...", len(files)))
	for i, f := range files {
		if f.Env.Server == "unsupported" {
			continue
		}
		if isUnsafeRel(f.Path) {
			emit("Skipping unsafe path in modpack: " + f.Path)
			continue
		}
		if len(f.Downloads) == 0 {
			emit("No download URL for " + f.Path)
			continue
		}
		dest := filepath.Join(serverDir, f.Path)
		if abs, _ := filepath.Abs(dest); !strings.HasPrefix(abs, serverRoot) {
			emit("Skipping path escaping server directory: " + f.Path)
			continue
		}
		// The pack names where each file comes from; only the hosts the pack
		// format allows are fetched.
		source := pickDownload(f.Downloads)
		if source == "" {
			return Result{}, fmt.Errorf("modpack file %s is not hosted on an allowed site (%s)", f.Path, strings.Join(FileHosts, ", "))
		}
		emit(fmt.Sprintf("  [%d/%d] %s", i+1, len(files), f.Path))
		if err := httpx.Download(source, dest); err != nil {
			return Result{}, err
		}
		if strings.HasPrefix(f.Path, "mods/") {
			modCount++
		}
	}

	applyOverrides(zr, "overrides", serverDir, serverRoot, emit)
	applyOverrides(zr, "server-overrides", serverDir, serverRoot, emit)

	emit(fmt.Sprintf("Modpack applied: %d mod(s), MC %s%s.", modCount, mc, loaderSuffix(loaderType, loaderVersion)))
	return Result{MinecraftVersion: mc, Loader: loaderType, LoaderVersion: loaderVersion, ModCount: modCount}, nil
}

func readIndex(zr *zip.ReadCloser) (mrpackIndex, error) {
	for _, f := range zr.File {
		if f.Name == "modrinth.index.json" {
			rc, err := f.Open()
			if err != nil {
				return mrpackIndex{}, err
			}
			defer rc.Close()
			var idx mrpackIndex
			if err := json.NewDecoder(rc).Decode(&idx); err != nil {
				return mrpackIndex{}, err
			}
			return idx, nil
		}
	}
	return mrpackIndex{}, fmt.Errorf("invalid .mrpack: modrinth.index.json not found")
}

func resolveLoader(deps map[string]string) (mc, loaderType, loaderVersion string) {
	mc = deps["minecraft"]
	switch {
	case deps["fabric-loader"] != "":
		return mc, "fabric", deps["fabric-loader"]
	case deps["quilt-loader"] != "":
		return mc, "quilt", deps["quilt-loader"]
	case deps["neoforge"] != "":
		return mc, "neoforge", deps["neoforge"]
	case deps["forge"] != "":
		return mc, "forge", deps["forge"]
	}
	return mc, "", ""
}

func applyOverrides(zr *zip.ReadCloser, prefix, serverDir, serverRoot string, emit func(string)) {
	count := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !strings.HasPrefix(f.Name, prefix+"/") {
			continue
		}
		rel := strings.TrimPrefix(f.Name, prefix+"/")
		if isUnsafeRel(rel) {
			continue
		}
		dest := filepath.Join(serverDir, rel)
		if abs, _ := filepath.Abs(dest); !strings.HasPrefix(abs, serverRoot) {
			continue
		}
		if err := extractFile(f, dest); err == nil {
			count++
		}
	}
	if count > 0 {
		emit(fmt.Sprintf("Applied %d file(s) from %s/.", count, prefix))
	}
}

func extractFile(f *zip.File, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o750); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

// isUnsafeRel rejects absolute, drive-qualified, or traversing paths.
func isUnsafeRel(p string) bool {
	if strings.TrimSpace(p) == "" {
		return true
	}
	n := strings.ReplaceAll(p, "\\", "/")
	if strings.HasPrefix(n, "/") {
		return true
	}
	if len(n) >= 2 && n[1] == ':' {
		return true
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func loaderSuffix(loaderType, loaderVersion string) string {
	if loaderType == "" {
		return ""
	}
	return fmt.Sprintf(" + %s %s", loaderType, loaderVersion)
}
