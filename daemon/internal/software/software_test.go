package software

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The fixtures are recorded API responses, shared with the desktop app's
// tests (src/shared/utils/__fixtures__).
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func index(list []string, v string) int {
	for i, s := range list {
		if s == v {
			return i
		}
	}
	return -1
}

func TestValid(t *testing.T) {
	for _, p := range []string{"paper", "purpur", "folia"} {
		if !Valid(p) {
			t.Errorf("Valid(%q) = false", p)
		}
	}
	for _, p := range []string{"", "forge", "spigot", "Paper", "paper/../x"} {
		if Valid(p) {
			t.Errorf("Valid(%q) = true", p)
		}
	}
}

func TestParseFillVersions(t *testing.T) {
	versions := parseFillVersions(fixture(t, "fill-folia-project.json"))
	if len(versions) == 0 || versions[0] != "26.3" {
		t.Fatalf("newest version should come first, got %v", versions)
	}
	if i, j := index(versions, "1.21.11"), index(versions, "1.21.8"); i < 0 || j < 0 || i > j {
		t.Errorf("1.21.11 must sort before 1.21.8: %v", versions)
	}
	if index(versions, "1.19.4") < 0 {
		t.Errorf("missing 1.19.4: %v", versions)
	}

	raw := []byte(`{"versions":{"26.3":["26.3","26.3-rc-3"],"1.21":["1.21.11","1.21.11-rc3","1.21.9-pre4","1.21.4"]}}`)
	if got, want := parseFillVersions(raw), []string{"26.3", "1.21.11", "1.21.4"}; !reflect.DeepEqual(got, want) {
		t.Errorf("pre-releases must be dropped: got %v, want %v", got, want)
	}
	if got := parseFillVersions([]byte(`not json`)); len(got) != 0 {
		t.Errorf("malformed input should yield nothing, got %v", got)
	}
}

func TestParseFillBuilds(t *testing.T) {
	builds := parseFillBuilds(fixture(t, "fill-folia-1.21.11-builds.json"))
	if len(builds) == 0 || builds[0] != (Build{Version: "14", Stable: true}) {
		t.Fatalf("unexpected first build: %+v", builds)
	}
	prev := 1 << 30
	for _, b := range builds {
		n, _ := strconv.Atoi(b.Version)
		if n >= prev {
			t.Errorf("builds are not newest first: %+v", builds)
		}
		prev = n
		if (b.Version == "6" || b.Version == "1") && b.Stable {
			t.Errorf("build %s is BETA/ALPHA and must not be stable", b.Version)
		}
	}
}

func TestResolveFillDownload(t *testing.T) {
	raw := fixture(t, "fill-folia-1.21.11-builds.json")
	d, err := resolveFillDownload(raw, "14")
	if err != nil {
		t.Fatal(err)
	}
	if d.FileName != "folia-1.21.11-14.jar" || d.Algorithm != "sha256" ||
		d.Checksum != "f52c408490a0225611e67907a3ca19f7e6da2c6bc899e715d5f46844e7103c39" ||
		!strings.HasPrefix(d.URL, "https://fill-data.papermc.io/") {
		t.Errorf("unexpected download: %+v", d)
	}

	if _, err := resolveFillDownload(raw, "9999"); err == nil {
		t.Error("an unknown build must be rejected")
	}

	sum := strings.Repeat("a", 64)
	cases := map[string]string{
		"other host":  `[{"id":1,"downloads":{"server:default":{"url":"https://evil.example/p.jar","checksums":{"sha256":"` + sum + `"}}}}]`,
		"lookalike":   `[{"id":1,"downloads":{"server:default":{"url":"https://evilpapermc.io/p.jar","checksums":{"sha256":"` + sum + `"}}}}]`,
		"plain http":  `[{"id":1,"downloads":{"server:default":{"url":"http://fill-data.papermc.io/p.jar","checksums":{"sha256":"` + sum + `"}}}}]`,
		"no checksum": `[{"id":1,"downloads":{"server:default":{"url":"https://fill-data.papermc.io/p.jar"}}}]`,
	}
	for name, body := range cases {
		if _, err := resolveFillDownload([]byte(body), "1"); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestPurpur(t *testing.T) {
	versions := parsePurpurVersions(fixture(t, "purpur-project.json"))
	if len(versions) == 0 || versions[0] != "26.3" || index(versions, "1.21.4") < 0 {
		t.Errorf("unexpected versions: %v", versions)
	}

	builds := parsePurpurBuilds(fixture(t, "purpur-1.21.4.json"), 25)
	if len(builds) != 25 || builds[0] != (Build{Version: "2416", Stable: true}) {
		t.Errorf("unexpected builds: %+v", builds)
	}

	d, err := resolvePurpurDownload("1.21.4", fixture(t, "purpur-1.21.4-2416.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := Download{
		Build:     "2416",
		URL:       "https://api.purpurmc.org/v2/purpur/1.21.4/2416/download",
		FileName:  "purpur-1.21.4-2416.jar",
		Algorithm: "md5",
		Checksum:  "e3832b46efa4a2a56d31bc7ce26df6f0",
	}
	if d != want {
		t.Errorf("got %+v, want %+v", d, want)
	}

	for name, body := range map[string]string{
		"failed build": `{"build":"7","result":"FAILURE","md5":"e3832b46efa4a2a56d31bc7ce26df6f0"}`,
		"no checksum":  `{"build":"7","result":"SUCCESS"}`,
		"bad build id": `{"build":"../7","result":"SUCCESS","md5":"e3832b46efa4a2a56d31bc7ce26df6f0"}`,
	} {
		if _, err := resolvePurpurDownload("1.21.4", []byte(body)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestInputValidation(t *testing.T) {
	// Rejected before any network request is made.
	if _, err := Builds(Paper, "1.21.4/../../x"); err == nil {
		t.Error("Builds must reject a malformed Minecraft version")
	}
	if _, err := Builds(Platform("spigot"), "1.21.4"); err == nil {
		t.Error("Builds must reject an unknown platform")
	}
	if _, err := resolve(Paper, "1.21.4", "12a"); err == nil {
		t.Error("resolve must reject a malformed build id")
	}
	if _, err := resolve(Purpur, "1.21.4-rc1", "12"); err == nil {
		t.Error("resolve must reject a pre-release version")
	}
}

func TestVerifyChecksum(t *testing.T) {
	const helloSHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	const helloMD5 = "5d41402abc4b2a76b9719d911017c592"

	path := filepath.Join(t.TempDir(), "server.jar")
	write := func() {
		if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	write()
	if err := verifyChecksum(path, "sha256", strings.ToUpper(helloSHA256)); err != nil {
		t.Errorf("sha256 should match case-insensitively: %v", err)
	}
	if err := verifyChecksum(path, "md5", helloMD5); err != nil {
		t.Errorf("md5 should match: %v", err)
	}

	if err := verifyChecksum(path, "sha256", strings.Repeat("a", 64)); err == nil {
		t.Error("a mismatch must fail")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("a mismatching file must be removed")
	}

	write()
	if err := verifyChecksum(path, "crc32", "0"); err == nil {
		t.Error("an unknown algorithm must fail")
	}
}
