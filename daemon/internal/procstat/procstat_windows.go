//go:build windows

package procstat

import (
	"errors"
	"syscall"
	"time"
	"unsafe"
)

const processQueryLimitedInformation = 0x1000

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
)

// processMemoryCounters is PROCESS_MEMORY_COUNTERS.
type processMemoryCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

type process struct {
	usage   Usage
	created int64 // 100 ns units since 1601
}

func filetime(ft syscall.Filetime) int64 {
	return int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
}

func query(pid uint32) (process, error) {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return process{}, err
	}
	defer syscall.CloseHandle(h)

	var created, exited, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return process{}, err
	}
	p := process{created: filetime(created)}
	p.usage.CPU = time.Duration(filetime(kernel)+filetime(user)) * 100 // 100 ns units

	var mem processMemoryCounters
	mem.cb = uint32(unsafe.Sizeof(mem))
	ok, _, callErr := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mem)), uintptr(mem.cb))
	if ok == 0 {
		// No memory reading is no reading at all: a zero would pass for one.
		return process{}, callErr
	}
	p.usage.Memory = uint64(mem.workingSetSize)
	return p, nil
}

// Tree reports the usage of the process pid together with every process that
// descends from it (run.bat starts the JVM as a child).
func Tree(pid int) (Usage, error) {
	root, err := query(uint32(pid))
	if err != nil {
		return Usage{}, err
	}

	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return Usage{}, err
	}
	defer syscall.CloseHandle(snapshot)

	children := map[uint32][]uint32{}
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if entry.ProcessID != 0 && entry.ProcessID != entry.ParentProcessID {
			children[entry.ParentProcessID] = append(children[entry.ParentProcessID], entry.ProcessID)
		}
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return Usage{}, err
	}

	total := root.usage
	seen := map[uint32]bool{uint32(pid): true}
	// A parent id is only a number, and Windows gives the numbers of ended
	// processes to new ones: a process is a child only if it was created
	// after the one it names as its parent.
	type node struct {
		pid     uint32
		created int64
	}
	queue := []node{{uint32(pid), root.created}}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent.pid] {
			if seen[child] {
				continue
			}
			seen[child] = true
			p, err := query(child)
			if err != nil || p.created < parent.created {
				continue
			}
			total.CPU += p.usage.CPU
			total.Memory += p.usage.Memory
			queue = append(queue, node{child, p.created})
		}
	}
	return total, nil
}
