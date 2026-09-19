// Package loader installs Minecraft mod loaders (Fabric, Quilt, Forge,
// NeoForge) into a server directory by fetching and running each project's
// official installer with the host's Java.
package loader

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/httpx"
)

// Type is a supported mod loader.
type Type string

const (
	Fabric   Type = "fabric"
	Quilt    Type = "quilt"
	Forge    Type = "forge"
	NeoForge Type = "neoforge"
)

// Valid reports whether s is a supported loader.
func Valid(s string) bool {
	switch Type(s) {
	case Fabric, Quilt, Forge, NeoForge:
		return true
	}
	return false
}

// Version is one selectable loader version.
type Version struct {
	Version string `json:"version"`
	Stable  bool   `json:"stable"`
}

const installTimeout = 5 * time.Minute

// Install fetches and runs the loader's installer inside serverDir.
func Install(loader Type, loaderVersion, mcVersion, serverDir, javaPath string, emit func(string)) error {
	switch loader {
	case Fabric:
		return installFabric(loaderVersion, mcVersion, serverDir, javaPath, emit)
	case Quilt:
		return installQuilt(loaderVersion, mcVersion, serverDir, javaPath, emit)
	case Forge:
		return installForge(loaderVersion, mcVersion, serverDir, javaPath, emit)
	case NeoForge:
		return installNeoForge(loaderVersion, serverDir, javaPath, emit)
	default:
		return fmt.Errorf("unknown mod loader: %s", loader)
	}
}

// Versions lists available loader versions for a Minecraft version.
func Versions(loader Type, mcVersion string) ([]Version, error) {
	switch loader {
	case Fabric:
		return fabricLoaderVersions()
	case Quilt:
		return quiltLoaderVersions()
	case Forge:
		return forgeVersions(mcVersion)
	case NeoForge:
		return neoforgeVersions(mcVersion)
	default:
		return nil, fmt.Errorf("unknown mod loader: %s", loader)
	}
}

// ─── Fabric ────────────────────────────────────────────────

func fabricLoaderVersions() ([]Version, error) {
	var data []struct {
		Version string `json:"version"`
		Stable  bool   `json:"stable"`
	}
	if err := httpx.GetJSON("https://meta.fabricmc.net/v2/versions/loader", &data); err != nil {
		return nil, err
	}
	out := make([]Version, 0, 20)
	for i, v := range data {
		if i >= 20 {
			break
		}
		out = append(out, Version{Version: v.Version, Stable: v.Stable})
	}
	return out, nil
}

func installFabric(loaderVersion, mcVersion, dir, java string, emit func(string)) error {
	var installers []struct {
		URL     string `json:"url"`
		Version string `json:"version"`
		Stable  bool   `json:"stable"`
	}
	if err := httpx.GetJSON("https://meta.fabricmc.net/v2/versions/installer", &installers); err != nil {
		return err
	}
	if len(installers) == 0 {
		return fmt.Errorf("no fabric installer available")
	}
	pick := installers[0]
	for _, i := range installers {
		if i.Stable {
			pick = i
			break
		}
	}
	url := pick.URL
	if url == "" {
		url = fmt.Sprintf("https://maven.fabricmc.net/net/fabricmc/fabric-installer/%s/fabric-installer-%s.jar", pick.Version, pick.Version)
	}

	installer := filepath.Join(dir, "fabric-installer.jar")
	if err := httpx.Download(url, installer); err != nil {
		return err
	}
	defer os.Remove(installer)

	emit("Running Fabric installer...")
	return runJar(java, installer, dir, emit,
		"server", "-mcversion", mcVersion, "-loader", loaderVersion, "-dir", dir, "-downloadMinecraft")
}

// ─── Quilt ─────────────────────────────────────────────────

func quiltLoaderVersions() ([]Version, error) {
	var data []struct {
		Version string `json:"version"`
	}
	if err := httpx.GetJSON("https://meta.quiltmc.org/v3/versions/loader", &data); err != nil {
		return nil, err
	}
	out := make([]Version, 0, 20)
	for i, v := range data {
		if i >= 20 {
			break
		}
		out = append(out, Version{Version: v.Version, Stable: false})
	}
	return out, nil
}

func installQuilt(loaderVersion, mcVersion, dir, java string, emit func(string)) error {
	installer := filepath.Join(dir, "quilt-installer.jar")
	if err := httpx.Download("https://quiltmc.org/api/v1/download-latest-installer/java-universal", installer); err != nil {
		return err
	}
	defer os.Remove(installer)

	emit("Running Quilt installer...")
	return runJar(java, installer, dir, emit,
		"install", "server", mcVersion, loaderVersion, "--download-server", "--install-dir="+dir)
}

// ─── Forge ─────────────────────────────────────────────────

func forgeVersions(mcVersion string) ([]Version, error) {
	var data struct {
		Promos map[string]string `json:"promos"`
	}
	if err := httpx.GetJSON("https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json", &data); err != nil {
		return nil, err
	}
	var out []Version
	if v, ok := data.Promos[mcVersion+"-recommended"]; ok {
		out = append(out, Version{Version: v, Stable: true})
	}
	if v, ok := data.Promos[mcVersion+"-latest"]; ok && (len(out) == 0 || out[0].Version != v) {
		out = append(out, Version{Version: v, Stable: false})
	}
	return out, nil
}

func installForge(forgeVersion, mcVersion, dir, java string, emit func(string)) error {
	full := mcVersion + "-" + forgeVersion
	url := fmt.Sprintf("https://maven.minecraftforge.net/net/minecraftforge/forge/%s/forge-%s-installer.jar", full, full)
	installer := filepath.Join(dir, "forge-installer.jar")
	if err := httpx.Download(url, installer); err != nil {
		return err
	}
	defer os.Remove(installer)

	emit("Running Forge installer (--installServer)...")
	return runJar(java, installer, dir, emit, "--installServer")
}

// ─── NeoForge ──────────────────────────────────────────────

var neoVersionRe = regexp.MustCompile(`<version>([^<]+)</version>`)

func neoforgeVersions(mcVersion string) ([]Version, error) {
	// MC 1.21.4 -> NeoForge 21.4.x
	prefix := neoPrefix(mcVersion)
	body, err := httpx.GetText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml")
	if err != nil {
		return nil, err
	}
	matches := neoVersionRe.FindAllStringSubmatch(body, -1)
	var all []string
	for _, m := range matches {
		all = append(all, m[1])
	}
	var out []Version
	// Newest first.
	for i := len(all) - 1; i >= 0 && len(out) < 10; i-- {
		if prefix == "" || hasPrefix(all[i], prefix) {
			out = append(out, Version{Version: all[i], Stable: len(out) == 0})
		}
	}
	return out, nil
}

func installNeoForge(neoVersion, dir, java string, emit func(string)) error {
	url := fmt.Sprintf("https://maven.neoforged.net/releases/net/neoforged/neoforge/%s/neoforge-%s-installer.jar", neoVersion, neoVersion)
	installer := filepath.Join(dir, "neoforge-installer.jar")
	if err := httpx.Download(url, installer); err != nil {
		return err
	}
	defer os.Remove(installer)

	emit("Running NeoForge installer (--installServer)...")
	return runJar(java, installer, dir, emit, "--installServer")
}

// ─── helpers ───────────────────────────────────────────────

func runJar(java, jar, dir string, emit func(string), args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), installTimeout)
	defer cancel()

	full := append([]string{"-jar", jar}, args...)
	cmd := exec.CommandContext(ctx, java, full...)
	cmd.Dir = dir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	buf := make([]byte, 4096)
	for {
		n, err := stdout.Read(buf)
		if n > 0 && emit != nil {
			emit("  " + trimTrailing(string(buf[:n])))
		}
		if err != nil {
			break
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("installer timed out after %s", installTimeout)
		}
		return fmt.Errorf("installer failed: %w", err)
	}
	return nil
}

func neoPrefix(mcVersion string) string {
	// "1.21.4" -> "21.4."; "1.21" -> "21.0."
	parts := splitDots(mcVersion)
	if len(parts) < 2 {
		return ""
	}
	patch := "0"
	if len(parts) > 2 {
		patch = parts[2]
	}
	return parts[1] + "." + patch + "."
}

func splitDots(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '.' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	return append(out, cur)
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func trimTrailing(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}
