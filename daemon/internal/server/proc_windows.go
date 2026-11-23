//go:build windows

package server

import (
	"os/exec"
	"strconv"
)

// isolate is a no-op on Windows: the process tree is found by parent PID.
func isolate(_ *exec.Cmd) {}

// killTree kills the server process together with everything it started.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}
