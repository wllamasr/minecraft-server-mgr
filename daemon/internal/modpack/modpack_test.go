package modpack

import "testing"

func TestResolveLoader(t *testing.T) {
	mc, lt, lv := resolveLoader(map[string]string{"minecraft": "1.20.1", "fabric-loader": "0.15.7"})
	if mc != "1.20.1" || lt != "fabric" || lv != "0.15.7" {
		t.Fatalf("fabric resolve = %q %q %q", mc, lt, lv)
	}
	if _, lt, _ := resolveLoader(map[string]string{"minecraft": "1.21", "neoforge": "21.0.5"}); lt != "neoforge" {
		t.Fatalf("neoforge not resolved")
	}
	if _, lt, _ := resolveLoader(map[string]string{"minecraft": "1.20.1"}); lt != "" {
		t.Fatalf("vanilla should have no loader")
	}
}

func TestIsUnsafeRel(t *testing.T) {
	for _, p := range []string{"../evil", "/etc/passwd", "C:\\x", "mods/../../x", ""} {
		if !isUnsafeRel(p) {
			t.Errorf("expected %q unsafe", p)
		}
	}
	for _, p := range []string{"mods/sodium.jar", "config/a/b.toml"} {
		if isUnsafeRel(p) {
			t.Errorf("expected %q safe", p)
		}
	}
}

func TestValidMrpackURL(t *testing.T) {
	for _, ok := range []string{
		"https://cdn.modrinth.com/data/abc/versions/def/pack.mrpack",
		"HTTPS://CDN.MODRINTH.COM/data/pack.mrpack",
	} {
		if !ValidMrpackURL(ok) {
			t.Errorf("ValidMrpackURL(%q) = false", ok)
		}
	}
	for _, bad := range []string{
		"http://cdn.modrinth.com/data/pack.mrpack",
		"https://github.com/someone/pack/releases/download/v1/pack.mrpack",
		"https://cdn.modrinth.com.evil.example/pack.mrpack",
		"https://evil.example/cdn.modrinth.com/pack.mrpack",
		"https://cdn.modrinth.com@evil.example/pack.mrpack",
		"https://user:secret@cdn.modrinth.com/pack.mrpack",
		"https://cdn.modrinth.com:8443/pack.mrpack",
		"https://127.0.0.1/pack.mrpack",
		"file:///etc/passwd",
		"cdn.modrinth.com/pack.mrpack",
		"https:cdn.modrinth.com/pack.mrpack",
		"",
	} {
		if ValidMrpackURL(bad) {
			t.Errorf("ValidMrpackURL(%q) = true", bad)
		}
	}
}

func TestPickDownload(t *testing.T) {
	good := "https://github.com/o/r/releases/download/v1/mod.jar"
	if got := pickDownload([]string{"https://evil.example/mod.jar", good}); got != good {
		t.Errorf("pickDownload = %q, want %q", got, good)
	}
	for _, urls := range [][]string{
		nil,
		{"https://evil.example/mod.jar"},
		{"http://cdn.modrinth.com/mod.jar"},
		{"https://gist.github.com/o/mod.jar"},
		{"https://169.254.169.254/latest/meta-data"},
	} {
		if got := pickDownload(urls); got != "" {
			t.Errorf("pickDownload(%v) = %q, want none", urls, got)
		}
	}
	for _, h := range FileHosts {
		if !allowedFileURL("https://" + h + "/x.jar") {
			t.Errorf("%s is not allowed", h)
		}
	}
}
