// Tests for merging terminal statuses without changing owner configuration.
package setup

import (
	"strings"
	"testing"
)

// TestEndingSetupMergesWithoutOverwriting checks idempotence and conflicts.
func TestEndingSetupMergesWithoutOverwriting(t *testing.T) {
	merged, changed, err := mergeEndings("review:active,custom:frozen")
	if err != nil || !changed || !strings.HasPrefix(merged, "review:active,custom:frozen,") {
		t.Fatalf("%q %v %v", merged, changed, err)
	}
	again, changed, err := mergeEndings(merged)
	if err != nil || changed || again != merged {
		t.Fatal("repeat setup changes config")
	}
	if _, _, err := mergeEndings("cancelled:active"); err == nil {
		t.Fatal("overwrote existing category")
	}
}
