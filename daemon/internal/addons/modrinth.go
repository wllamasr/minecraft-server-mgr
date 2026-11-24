package addons

import (
	"context"
	"crypto/sha512"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/httpx"
)

const (
	apiHost  = "api.modrinth.com"
	fileHost = "cdn.modrinth.com"
	// maxFileSize is the largest plugin that is installed.
	maxFileSize = 256 << 20
	// installTimeout bounds everything an installation or an update asks of Modrinth.
	installTimeout = 5 * time.Minute
)

// Transport carries the requests to Modrinth. It is replaced in tests, which
// answer for Modrinth's hosts themselves; the hosts that may be asked are
// checked before it is used, whatever it is.
var Transport http.RoundTripper = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	// HTTP/1.1 only, as for the daemon's other downloads (see httpx).
	TLSNextProto:        make(map[string]func(string, *tls.Conn) http.RoundTripper),
	TLSHandshakeTimeout: 20 * time.Second,
	IdleConnTimeout:     90 * time.Second,
}

// allowed reports whether rawURL is an https address on host, and nothing else.
func allowed(rawURL, host string) bool {
	u, err := url.Parse(rawURL)
	return err == nil && u.Scheme == "https" && u.Host == host && u.User == nil
}

func get(ctx context.Context, rawURL, host string) (*http.Response, error) {
	if !allowed(rawURL, host) {
		return nil, errors.New("refusing to ask an unexpected host for a plugin")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", httpx.UserAgent)
	client := &http.Client{
		Transport: Transport,
		// Modrinth answers these directly. A redirect would lead somewhere
		// that was not checked.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("unexpected redirect")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	return resp, nil
}

type statusError int

func (e statusError) Error() string { return fmt.Sprintf("Modrinth answered HTTP %d", int(e)) }

// Version is a version of a Modrinth project, with the file that is installed.
type Version struct {
	ID            string
	ProjectID     string
	VersionNumber string
	Loaders       []string
	FileName      string
	URL           string
	Size          int64
	SHA512        string
}

var (
	versionIDRE = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	sha512RE    = regexp.MustCompile(`^[0-9a-f]{128}$`)
)

// ValidVersionID reports whether id looks like the id of a Modrinth version.
func ValidVersionID(id string) bool { return versionIDRE.MatchString(id) }

// Resolve asks Modrinth what a version is and which file to install for it.
// Everything about the file (its address, its name, its checksum) is taken
// from Modrinth's answer, none of it from whoever asked for the installation.
func Resolve(ctx context.Context, versionID string) (Version, error) {
	if !ValidVersionID(versionID) {
		return Version{}, errors.New("invalid version id")
	}
	resp, err := get(ctx, "https://"+apiHost+"/v2/version/"+versionID, apiHost)
	if err != nil {
		var status statusError
		if errors.As(err, &status) && status == http.StatusNotFound {
			return Version{}, errors.New("Modrinth has no such version")
		}
		return Version{}, err
	}
	defer resp.Body.Close()

	var raw struct {
		ID            string   `json:"id"`
		ProjectID     string   `json:"project_id"`
		VersionNumber string   `json:"version_number"`
		Loaders       []string `json:"loaders"`
		Files         []struct {
			URL      string `json:"url"`
			Filename string `json:"filename"`
			Primary  bool   `json:"primary"`
			Size     int64  `json:"size"`
			Hashes   struct {
				SHA512 string `json:"sha512"`
			} `json:"hashes"`
		} `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&raw); err != nil {
		return Version{}, errors.New("Modrinth's answer could not be read")
	}
	if len(raw.Files) == 0 {
		return Version{}, errors.New("this version has no file to install")
	}
	file := raw.Files[0]
	for _, f := range raw.Files {
		if f.Primary {
			file = f
			break
		}
	}
	v := Version{
		ID:            raw.ID,
		ProjectID:     raw.ProjectID,
		VersionNumber: cleanValue(raw.VersionNumber),
		Loaders:       raw.Loaders,
		FileName:      file.Filename,
		URL:           file.URL,
		Size:          file.Size,
		SHA512:        strings.ToLower(file.Hashes.SHA512),
	}
	switch {
	case v.ID != versionID || !ValidVersionID(v.ProjectID):
		return Version{}, errors.New("Modrinth's answer is not about this version")
	case !ValidFileName(v.FileName):
		return Version{}, fmt.Errorf("this version's file (%q) is not a plugin jar that can be installed", cleanValue(v.FileName))
	case !allowed(v.URL, fileHost):
		return Version{}, errors.New("this version's file is not kept on Modrinth; it is not installed")
	case !sha512RE.MatchString(v.SHA512):
		return Version{}, errors.New("Modrinth gives no checksum for this file; it is not installed")
	case v.Size <= 0 || v.Size > maxFileSize:
		return Version{}, errors.New("this version's file is too large to be a plugin")
	}
	return v, nil
}

// RunsOn reports whether the version is for a platform.
func (v Version) RunsOn(platform string) bool {
	for _, want := range compatibleLoaders(platform) {
		for _, has := range v.Loaders {
			if has == want {
				return true
			}
		}
	}
	return false
}

// CheckInstallable says why a version cannot be added to the plugins in dir,
// or nil. One file per plugin: a second version of a project already there
// would be a second jar of the same plugin.
func CheckInstallable(dir string, v Version) error {
	entries, err := scan(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.EqualFold(e.file, v.FileName) {
			return fmt.Errorf("%s is already installed", e.file)
		}
	}
	present := map[string]bool{}
	for _, e := range entries {
		present[e.file] = true
	}
	for file, o := range readOrigins(dir) {
		if present[file] && o.ProjectID == v.ProjectID {
			return fmt.Errorf("This plugin is already installed (%s). Remove it first to install another version", file)
		}
	}
	return nil
}

// Install downloads the file of a version into dir, and keeps it only if it
// is the file Modrinth described: of that size and with that checksum.
// progress, if given, is told how far the download is.
func Install(ctx context.Context, dir string, v Version, progress func(done, total int64)) error {
	if err := CheckInstallable(dir, v); err != nil {
		return err
	}
	tmp, err := download(ctx, dir, v, progress)
	if err != nil {
		return err
	}
	// Checked again: the folder may have changed while the file came down.
	if err := CheckInstallable(dir, v); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, v.FileName)); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("the plugin's file could not be put in place: %w", plain(err))
	}
	origins := readOrigins(dir)
	origins[v.FileName] = origin{ProjectID: v.ProjectID, VersionID: v.ID, SHA512: v.SHA512, SizeBytes: v.Size}
	// The plugin is installed either way; without this it only shows as a
	// file of unknown origin.
	_ = writeOrigins(dir, origins)
	return nil
}

// Update replaces the plugin oldFile, installed from Modrinth, with the version
// v of the same project. The new file takes the state the old one had: a jar
// that was off stays off. The old jars are set aside only once the new one is
// downloaded and checked, and they come back if it cannot be put in place. The
// caller makes sure the server is stopped.
func Update(ctx context.Context, dir, oldFile string, v Version, progress func(done, total int64)) error {
	if _, err := checkUpdatable(dir, oldFile, v); err != nil {
		return err
	}
	tmp, err := download(ctx, dir, v, progress)
	if err != nil {
		return err
	}
	fail := func(err error) error {
		os.Remove(tmp)
		return err
	}
	// Checked again: the folder may have changed while the file came down.
	olds, err := checkUpdatable(dir, oldFile, v)
	if err != nil {
		return fail(err)
	}
	enabled := false
	for _, e := range olds {
		enabled = enabled || e.enabled
	}
	target := v.FileName
	if !enabled {
		target += disabledSuffix
	}

	var moved []entry
	restore := func() {
		for _, e := range moved {
			_ = os.Rename(filepath.Join(dir, e.onDisk+asideSuffix), filepath.Join(dir, e.onDisk))
		}
	}
	for _, e := range olds {
		if err := os.Rename(filepath.Join(dir, e.onDisk), filepath.Join(dir, e.onDisk+asideSuffix)); err != nil {
			restore()
			return fail(fmt.Errorf("the plugin's file could not be set aside: %w", plain(err)))
		}
		moved = append(moved, e)
	}
	if err := os.Rename(tmp, filepath.Join(dir, target)); err != nil {
		restore()
		return fail(fmt.Errorf("the plugin's file could not be put in place: %w", plain(err)))
	}
	for _, e := range moved {
		// A leftover of a set-aside jar is not a plugin the server loads.
		_ = os.Remove(filepath.Join(dir, e.onDisk+asideSuffix))
	}

	origins := readOrigins(dir)
	delete(origins, oldFile)
	origins[v.FileName] = origin{ProjectID: v.ProjectID, VersionID: v.ID, SHA512: v.SHA512, SizeBytes: v.Size}
	_ = writeOrigins(dir, origins)
	return nil
}

// asideSuffix is added to the name of an old jar while its replacement is put
// in place. The name is not one the server loads.
const asideSuffix = ".msmd-old"

// checkUpdatable returns the jars of oldFile, if v can replace them: they were
// installed from the same Modrinth project, they are unchanged since, and v is
// another version that no other plugin of the folder is called by.
func checkUpdatable(dir, oldFile string, v Version) ([]entry, error) {
	if !ValidFileName(oldFile) {
		return nil, ErrNotFound
	}
	entries, err := scan(dir)
	if err != nil {
		return nil, err
	}
	var olds []entry
	for _, e := range entries {
		switch {
		case e.file == oldFile:
			olds = append(olds, e)
		case strings.EqualFold(e.file, v.FileName):
			return nil, fmt.Errorf("%s is already installed", e.file)
		}
	}
	if len(olds) == 0 {
		return nil, ErrNotFound
	}
	o, ok := readOrigins(dir)[oldFile]
	if !ok || o.ProjectID != v.ProjectID {
		return nil, errors.New("This plugin was not installed from this project on Modrinth, so it cannot be updated from there")
	}
	for _, e := range olds {
		if e.info.Size() != o.SizeBytes {
			return nil, errors.New("This plugin changed since the host installed it, so it cannot be updated")
		}
	}
	if o.VersionID == v.ID {
		return nil, errors.New("This version is already installed")
	}
	if v.FileName != oldFile {
		for _, name := range []string{v.FileName, v.FileName + disabledSuffix} {
			if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
				return nil, fmt.Errorf("%s is already in the folder", name)
			}
		}
	}
	return olds, nil
}

// download fetches the file of v into dir, under a name the server does not
// load, and checks it against Modrinth's size and checksum. On success the
// file is left for the caller to put in place; on failure nothing is left.
func download(ctx context.Context, dir string, v Version, progress func(done, total int64)) (string, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("the plugins folder could not be made: %w", plain(err))
	}
	resp, err := get(ctx, v.URL, fileHost)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	// Not a name the server loads, should the daemon die half way.
	tmp := filepath.Join(dir, v.FileName+".part")
	out, err := createNew(tmp)
	if err != nil {
		return "", fmt.Errorf("the plugin's file could not be written: %w", plain(err))
	}
	keep := false
	defer func() {
		out.Close()
		if !keep {
			os.Remove(tmp)
		}
	}()

	hash := sha512.New()
	buf := make([]byte, 64<<10)
	var done int64
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			done += int64(n)
			if done > v.Size {
				return "", errors.New("the download is larger than Modrinth says the file is; it was not installed")
			}
			hash.Write(buf[:n])
			if _, werr := out.Write(buf[:n]); werr != nil {
				return "", fmt.Errorf("the plugin's file could not be written: %w", plain(werr))
			}
			if progress != nil {
				progress(done, v.Size)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "", fmt.Errorf("the download failed: %w", err)
		}
	}
	if done != v.Size || hex.EncodeToString(hash.Sum(nil)) != v.SHA512 {
		return "", errors.New("the downloaded file does not match Modrinth's checksum; it was not installed")
	}
	if err := out.Close(); err != nil {
		return "", fmt.Errorf("the plugin's file could not be written: %w", plain(err))
	}
	keep = true
	return tmp, nil
}

// InstallTimeout is how long an installation or an update may take in all.
func InstallTimeout() time.Duration { return installTimeout }
