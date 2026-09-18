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
