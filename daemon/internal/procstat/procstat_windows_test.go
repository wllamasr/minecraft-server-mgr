//go:build windows

package procstat

import (
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

// A real process tree: cmd.exe starting a PowerShell that burns processor
// time, like run.bat starting the JVM. The child's use must be counted.
func TestTreeCountsTheChildren(t *testing.T) {
	cmd := exec.Command("cmd", "/c", "powershell", "-NoProfile", "-Command", "while($true){}")
	if err := cmd.Start(); err != nil {
		t.Skip("cannot start cmd:", err)
	}
	defer func() {
		_ = exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
		_ = cmd.Wait()
	}()

	// PowerShell needs a moment to start.
	deadline := time.Now().Add(20 * time.Second)
	for {
		before, err := Tree(cmd.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		time.Sleep(700 * time.Millisecond)
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

func TestTreeOfThisProcess(t *testing.T) {
	got, err := Tree(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if got.Memory == 0 {
		t.Errorf("no memory measured: %+v", got)
	}
}

func TestTreeOfNoProcess(t *testing.T) {
	// Process ids are multiples of four on Windows: this one cannot exist.
	if _, err := Tree(3); err == nil {
		t.Error("no error for a process that does not exist")
	}
}
