// args_test.go — tests for reading a command line.
//
// What: checks options with values, repeated options, flags, short forms,
// `--`, and the usage errors.

package cli

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// testSpec is a small set of options of every sort.
var testSpec = OptionSpec{
	Values: []string{"type", "dir"},
	Lists:  []string{"blocked-by"},
	Flags:  []string{"json", "top"},
	Short:  map[string]string{"C": "dir"},
}

func TestPositionalsValuesListsAndFlags(t *testing.T) {
	parsed, err := ParseArgs(
		[]string{"Fix it", "--type", "bug", "--blocked-by", "a", "--blocked-by=b", "--json", "-C", "/x"}, testSpec)
	if err != nil {
		t.Fatal(err)
	}
	want := &Parsed{
		Positionals: []string{"Fix it"},
		Values:      map[string]string{"type": "bug", "dir": "/x"},
		Lists:       map[string][]string{"blocked-by": {"a", "b"}},
		Flags:       map[string]bool{"json": true},
	}
	if !reflect.DeepEqual(parsed, want) {
		t.Fatalf("got %+v", parsed)
	}
}

func TestEverythingAfterDoubleDashIsText(t *testing.T) {
	parsed, _ := ParseArgs([]string{"id", "--", "-starts", "--with-dashes"}, testSpec)
	if !reflect.DeepEqual(parsed.Positionals, []string{"id", "-starts", "--with-dashes"}) {
		t.Fatalf("got %v", parsed.Positionals)
	}
	// A lone - is a value.
	parsed, _ = ParseArgs([]string{"-"}, testSpec)
	if !reflect.DeepEqual(parsed.Positionals, []string{"-"}) {
		t.Fatalf("got %v", parsed.Positionals)
	}
}

func TestUsageErrorsNameTheOption(t *testing.T) {
	for _, bad := range []struct {
		words []string
		says  string
	}{
		{[]string{"--wat"}, "Unknown option --wat"},
		{[]string{"--type"}, "--type needs a value"},
		{[]string{"--top=yes"}, "--top does not take a value"},
		{[]string{"-a comment with a dash"}, "put -- before it"},
	} {
		_, err := ParseArgs(bad.words, testSpec)
		if tracker.KindOf(err) != tracker.KindUsage || !strings.Contains(err.Error(), bad.says) {
			t.Fatalf("%v: got %v", bad.words, err)
		}
	}
}

func TestPriorities(t *testing.T) {
	if got, _ := ParsePriority("2"); got != 2 {
		t.Fatalf("got %d", got)
	}
	if got, err := ParsePriority("P0"); got != 0 || err != nil {
		t.Fatalf("got %d, %v", got, err)
	}
	for _, bad := range []string{"5", "high"} {
		if _, err := ParsePriority(bad); tracker.KindOf(err) != tracker.KindUsage || err == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}
