package server

import "testing"

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"My Server":     "My_Server",
		"survival-01":   "survival-01",
		"../etc/passwd": "___etc_passwd",
		"a\\b/c":        "a_b_c",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractLevel(t *testing.T) {
	cases := map[string]string{
		"[12:00:00] [Server thread/INFO]: Done": "INFO",
		"[Server thread/WARN]: careful":         "WARN",
		"[Server thread/ERROR]: boom":           "ERROR",
		"java.lang.Exception SEVERE failure":    "ERROR",
		"a plain line without a level":          "",
	}
	for in, want := range cases {
		if got := extractLevel(in); got != want {
			t.Errorf("extractLevel(%q) = %q, want %q", in, got, want)
		}
	}
}
