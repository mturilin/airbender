// leftovers_test.go — telling a file of beads' alone from one of the
// owner's, before anything is deleted (bead-bb-cnv).

package setup

import "testing"

func TestOnlyFilesWhollyBeadsAreLeftovers(t *testing.T) {
	for text, want := range map[string]bool{
		`{"hooks": {}}`: true,
		`{}`:            true,
		`{"hooks": {"SessionStart": [{"matcher": "", "hooks": [{"command": "bd prime --hook-json"}]}]}}`: true,
		`{"hooks": {"PostCompact": [{"hooks": [{"command": "bd codex-hook PostCompact"}]}]}}`:            true,
		`{"hooks": {"Stop": [{"hooks": [{"command": "bd prime"}, {"command": "say done"}]}]}}`:           false,
		`{"hooks": {}, "permissions": {"allow": ["Bash(ls)"]}}`:                                          false,
		`not json`: false,
	} {
		if got := onlyBeadsHooks(text); got != want {
			t.Errorf("onlyBeadsHooks(%s) = %v", text, got)
		}
	}
	for text, want := range map[string]bool{
		"[features]\nhooks = true\n":                 true,
		"[features]\n":                               true,
		"# beads\n[features]\nhooks=true\n":          true,
		"model = \"o3\"\n[features]\nhooks = true\n": false,
		"": false,
	} {
		if got := onlyBeadsCodexConfig(text); got != want {
			t.Errorf("onlyBeadsCodexConfig(%q) = %v", text, got)
		}
	}
}
