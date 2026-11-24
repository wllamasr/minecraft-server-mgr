//go:build linux

package procstat

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestParseStat(t *testing.T) {
	// A command with spaces and parentheses in its name.
	raw := []byte("4242 (java (Server) thr) S 1 4000 4000 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 12345 9000000 2048 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n")
	st, ok := parseStat(raw)
	if !ok || st.pgrp != 4000 || st.ticks != 300 || st.rssPages != 2048 {
		t.Errorf("parseStat = %+v, %v", st, ok)
	}
	for _, bad := range []string{"", "1 (x", "1 (x) S 1 2", "1 (x) S 1 notanumber 3 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 1 1 1"} {
		if _, ok := parseStat([]byte(bad)); ok {
			t.Errorf("parseStat(%q) accepted", bad)
		}
	}
}

func TestTreeSumsTheGroupAndNothingElse(t *testing.T) {
	root := t.TempDir()
	write := func(pid, line string) {
		if err := os.MkdirAll(filepath.Join(root, pid), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, pid, "stat"), []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tail := " 0 -1 0 0 0 0 0 %UT% %ST% 0 0 20 0 1 0 1 1 %RSS% 0 0 0\n"
	line := func(pid, pgrp, ut, st, rss string) string {
		s := pid + " (x) S 1 " + pgrp + " " + pgrp + tail
		for k, v := range map[string]string{"%UT%": ut, "%ST%": st, "%RSS%": rss} {
			s = replace(s, k, v)
		}
		return s
	}
	write("100", line("100", "100", "50", "50", "10"))    // the shell
	write("101", line("101", "100", "200", "0", "1000"))  // the JVM it started
	write("200", line("200", "200", "999", "999", "999")) // another server
	_ = os.MkdirAll(filepath.Join(root, "self"), 0o700)

	old := procRoot
	procRoot = root
	defer func() { procRoot = old }()

	got, err := Tree(100)
	if err != nil {
		t.Fatal(err)
	}
	if got.CPU != 3*time.Second || got.Memory != 1010*uint64(os.Getpagesize()) {
		t.Errorf("Tree = %+v", got)
	}
	if _, err := Tree(300); err == nil {
		t.Error("Tree of a group that does not exist gave no error")
	}
}

func replace(s, old, new string) string {
	for i := 0; i+len(old) <= len(s); i++ {
		if s[i:i+len(old)] == old {
			return s[:i] + new + s[i+len(old):]
		}
	}
	return s
}

// A real process tree: a shell that starts a child which burns processor
// time. The child's use must be counted with the shell's.
func TestTreeOfARealProcessGroup(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sh -c 'while :; do :; done' & wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Skip("no sh:", err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	// On a busy machine the loop may get little of a core for a while.
	deadline := time.Now().Add(20 * time.Second)
	for {
		before, err := Tree(cmd.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		time.Sleep(600 * time.Millisecond)
		after, err := Tree(cmd.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		percent, ok := Percent(before, after, time.Since(start))
		if ok && percent >= 30 && after.Memory > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("a busy loop in a child measured %.1f%% (ok=%v); before %+v, after %+v", percent, ok, before, after)
		}
	}
}
