// Package jvm builds the JVM arguments a Minecraft server is launched with.
//
// It mirrors src/shared/utils/jvm.ts in the desktop app: the two must stay in
// sync so a server behaves the same whether it runs locally or on a remote
// host.
package jvm

import (
	"fmt"
	"regexp"
	"strconv"
)

// JVM argument profiles.
const (
	// ProfileDefault only sets the heap bounds.
	ProfileDefault = "default"
	// ProfileAikar adds Aikar's G1GC tuning and reserves the full heap up front.
	ProfileAikar = "aikar"
)

// AikarFlags are the flags PaperMC recommends for busy servers
// (https://docs.papermc.io/paper/aikars-flags).
var AikarFlags = []string{
	"-XX:+UseG1GC",
	"-XX:+ParallelRefProcEnabled",
	"-XX:MaxGCPauseMillis=200",
	"-XX:+UnlockExperimentalVMOptions",
	"-XX:+DisableExplicitGC",
	"-XX:+AlwaysPreTouch",
	"-XX:G1NewSizePercent=30",
	"-XX:G1MaxNewSizePercent=40",
	"-XX:G1HeapRegionSize=8M",
	"-XX:G1ReservePercent=20",
	"-XX:G1HeapWastePercent=5",
	"-XX:G1MixedGCCountTarget=4",
	"-XX:InitiatingHeapOccupancyPercent=15",
	"-XX:G1MixedGCLiveThresholdPercent=90",
	"-XX:G1RSetUpdatingPauseTimePercent=5",
	"-XX:SurvivorRatio=32",
	"-XX:+PerfDisableSharedMem",
	"-XX:MaxTenuringThreshold=1",
	"-Dusing.aikars.flags=https://mcflags.emc.gs",
	"-Daikars.new.flags=true",
}

var ramPattern = regexp.MustCompile(`^[1-9]\d{0,5}[MG]$`)

// ValidRAM reports whether s is a heap size such as "512M" or "8G".
func ValidRAM(s string) bool { return ramPattern.MatchString(s) }

// ValidProfile reports whether p names a known profile ("" means default).
func ValidProfile(p string) bool {
	return p == "" || p == ProfileDefault || p == ProfileAikar
}

// ramMB converts a valid heap size to megabytes.
func ramMB(s string) int {
	n, _ := strconv.Atoi(s[:len(s)-1])
	if s[len(s)-1] == 'G' {
		return n * 1024
	}
	return n
}

// Validate checks a heap configuration and profile before it is persisted.
func Validate(minRAM, maxRAM, profile string) error {
	if !ValidRAM(minRAM) {
		return fmt.Errorf("invalid minimum memory: %s", minRAM)
	}
	if !ValidRAM(maxRAM) {
		return fmt.Errorf("invalid maximum memory: %s", maxRAM)
	}
	if ramMB(minRAM) > ramMB(maxRAM) {
		return fmt.Errorf("minimum memory (%s) cannot exceed maximum memory (%s)", minRAM, maxRAM)
	}
	if !ValidProfile(profile) {
		return fmt.Errorf("unknown JVM profile: %s", profile)
	}
	return nil
}

// Args returns the JVM arguments for a server.
//
// It never fails: records written by older daemon versions were not validated,
// so anything unexpected degrades to the plain heap arguments those versions
// used.
func Args(minRAM, maxRAM, profile string) []string {
	if profile == ProfileAikar && ValidRAM(maxRAM) {
		// Aikar's flags assume a fixed-size heap (-Xms == -Xmx).
		return append([]string{"-Xms" + maxRAM, "-Xmx" + maxRAM}, AikarFlags...)
	}
	return []string{"-Xms" + minRAM, "-Xmx" + maxRAM}
}
