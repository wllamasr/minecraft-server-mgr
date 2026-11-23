package jvm

import (
	"reflect"
	"testing"
)

func TestValidRAM(t *testing.T) {
	for _, s := range []string{"512M", "1G", "32G", "4096M"} {
		if !ValidRAM(s) {
			t.Errorf("ValidRAM(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "0G", "4", "4g", "4GB", "-1G", "1G -XX:Foo", "1234567M"} {
		if ValidRAM(s) {
			t.Errorf("ValidRAM(%q) = true, want false", s)
		}
	}
}

func TestValidate(t *testing.T) {
	if err := Validate("2G", "4G", ProfileAikar); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := Validate("1024M", "1G", ""); err != nil {
		t.Errorf("equal heap sizes in different units should be valid: %v", err)
	}
	for _, c := range [][3]string{
		{"8G", "4G", ""},       // min above max
		{"2G", "4G", "zgc"},    // unknown profile
		{"0G", "4G", ""},       // bad min
		{"2G", "4G -Xfoo", ""}, // injection attempt
	} {
		if err := Validate(c[0], c[1], c[2]); err == nil {
			t.Errorf("Validate(%q, %q, %q) = nil, want error", c[0], c[1], c[2])
		}
	}
}

func TestArgs(t *testing.T) {
	if got, want := Args("1G", "2G", ""), []string{"-Xms1G", "-Xmx2G"}; !reflect.DeepEqual(got, want) {
		t.Errorf("default profile: got %v, want %v", got, want)
	}

	got := Args("1G", "8G", ProfileAikar)
	if got[0] != "-Xms8G" || got[1] != "-Xmx8G" {
		t.Errorf("aikar must pin the heap: got %v", got[:2])
	}
	if len(got) != 2+len(AikarFlags) || got[2] != "-XX:+UseG1GC" {
		t.Errorf("aikar flags missing: %v", got)
	}

	// The shared flag list must never be mutated by a caller's append.
	first := AikarFlags[0]
	_ = append(Args("1G", "2G", ProfileAikar), "-Dextra")
	if AikarFlags[0] != first || len(AikarFlags) != 20 {
		t.Errorf("AikarFlags was modified")
	}

	// Legacy records keep the old behaviour whatever they contain.
	if got, want := Args("0G", "1G", "unknown"), []string{"-Xms0G", "-Xmx1G"}; !reflect.DeepEqual(got, want) {
		t.Errorf("legacy fallback: got %v, want %v", got, want)
	}
}
