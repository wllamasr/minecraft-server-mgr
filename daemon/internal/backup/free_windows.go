//go:build windows

package backup

import (
	"syscall"
	"unsafe"
)

var getDiskFreeSpaceEx = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

// FreeSpace returns the bytes available on the volume holding dir. ok is
// false when that cannot be told.
func FreeSpace(dir string) (free uint64, ok bool) {
	path, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return 0, false
	}
	var available uint64
	r, _, _ := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&available)), 0, 0)
	if r == 0 {
		return 0, false
	}
	return available, true
}
