package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

func TestBuildLaunchCmdJVMArgs(t *testing.T) {
	java := filepath.Join(t.TempDir(), "bin", "java")

	// Paper with the tuned profile: fixed-size heap plus Aikar's flags.
	paper := store.Server{Dir: t.TempDir(), ModLoader: "paper", MinRAM: "1G", MaxRAM: "8G", JVMProfile: "aikar"}
	args := strings.Join(buildLaunchCmd(paper, java).Args, " ")
	for _, want := range []string{"-Xms8G", "-Xmx8G", "-XX:+UseG1GC", "-jar server.jar nogui"} {
		if !strings.Contains(args, want) {
			t.Errorf("paper/aikar launch args miss %q: %s", want, args)
		}
	}

	// A record written before profiles existed keeps its plain heap arguments.
	legacy := store.Server{Dir: t.TempDir(), MinRAM: "1G", MaxRAM: "2G"}
	if got := buildLaunchCmd(legacy, java).Args[1:]; strings.Join(got, " ") != "-Xms1G -Xmx2G -jar server.jar nogui" {
		t.Errorf("legacy launch args changed: %v", got)
	}

	// Forge reads its JVM arguments from user_jvm_args.txt.
	forge := store.Server{Dir: t.TempDir(), ModLoader: "forge", MinRAM: "2G", MaxRAM: "4G", JVMProfile: "aikar"}
	buildLaunchCmd(forge, java)
	b, err := os.ReadFile(filepath.Join(forge.Dir, "user_jvm_args.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Fields(string(b)); len(lines) < 3 || lines[0] != "-Xms4G" || lines[1] != "-Xmx4G" || lines[2] != "-XX:+UseG1GC" {
		t.Errorf("unexpected user_jvm_args.txt: %q", string(b))
	}
}

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
