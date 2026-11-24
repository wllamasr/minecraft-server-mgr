// Package procstat measures what a server costs the host: the processor time
// and the memory of its process together with everything that process
// started (a Forge server is a shell script that starts the JVM).
//
// Standard library only. Linux reads /proc, Windows asks the kernel; on other
// systems Tree reports ErrUnsupported.
package procstat

import (
	"errors"
	"time"
)

// ErrUnsupported is returned where the host cannot be asked.
var ErrUnsupported = errors.New("process statistics are not available on this system")

// Usage is what a process tree has used so far.
type Usage struct {
	// CPU is the processor time used since the processes started, by the
	// ones that are still alive.
	CPU time.Duration
	// Memory is the physical memory in use now, in bytes.
	Memory uint64
}

// Percent is the processor use between two readings taken elapsed apart, in
// percent of one core (a server using two cores fully is at 200), like top.
// ok is false when nothing can be said: no time passed, or the processor time
// went backwards because a process of the tree ended in between.
func Percent(before, after Usage, elapsed time.Duration) (percent float64, ok bool) {
	if elapsed <= 0 || after.CPU < before.CPU {
		return 0, false
	}
	return float64(after.CPU-before.CPU) / float64(elapsed) * 100, true
}
