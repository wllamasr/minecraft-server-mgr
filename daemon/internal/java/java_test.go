package java

import "testing"

func TestRequiredMajor(t *testing.T) {
	cases := map[string]int{
		"1.21":   21,
		"1.21.4": 21,
		"1.20.6": 21,
		"1.20.5": 21,
		"1.20.4": 17,
		"1.20.1": 17,
		"1.17":   17,
		"1.16.5": 8,
		"1.12.2": 8,
	}
	for v, want := range cases {
		if got := RequiredMajor(v); got != want {
			t.Errorf("RequiredMajor(%q) = %d, want %d", v, got, want)
		}
	}
}

func TestCleanRelRejectsTraversal(t *testing.T) {
	bad := []string{"../evil", "/abs/path", "a/../../b", "..\\win"}
	for _, p := range bad {
		if cleanRel(p) != "" {
			t.Errorf("cleanRel(%q) should be rejected", p)
		}
	}
	if cleanRel("jdk-21/bin/java") != "jdk-21/bin/java" {
		t.Errorf("cleanRel dropped a safe path")
	}
	if cleanRel("./jdk-21/bin/java") != "jdk-21/bin/java" {
		t.Errorf("cleanRel did not strip ./ prefix")
	}
}

func TestFirstSegment(t *testing.T) {
	if firstSegment("jdk-21.0.2+13/bin/java") != "jdk-21.0.2+13" {
		t.Errorf("firstSegment wrong")
	}
	if firstSegment("solo") != "solo" {
		t.Errorf("firstSegment single wrong")
	}
}
