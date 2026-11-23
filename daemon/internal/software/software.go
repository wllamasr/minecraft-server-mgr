// Package software downloads plugin-platform server software (Paper, Purpur,
// Folia).
//
// Unlike mod loaders, these are not installers run on top of the vanilla jar:
// each build is a complete server jar that takes the place of server.jar. They
// are the engines meant for large player counts.
//
// The parsing mirrors src/shared/utils/server-software.ts in the desktop app.
package software

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/httpx"
)

// Platform is a supported plugin platform.
type Platform string

const (
	Paper  Platform = "paper"
	Purpur Platform = "purpur"
	Folia  Platform = "folia"
)

const (
	fillAPI   = "https://fill.papermc.io/v3/projects"
	purpurAPI = "https://api.purpurmc.org/v2/purpur"
)

// Valid reports whether s is a supported plugin platform.
func Valid(s string) bool {
	switch Platform(s) {
	case Paper, Purpur, Folia:
		return true
	}
	return false
}

// Build is one selectable build of a platform for a Minecraft version.
type Build struct {
	Version string `json:"version"`
	Stable  bool   `json:"stable"`
}

// Download describes a resolved server jar.
type Download struct {
	Build     string
	URL       string
	FileName  string
	Algorithm string // "sha256" or "md5"
	Checksum  string // lower-case hex
}

var (
	releasePattern = regexp.MustCompile(`^\d+(\.\d+){1,2}$`)
	buildPattern   = regexp.MustCompile(`^\d{1,9}$`)
	sha256Pattern  = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
	md5Pattern     = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
)

// IsReleaseVersion is true for final releases ("1.21.4", "26.1"), false for
// pre-releases, release candidates and snapshots.
func IsReleaseVersion(v string) bool { return releasePattern.MatchString(v) }

// ValidBuildID reports whether s is a plain build number.
func ValidBuildID(s string) bool { return buildPattern.MatchString(s) }

// ─── Network entry points ──────────────────────────────────

// Versions lists the Minecraft versions a platform publishes builds for,
// newest first.
func Versions(p Platform) ([]string, error) {
	if !Valid(string(p)) {
		return nil, fmt.Errorf("unknown server software: %s", p)
	}
	var raw json.RawMessage
	if p == Purpur {
		if err := httpx.GetJSON(purpurAPI, &raw); err != nil {
			return nil, err
		}
		return parsePurpurVersions(raw), nil
	}
	if err := httpx.GetJSON(fillAPI+"/"+string(p), &raw); err != nil {
		return nil, err
	}
	return parseFillVersions(raw), nil
}

// Builds lists a platform's builds for a Minecraft version, newest first.
func Builds(p Platform, mcVersion string) ([]Build, error) {
	if !Valid(string(p)) {
		return nil, fmt.Errorf("unknown server software: %s", p)
	}
	if !IsReleaseVersion(mcVersion) {
		return nil, fmt.Errorf("invalid Minecraft version: %s", mcVersion)
	}
	var raw json.RawMessage
	if p == Purpur {
		if err := httpx.GetJSON(purpurAPI+"/"+mcVersion, &raw); err != nil {
			return nil, err
		}
		return parsePurpurBuilds(raw, 25), nil
	}
	if err := httpx.GetJSON(fillBuildsURL(p, mcVersion), &raw); err != nil {
		return nil, err
	}
	return parseFillBuilds(raw), nil
}

// Fetch downloads a platform build to dest and verifies it against the checksum
// the project publishes. On a mismatch the file is removed.
func Fetch(p Platform, mcVersion, build, dest string) (Download, error) {
	d, err := resolve(p, mcVersion, build)
	if err != nil {
		return Download{}, err
	}
	if err := httpx.Download(d.URL, dest); err != nil {
		return Download{}, err
	}
	if err := verifyChecksum(dest, d.Algorithm, d.Checksum); err != nil {
		return Download{}, err
	}
	return d, nil
}

func resolve(p Platform, mcVersion, build string) (Download, error) {
	if !Valid(string(p)) {
		return Download{}, fmt.Errorf("unknown server software: %s", p)
	}
	if !IsReleaseVersion(mcVersion) {
		return Download{}, fmt.Errorf("invalid Minecraft version: %s", mcVersion)
	}
	if !ValidBuildID(build) {
		return Download{}, fmt.Errorf("invalid %s build: %s", p, build)
	}

	var raw json.RawMessage
	if p == Purpur {
		if err := httpx.GetJSON(purpurAPI+"/"+mcVersion+"/"+build, &raw); err != nil {
			return Download{}, err
		}
		d, err := resolvePurpurDownload(mcVersion, raw)
		if err != nil {
			return Download{}, err
		}
		if d.Build != build {
			return Download{}, fmt.Errorf("Purpur returned build %s instead of %s", d.Build, build)
		}
		return d, nil
	}
	if err := httpx.GetJSON(fillBuildsURL(p, mcVersion), &raw); err != nil {
		return Download{}, err
	}
	return resolveFillDownload(raw, build)
}

func fillBuildsURL(p Platform, mcVersion string) string {
	return fillAPI + "/" + string(p) + "/versions/" + mcVersion + "/builds"
}

// ─── PaperMC Fill v3 (Paper, Folia) ────────────────────────

type fillFile struct {
	Name      string `json:"name"`
	URL       string `json:"url"`
	Checksums struct {
		SHA256 string `json:"sha256"`
	} `json:"checksums"`
}

type fillBuild struct {
	ID        int                 `json:"id"`
	Channel   string              `json:"channel"`
	Downloads map[string]fillFile `json:"downloads"`
}

func parseFillVersions(raw []byte) []string {
	var project struct {
		Versions map[string][]string `json:"versions"`
	}
	if json.Unmarshal(raw, &project) != nil {
		return nil
	}
	var all []string
	for _, group := range project.Versions {
		all = append(all, group...)
	}
	return releasesNewestFirst(all)
}

// usableFillBuilds returns the builds that have a server download, newest first.
func usableFillBuilds(raw []byte) []fillBuild {
	var builds []fillBuild
	if json.Unmarshal(raw, &builds) != nil {
		return nil
	}
	out := builds[:0]
	for _, b := range builds {
		if b.Downloads["server:default"].URL != "" {
			out = append(out, b)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out
}

func parseFillBuilds(raw []byte) []Build {
	usable := usableFillBuilds(raw)
	out := make([]Build, 0, len(usable))
	for _, b := range usable {
		out = append(out, Build{Version: strconv.Itoa(b.ID), Stable: b.Channel == "STABLE"})
	}
	return out
}

// resolveFillDownload picks the download for a build. PaperMC hosts are the
// only accepted origin and a SHA-256 checksum is mandatory.
func resolveFillDownload(raw []byte, build string) (Download, error) {
	for _, b := range usableFillBuilds(raw) {
		if strconv.Itoa(b.ID) != build {
			continue
		}
		file := b.Downloads["server:default"]
		if !sha256Pattern.MatchString(file.Checksums.SHA256) {
			return Download{}, fmt.Errorf("build %s does not publish a SHA-256 checksum", build)
		}
		if err := assertTrustedHost(file.URL, "papermc.io"); err != nil {
			return Download{}, err
		}
		name := file.Name
		if name == "" {
			name = "server-" + build + ".jar"
		}
		return Download{
			Build:     build,
			URL:       file.URL,
			FileName:  name,
			Algorithm: "sha256",
			Checksum:  strings.ToLower(file.Checksums.SHA256),
		}, nil
	}
	return Download{}, fmt.Errorf("build %s was not found", build)
}

// ─── Purpur v2 ─────────────────────────────────────────────

func parsePurpurVersions(raw []byte) []string {
	var project struct {
		Versions []string `json:"versions"`
	}
	if json.Unmarshal(raw, &project) != nil {
		return nil
	}
	return releasesNewestFirst(project.Versions)
}

// parsePurpurBuilds lists the newest `limit` builds. Purpur has no release
// channels: every published build counts as stable.
func parsePurpurBuilds(raw []byte, limit int) []Build {
	var version struct {
		Builds struct {
			All []string `json:"all"`
		} `json:"builds"`
	}
	if json.Unmarshal(raw, &version) != nil {
		return nil
	}
	ids := make([]int, 0, len(version.Builds.All))
	for _, b := range version.Builds.All {
		if ValidBuildID(b) {
			n, _ := strconv.Atoi(b)
			ids = append(ids, n)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(ids)))
	if len(ids) > limit {
		ids = ids[:limit]
	}
	out := make([]Build, 0, len(ids))
	for _, id := range ids {
		out = append(out, Build{Version: strconv.Itoa(id), Stable: true})
	}
	return out
}

func resolvePurpurDownload(mcVersion string, raw []byte) (Download, error) {
	var detail struct {
		Build  string `json:"build"`
		Result string `json:"result"`
		MD5    string `json:"md5"`
	}
	if json.Unmarshal(raw, &detail) != nil || !ValidBuildID(detail.Build) {
		return Download{}, fmt.Errorf("Purpur build details are malformed")
	}
	if detail.Result != "SUCCESS" {
		return Download{}, fmt.Errorf("Purpur build %s did not build successfully", detail.Build)
	}
	if !md5Pattern.MatchString(detail.MD5) {
		return Download{}, fmt.Errorf("Purpur build %s does not publish a checksum", detail.Build)
	}
	if !IsReleaseVersion(mcVersion) {
		return Download{}, fmt.Errorf("invalid Minecraft version: %s", mcVersion)
	}
	return Download{
		Build:     detail.Build,
		URL:       purpurAPI + "/" + mcVersion + "/" + detail.Build + "/download",
		FileName:  "purpur-" + mcVersion + "-" + detail.Build + ".jar",
		Algorithm: "md5",
		Checksum:  strings.ToLower(detail.MD5),
	}, nil
}

// ─── Shared ────────────────────────────────────────────────

// releasesNewestFirst keeps final releases, de-duplicated, newest first.
func releasesNewestFirst(versions []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(versions))
	for _, v := range versions {
		if IsReleaseVersion(v) && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return compareVersions(out[i], out[j]) > 0 })
	return out
}

// compareVersions compares two release versions numerically.
func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var na, nb int
		if i < len(pa) {
			na, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			nb, _ = strconv.Atoi(pb[i])
		}
		if na != nb {
			if na > nb {
				return 1
			}
			return -1
		}
	}
	return 0
}

// assertTrustedHost fails unless rawURL is https on domain or a subdomain of it.
func assertTrustedHost(rawURL, domain string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("download URL is malformed")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme != "https" || (host != domain && !strings.HasSuffix(host, "."+domain)) {
		return fmt.Errorf("refusing to download server software from an unexpected host: %s", host)
	}
	return nil
}

// verifyChecksum hashes path and removes it when the digest does not match, so
// a corrupted or tampered jar can never be started.
func verifyChecksum(path, algorithm, expected string) error {
	var h hash.Hash
	switch algorithm {
	case "sha256":
		h = sha256.New()
	case "md5":
		h = md5.New()
	default:
		return fmt.Errorf("unsupported checksum algorithm: %s", algorithm)
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(h, f)
	f.Close()
	if err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		os.Remove(path)
		return fmt.Errorf("checksum mismatch for the downloaded file (%s: expected %s, got %s); the file was removed",
			algorithm, expected, actual)
	}
	return nil
}
