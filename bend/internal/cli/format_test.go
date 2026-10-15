// format_test.go — tests for the plain-text forms bend prints.
//
// What: checks how the helper's standing is put in words.

package cli

import (
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/kept"
)

// A helper that holds its lock but has not yet written when it started is
// starting, never "running since" the zero time (bead-bb-p1z).
func TestHelperJustStartedHasNoZeroTime(t *testing.T) {
	got := FormatHelper(kept.HelperState{Running: true, Pid: 0, Since: 0}, nil)
	if got != "The helper is starting." {
		t.Fatalf("got %q", got)
	}
}

func TestHelperRunningSaysSince(t *testing.T) {
	since := int64(1_760_000_000_000)
	got := FormatHelper(kept.HelperState{Running: true, Pid: 42, Since: since}, nil)
	if !strings.HasPrefix(got, "The helper is running since "+when(since)) {
		t.Fatalf("got %q", got)
	}
}
