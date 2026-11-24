//go:build linux

package procstat

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// userHZ is the unit of the times in /proc/<pid>/stat. It is 100 on every
// Linux architecture Go supports.
const userHZ = 100

// procRoot is where the process files are; tests point it elsewhere.
var procRoot = "/proc"

// Tree reports the usage of the process group led by pid: msmd starts every
// server as the leader of its own group, so that is the server and
// everything it started.
func Tree(pid int) (Usage, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return Usage{}, err
	}
	var total Usage
	found := false
	pageSize := uint64(os.Getpagesize())
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "stat"))
		if err != nil {
			continue // it ended while we were looking
		}
		st, ok := parseStat(raw)
		if !ok || st.pgrp != pid {
			continue
		}
		found = true
		total.CPU += time.Duration(st.ticks) * (time.Second / userHZ)
		total.Memory += st.rssPages * pageSize
	}
	if !found {
		return Usage{}, errors.New("no such process")
	}
	return total, nil
}

type stat struct {
	pgrp     int
	ticks    uint64 // utime + stime
	rssPages uint64
}

// parseStat reads the fields of /proc/<pid>/stat that matter here. The second
// field is the command in parentheses and may itself contain spaces and
// parentheses: the fields are counted from the last ")".
func parseStat(raw []byte) (stat, bool) {
	end := bytes.LastIndexByte(raw, ')')
	if end < 0 {
		return stat{}, false
	}
	// fields[0] is field 3 (state); pgrp is 5, utime 14, stime 15, rss 24.
	fields := bytes.Fields(raw[end+1:])
	if len(fields) < 22 {
		return stat{}, false
	}
	pgrp, err1 := strconv.Atoi(string(fields[2]))
	utime, err2 := strconv.ParseUint(string(fields[11]), 10, 64)
	stime, err3 := strconv.ParseUint(string(fields[12]), 10, 64)
	rss, err4 := strconv.ParseInt(string(fields[21]), 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return stat{}, false
	}
	if rss < 0 {
		rss = 0
	}
	return stat{pgrp: pgrp, ticks: utime + stime, rssPages: uint64(rss)}, true
}
