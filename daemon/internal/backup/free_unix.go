//go:build linux || darwin || freebsd

package backup

import "syscall"

// FreeSpace returns the bytes available on the volume holding dir. ok is
// false when that cannot be told.
func FreeSpace(dir string) (free uint64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true
}
