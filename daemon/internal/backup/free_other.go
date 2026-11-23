//go:build !linux && !darwin && !freebsd && !windows

package backup

// FreeSpace cannot tell on this system; the write itself fails if it must.
func FreeSpace(string) (free uint64, ok bool) { return 0, false }
