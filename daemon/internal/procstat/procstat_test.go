package procstat

import (
	"testing"
	"time"
)

func TestPercent(t *testing.T) {
	a := Usage{CPU: 10 * time.Second}
	b := Usage{CPU: 14 * time.Second}
	if p, ok := Percent(a, b, 2*time.Second); !ok || p != 200 {
		t.Errorf("two cores busy for two seconds = %v, %v", p, ok)
	}
	if _, ok := Percent(a, b, 0); ok {
		t.Error("a value without time passing")
	}
	// A process of the tree ended: its time is gone from the sum.
	if _, ok := Percent(b, a, time.Second); ok {
		t.Error("a value from processor time going backwards")
	}
}
