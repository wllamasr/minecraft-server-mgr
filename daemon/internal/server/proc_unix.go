//go:build !windows

package server

import (
	"os/exec"
	"syscall"
)

// isolate puts the server in its own process group. A forced stop can then
// kill the whole group (run.sh and the JVM it starts), and a Ctrl-C aimed at
// msmd no longer reaches the servers directly: msmd shuts them down itself.
func isolate(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree kills the server process together with everything it started.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}
