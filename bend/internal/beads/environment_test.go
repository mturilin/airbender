// What: checks the environment bend gives bd: Dolt's info branch is switched
// off unless the owner chose otherwise (bead-bb-7lb).
package beads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A stand-in bd that prints whether the variable is set, and to what.
const printsVariable = "#!/bin/sh\nif [ \"${DOLT_REMOTE_INFO_BRANCH+set}\" = set ]; then echo \"set:$DOLT_REMOTE_INFO_BRANCH\"; else echo unset; fi\n"

func standIn(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bd")
	if err := os.WriteFile(path, []byte(printsVariable), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEveryBdHasDoltInfoBranchSwitchedOff(t *testing.T) {
	t.Setenv(doltInfoBranchVar, "placeholder")
	os.Unsetenv(doltInfoBranchVar)
	out, err := New(t.TempDir(), "", standIn(t)).bd([]string{"anything"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out); got != "set:" {
		t.Fatalf("bd saw %q; want the variable set and empty", got)
	}
}

func TestTheSyncRunHasItToo(t *testing.T) {
	t.Setenv(doltInfoBranchVar, "placeholder")
	os.Unsetenv(doltInfoBranchVar)
	ran := run(t.TempDir(), bdTimeout, standIn(t), "sync")
	if ran.Code != 0 {
		t.Fatalf("exit %d: %s", ran.Code, ran.Stderr)
	}
	if got := strings.TrimSpace(ran.Stdout); got != "set:" {
		t.Fatalf("bd saw %q; want the variable set and empty", got)
	}
}

func TestTheOwnersOwnValueIsKept(t *testing.T) {
	t.Setenv(doltInfoBranchVar, "my-info")
	out, err := New(t.TempDir(), "", standIn(t)).bd([]string{"anything"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out); got != "set:my-info" {
		t.Fatalf("bd saw %q; want the owner's own value", got)
	}
}
