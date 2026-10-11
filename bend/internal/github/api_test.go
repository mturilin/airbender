// api_test.go — tests for the real connection to GitHub, without GitHub.
//
// What: checks what the real client sends (the login, the address, the
// body), how it reads GitHub's answers (an issue, a missing issue, pages of
// a list, a search), and that each way a request can fail is turned into
// the right plain words and the right kind of failure.
//
// Why: the adapter's tests run on the in-memory stand-in and never touch
// this code. Here the client is pointed at a stand-in web server on this
// machine (ClientOptions.BaseURL), which answers as GitHub was seen to.
//
// Gotchas:
//   - Nothing here reaches the real GitHub, and no real login is used: the
//     token is a made-up word, and the tests check it never shows up in a
//     message.

package github

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// secret is the made-up token the tests sign in with.
const secret = "ghp_not_a_real_token"

// seen is one request as the stand-in server received it.
type seen struct {
	Method string
	// Path is the path with its query, as asked.
	Path   string
	Header http.Header
	Body   string
}

// standIn is a stand-in web server and the requests it has received.
type standIn struct {
	server *httptest.Server
	lock   sync.Mutex
	asked  []seen
}

// serve starts a stand-in server that answers every request with answer,
// and a real client pointed at it, signed in with the made-up token. Both
// are gone when the test ends.
func serve(t *testing.T, answer func(request seen, reply http.ResponseWriter)) (*standIn, Client) {
	t.Helper()
	stand := &standIn{}
	stand.server = httptest.NewServer(http.HandlerFunc(func(reply http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		received := seen{
			Method: request.Method, Path: request.URL.RequestURI(),
			Header: request.Header, Body: string(body),
		}
		stand.lock.Lock()
		stand.asked = append(stand.asked, received)
		stand.lock.Unlock()
		answer(received, reply)
	}))
	t.Cleanup(stand.server.Close)
	client := NewClient("someone/scratch", ClientOptions{
		BaseURL: stand.server.URL,
		Token:   func() (string, error) { return secret, nil },
	})
	return stand, client
}

// requests gives a copy of what the stand-in server has received so far.
func (stand *standIn) requests() []seen {
	stand.lock.Lock()
	defer stand.lock.Unlock()
	return append([]seen{}, stand.asked...)
}

// answers gives a handler that sends one status and one JSON text, whatever
// is asked.
func answers(status int, body string) func(seen, http.ResponseWriter) {
	return func(_ seen, reply http.ResponseWriter) {
		reply.WriteHeader(status)
		io.WriteString(reply, body)
	}
}

// noToken fails the test when a failure's words give the token away.
func noToken(t *testing.T, err error) {
	t.Helper()
	if err != nil && strings.Contains(err.Error(), secret) {
		t.Fatalf("the token is in the message: %s", err)
	}
}

// node gives an issue as GraphQL sends it, in a repository.
func node(number int, nameWithOwner string) map[string]any {
	empty := map[string]any{"nodes": []any{}}
	return map[string]any{
		"number": number, "title": fmt.Sprintf("T%d", number), "state": "OPEN",
		"databaseId": number, "body": "", "stateReason": nil,
		"createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
		"assignees": empty, "labels": empty, "comments": map[string]any{"totalCount": 0},
		"subIssues": empty, "blockedBy": empty, "blocking": empty, "parent": nil,
		"repository": map[string]any{"nameWithOwner": nameWithOwner},
	}
}

// jsonText gives a value as JSON text.
func jsonText(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	must(t, err)
	return string(encoded)
}

func TestNoLoginIsSaidBeforeAnythingIsSent(t *testing.T) {
	stand := &standIn{}
	stand.server = httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		stand.lock.Lock()
		stand.asked = append(stand.asked, seen{})
		stand.lock.Unlock()
	}))
	defer stand.server.Close()
	asked := 0
	client := NewClient("someone/scratch", ClientOptions{
		BaseURL: stand.server.URL,
		Token: func() (string, error) {
			asked++
			return "", tracker.Failed(tracker.KindNotSignedIn, "Not signed in to GitHub.")
		},
	})
	_, err := client.HasIssues()
	wantFailure(t, err, tracker.KindNotSignedIn, `Not signed in`)
	// The login is asked for once, and its answer kept.
	_, err = client.Viewer()
	wantFailure(t, err, tracker.KindNotSignedIn, `Not signed in`)
	same(t, asked, 1)
	same(t, len(stand.requests()), 0)
	same(t, client.Requests(), 0)
}

func TestTheTokenIsFoundInTheEnvironmentOrThereIsNoLogin(t *testing.T) {
	// With a PATH that holds no `gh`, only the environment can give a token.
	t.Setenv("PATH", t.TempDir())
	t.Setenv("GH_TOKEN", "  from-gh-token \n")
	t.Setenv("GITHUB_TOKEN", "from-github-token")
	token, err := findToken()
	must(t, err)
	same(t, token, "from-gh-token")
	t.Setenv("GH_TOKEN", "   ")
	token, err = findToken()
	must(t, err)
	same(t, token, "from-github-token")
	t.Setenv("GITHUB_TOKEN", "")
	_, err = findToken()
	wantFailure(t, err, tracker.KindNotSignedIn, `^Not signed in to GitHub\. Sign in with .gh auth login., or set GH_TOKEN to a token that may read and write the repository's issues\.$`)
}

func TestTheNetworkFailingIsAPlainSentenceAndNeverTheToken(t *testing.T) {
	stand, client := serve(t, answers(200, "{}"))
	stand.server.Close()
	_, err := client.HasIssues()
	wantRefused(t, err, `^GitHub could not be reached\. Check the network connection and try again\.$`)
	noToken(t, err)
}

func TestTheRequestCarriesTheLoginAndAsksTheRightPlace(t *testing.T) {
	stand, client := serve(t, answers(201, "{}"))
	must(t, client.AddBlockedBy(5, 1006))
	asked := stand.requests()
	same(t, len(asked), 1)
	same(t, asked[0].Method, "POST")
	same(t, asked[0].Path, "/repos/someone/scratch/issues/5/dependencies/blocked_by")
	same(t, asked[0].Body, `{"issue_id":1006}`)
	for name, want := range map[string]string{
		"Authorization":        "Bearer " + secret,
		"Accept":               "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent":           "bend",
		"Content-Type":         "application/json",
	} {
		same(t, asked[0].Header.Get(name), want, name)
	}
	same(t, client.Requests(), 1)
	same(t, client.Repository(), "someone/scratch")

	// Every change goes to its own place, with its own body.
	must(t, client.RemoveBlockedBy(5, 1006))
	must(t, client.SetParent(3, 1007))
	must(t, client.RemoveParent(3, 1007))
	must(t, client.AddComment(4, "Hello <there>"))
	// Only what is to change is sent, and a set to be emptied is sent as an
	// empty list, never left out.
	must(t, client.Update(9, Changes{Title: tracker.Ptr("New"), Labels: &[]string{}}))
	var nothing []string
	must(t, client.Update(9, Changes{Assignees: &nothing, State: "closed", StateReason: "completed"}))
	asked = stand.requests()[1:]
	same(t,
		[]string{asked[0].Method, asked[0].Path, asked[0].Body, asked[0].Header.Get("Content-Type")},
		[]string{"DELETE", "/repos/someone/scratch/issues/5/dependencies/blocked_by/1006", "", ""},
	)
	same(t, []string{asked[1].Method, asked[1].Path}, []string{"POST", "/repos/someone/scratch/issues/3/sub_issues"})
	same(t, asked[1].Body, `{"replace_parent":true,"sub_issue_id":1007}`)
	same(t, []string{asked[2].Method, asked[2].Path}, []string{"DELETE", "/repos/someone/scratch/issues/3/sub_issue"})
	same(t, asked[2].Body, `{"sub_issue_id":1007}`)
	same(t, []string{asked[3].Method, asked[3].Path}, []string{"POST", "/repos/someone/scratch/issues/4/comments"})
	var comment struct{ Body string }
	must(t, json.Unmarshal([]byte(asked[3].Body), &comment))
	same(t, comment.Body, "Hello <there>")
	same(t, []string{asked[4].Method, asked[4].Path}, []string{"PATCH", "/repos/someone/scratch/issues/9"})
	same(t, asked[4].Body, `{"title":"New","labels":[]}`)
	same(t, asked[5].Body, `{"assignees":[],"state":"closed","state_reason":"completed"}`)
}

func TestCreatingAnIssueSendsTheDraftAndReadsItsNumberAndID(t *testing.T) {
	stand, client := serve(t, answers(201, `{"number": 12, "id": 4000000001, "title": "T"}`))
	made, err := client.Create(NewIssue{Title: "T", Body: "B"})
	must(t, err)
	// The database id is larger than fits in thirty-two bits.
	same(t, made, Created{Number: 12, ID: 4000000001})
	asked := stand.requests()
	same(t, []string{asked[0].Method, asked[0].Path}, []string{"POST", "/repos/someone/scratch/issues"})
	same(t, asked[0].Body, `{"title":"T","body":"B","labels":[]}`)
}

func TestARefusalFromGitHubIsPassedOnInItsOwnWords(t *testing.T) {
	_, client := serve(t, answers(422,
		`{"message": "Validation Failed", "errors": [{"message": "Sub-issue already has a parent"}, "plain words", {"code": "x"}]}`,
	))
	err := client.SetParent(1, 2)
	wantRefused(t, err, `^GitHub refused: Validation Failed Sub-issue already has a parent plain words$`)
	noToken(t, err)
	// An answer that is not JSON at all still gives a plain sentence.
	_, client = serve(t, answers(418, "<html>teapot</html>"))
	wantRefused(t, client.AddComment(1, "x"), `^GitHub refused the request \(status 418\)\.$`)
}

func TestALimitAndARefusedLoginAreSaidInTheSameWordsAsBefore(t *testing.T) {
	// The hourly limit: 403 with nothing remaining.
	_, client := serve(t, func(_ seen, reply http.ResponseWriter) {
		reply.Header().Set("X-RateLimit-Remaining", "0")
		reply.Header().Set("X-RateLimit-Reset", "1791603725")
		reply.WriteHeader(403)
		io.WriteString(reply, `{"message": "API rate limit exceeded for user ID 1."}`)
	})
	_, err := client.HasIssues()
	wantRefused(t, err, `^GitHub's hourly limit on requests is used up\. It lifts at \d\d:\d\d\.$`)
	noToken(t, err)

	// Too many in a short time: 403 with "retry-after".
	_, client = serve(t, func(_ seen, reply http.ResponseWriter) {
		reply.Header().Set("Retry-After", "30")
		reply.WriteHeader(403)
		io.WriteString(reply, `{"message": "You have exceeded a secondary rate limit"}`)
	})
	_, err = client.Comments(1)
	wantRefused(t, err, `^GitHub asked to slow down \(too many requests in a short time\)\. Try again in 30 seconds\.$`)

	// A login GitHub does not accept: its own kind of failure, so a caller
	// with a screen can offer to sign in.
	_, client = serve(t, answers(401, `{"message": "Bad credentials"}`))
	_, err = client.HasIssues()
	wantFailure(t, err, tracker.KindNotSignedIn, `.`)
	same(t, err.Error(),
		"GitHub did not accept the login; it may have expired. Sign in with `gh auth login`, "+
			"or set GH_TOKEN to a token that may read and write the repository's issues.")
	noToken(t, err)

	// The rest of the statuses, through the client.
	for _, check := range []struct {
		status  int
		body    string
		pattern string
	}{
		{403, `{"message": "Resource not accessible by integration"}`, `^GitHub refused: this login may not do that here\. Resource not accessible by integration$`},
		{404, `{"message": "Not Found"}`, `^GitHub found no such repository or issue, or this login may not see it\.$`},
		{410, `{"message": "Issues are disabled for this repo"}`, `^Issues are switched off for this repository on GitHub\.$`},
		{502, ``, `^GitHub is having trouble \(status 502\)\. Try again in a moment\.$`},
	} {
		_, client = serve(t, answers(check.status, check.body))
		_, err = client.HasIssues()
		wantRefused(t, err, check.pattern)
	}

	// GraphQL says the limit is used up inside an answer that succeeded.
	_, client = serve(t, answers(200, `{"data": null, "errors": [{"type": "RATE_LIMITED", "message": "API rate limit exceeded"}]}`))
	_, err = client.Issue(1)
	wantRefused(t, err, `^GitHub's hourly limit on requests is used up\. Try again within the hour\.$`)
}

func TestAnIssueIsReadFromGraphQL(t *testing.T) {
	ref := func(number int, state string) map[string]any {
		return map[string]any{"number": number, "title": fmt.Sprintf("T%d", number), "state": state}
	}
	nodes := func(refs ...map[string]any) map[string]any { return map[string]any{"nodes": refs} }
	stand, client := serve(t, answers(200, jsonText(t, map[string]any{"data": map[string]any{
		"repository": map[string]any{"issue": map[string]any{
			"number": 7, "title": "Seven", "state": "CLOSED",
			"databaseId": 4000000007, "body": "The body", "stateReason": "NOT_PLANNED",
			"createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-02-01T00:00:00Z",
			"assignees": map[string]any{"nodes": []any{map[string]any{"login": "kim"}}},
			"labels": map[string]any{"nodes": []any{
				map[string]any{"name": "type:bug"}, map[string]any{"name": "urgent"},
			}},
			"comments":  map[string]any{"totalCount": 3},
			"subIssues": nodes(ref(8, "OPEN")),
			"blockedBy": nodes(ref(9, "CLOSED")),
			"blocking":  nodes(ref(10, "OPEN")),
			"parent": map[string]any{
				"number": 5, "title": "T5", "state": "OPEN", "blockedBy": nodes(ref(4, "OPEN")),
				"parent": map[string]any{
					"number": 2, "title": "T2", "state": "OPEN", "blockedBy": nodes(), "parent": nil,
				},
			},
		}},
	}})))
	issue, err := client.Issue(7)
	must(t, err)
	same(t, *issue, Issue{
		Ref:          Ref{Number: 7, Title: "Seven", State: "closed"},
		ID:           4000000007,
		Body:         "The body",
		StateReason:  tracker.Ptr("not planned"),
		CreatedAt:    "2026-01-01T00:00:00Z",
		UpdatedAt:    "2026-02-01T00:00:00Z",
		Assignee:     tracker.Ptr("kim"),
		Labels:       []string{"type:bug", "urgent"},
		CommentCount: 3,
		Parent: &Parent{
			Ref:       Ref{Number: 5, Title: "T5", State: "open"},
			BlockedBy: []Ref{{Number: 4, Title: "T4", State: "open"}},
			Parent: &Parent{
				Ref:       Ref{Number: 2, Title: "T2", State: "open"},
				BlockedBy: []Ref{},
			},
		},
		SubIssues: []Ref{{Number: 8, Title: "T8", State: "open"}},
		BlockedBy: []Ref{{Number: 9, Title: "T9", State: "closed"}},
		Blocking:  []Ref{{Number: 10, Title: "T10", State: "open"}},
	})
	// One request, to GraphQL, naming the repository and the number.
	asked := stand.requests()
	same(t, len(asked), 1)
	same(t, []string{asked[0].Method, asked[0].Path}, []string{"POST", "/graphql"})
	var sent struct {
		Query     string
		Variables map[string]any
	}
	must(t, json.Unmarshal([]byte(asked[0].Body), &sent))
	same(t, sent.Variables, map[string]any{"owner": "someone", "name": "scratch", "number": float64(7)})
	if !strings.Contains(sent.Query, "fragment Up on Issue") || !strings.Contains(sent.Query, "issue(number: $number)") {
		t.Fatalf("unexpected query: %s", sent.Query)
	}

	// An issue with nothing in it: no description, nobody, no parent.
	_, client = serve(t, answers(200, `{"data": {"repository": {"issue": {
		"number": 1, "title": "Bare", "state": "OPEN", "databaseId": 11, "body": null, "stateReason": null,
		"createdAt": "", "updatedAt": "", "assignees": {"nodes": []}, "labels": {"nodes": []},
		"comments": {"totalCount": 0}, "subIssues": {"nodes": []}, "blockedBy": {"nodes": []},
		"blocking": {"nodes": []}, "parent": null}}}}`))
	issue, err = client.Issue(1)
	must(t, err)
	same(t, *issue, Issue{
		Ref: Ref{Number: 1, Title: "Bare", State: "open"}, ID: 11,
		Labels: []string{}, SubIssues: []Ref{}, BlockedBy: []Ref{}, Blocking: []Ref{},
	})
}

func TestAMissingIssueIsNoneAndAnyOtherGraphQLErrorIsARefusal(t *testing.T) {
	// GraphQL: a missing issue is "none"...
	_, client := serve(t, answers(200, `{"data": {"repository": {"issue": null}},
		"errors": [{"type": "NOT_FOUND", "message": "Could not resolve to an Issue"}]}`))
	issue, err := client.Issue(999)
	must(t, err)
	if issue != nil {
		t.Fatalf("want no issue, got %#v", issue)
	}
	// ...a repository this login cannot see is said as that, not as a
	// missing issue...
	_, client = serve(t, answers(200, `{"data": {"repository": null},
		"errors": [{"type": "NOT_FOUND", "message": "Could not resolve to a Repository"}]}`))
	_, err = client.Issue(1)
	wantRefused(t, err, `no such repository or issue`)
	_, err = client.Refs([]int{1})
	wantRefused(t, err, `no such repository or issue`)
	_, err = client.Issues(ListOptions{State: "open"})
	wantRefused(t, err, `no such repository or issue`)
	// ...and any other error is a refusal in GitHub's words.
	_, client = serve(t, answers(200, `{"data": null, "errors": [{"type": "FORBIDDEN", "message": "No access"}]}`))
	_, err = client.Issue(1)
	wantRefused(t, err, `^GitHub refused: No access$`)
	// An answer with nothing in it, or one that cannot be read, says so.
	for _, body := range []string{`{}`, `{"data": null}`, ``, `not json`, `{"data": {"repository": "odd"}}`} {
		_, client = serve(t, answers(200, body))
		_, err = client.Issue(1)
		wantRefused(t, err, `^GitHub refused: it gave no answer\.$`)
	}
}

func TestPointersToSeveralIssuesComeInOneRequest(t *testing.T) {
	stand, client := serve(t, answers(200, `{"data": {"repository": {
		"i1": null,
		"i2": {"number": 9, "title": "Nine", "state": "CLOSED"},
		"i0": {"number": 3, "title": "Three", "state": "OPEN"}}},
		"errors": [{"type": "NOT_FOUND", "message": "Could not resolve to an Issue"}]}`))
	refs, err := client.Refs([]int{3, 404, 9})
	must(t, err)
	// In the order asked, with the one that does not exist left out.
	same(t, refs, []Ref{{Number: 3, Title: "Three", State: "open"}, {Number: 9, Title: "Nine", State: "closed"}})
	asked := stand.requests()
	same(t, len(asked), 1)
	for _, field := range []string{"i0: issue(number: 3)", "i1: issue(number: 404)", "i2: issue(number: 9)"} {
		if !strings.Contains(asked[0].Body, field) {
			t.Fatalf("the query does not ask for %q: %s", field, asked[0].Body)
		}
	}
	// None asked for: nothing is sent.
	refs, err = client.Refs(nil)
	must(t, err)
	same(t, refs, []Ref{})
	same(t, client.Requests(), 1)
}

func TestARestListIsReadPageByPage(t *testing.T) {
	// 205 comments: two full pages of a hundred and a last one of five.
	stand, client := serve(t, func(request seen, reply http.ResponseWriter) {
		first, count := 0, 0
		switch {
		case strings.HasSuffix(request.Path, "&page=1"):
			first, count = 1, 100
		case strings.HasSuffix(request.Path, "&page=2"):
			first, count = 101, 100
		case strings.HasSuffix(request.Path, "&page=3"):
			first, count = 201, 5
		}
		rows := []map[string]any{}
		for id := first; id < first+count; id++ {
			row := map[string]any{
				"id": id, "user": map[string]any{"login": "kim"},
				"created_at": "2026-01-01T00:00:00Z", "body": fmt.Sprintf("Comment %d", id),
			}
			if id == 205 {
				// A comment whose account is gone, with no text.
				row["user"], row["body"] = nil, nil
			}
			rows = append(rows, row)
		}
		json.NewEncoder(reply).Encode(rows)
	})
	comments, err := client.Comments(7)
	must(t, err)
	same(t, len(comments), 205)
	same(t, comments[0], Comment{ID: "1", Author: "kim", CreatedAt: "2026-01-01T00:00:00Z", Body: "Comment 1"})
	same(t, comments[203].Body, "Comment 204")
	same(t, comments[204], Comment{ID: "205", Author: "", CreatedAt: "2026-01-01T00:00:00Z", Body: ""})
	paths := []string{}
	for _, request := range stand.requests() {
		paths = append(paths, request.Method+" "+request.Path)
	}
	same(t, paths, []string{
		"GET /repos/someone/scratch/issues/7/comments?per_page=100&page=1",
		"GET /repos/someone/scratch/issues/7/comments?per_page=100&page=2",
		"GET /repos/someone/scratch/issues/7/comments?per_page=100&page=3",
	})
	same(t, client.Requests(), 3)

	// No comments at all: an empty list, from one request.
	_, client = serve(t, answers(200, `[]`))
	comments, err = client.Comments(7)
	must(t, err)
	same(t, comments, []Comment{})
	same(t, client.Requests(), 1)
}

func TestAListOfIssuesFollowsGitHubsCursor(t *testing.T) {
	stand, client := serve(t, func(request seen, reply http.ResponseWriter) {
		var sent struct{ Variables map[string]any }
		json.Unmarshal([]byte(request.Body), &sent)
		page := map[string]any{
			"pageInfo": map[string]any{"hasNextPage": true, "endCursor": "CURSOR-1"},
			"nodes":    []any{node(1, "someone/scratch")},
		}
		if sent.Variables["after"] == "CURSOR-1" {
			page = map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil},
				"nodes":    []any{node(2, "someone/scratch")},
			}
		}
		json.NewEncoder(reply).Encode(map[string]any{
			"data": map[string]any{"repository": map[string]any{"issues": page}},
		})
	})
	found, err := client.Issues(ListOptions{State: "all", Since: tracker.Ptr("2026-02-01T00:00:00Z")})
	must(t, err)
	same(t, []int{found[0].Number, found[1].Number}, []int{1, 2})
	same(t, len(found), 2)
	// What was asked: both states, the moment, and the cursor the second
	// time.
	variables := []map[string]any{}
	for _, request := range stand.requests() {
		var sent struct{ Variables map[string]any }
		must(t, json.Unmarshal([]byte(request.Body), &sent))
		variables = append(variables, sent.Variables)
	}
	same(t, variables, []map[string]any{
		{"owner": "someone", "name": "scratch", "states": []any{"OPEN", "CLOSED"}, "since": "2026-02-01T00:00:00Z", "after": nil},
		{"owner": "someone", "name": "scratch", "states": []any{"OPEN", "CLOSED"}, "since": "2026-02-01T00:00:00Z", "after": "CURSOR-1"},
	})

	// One state and no moment; a repository with no issues gives an empty
	// list.
	stand, client = serve(t, answers(200, `{"data": {"repository": {"issues":
		{"pageInfo": {"hasNextPage": false, "endCursor": null}, "nodes": []}}}}`))
	found, err = client.Issues(ListOptions{State: "open"})
	must(t, err)
	same(t, found, []Issue{})
	var sent struct{ Variables map[string]any }
	must(t, json.Unmarshal([]byte(stand.requests()[0].Body), &sent))
	same(t, sent.Variables["states"], any([]any{"OPEN"}))
	same(t, sent.Variables["since"], any(nil))
}

func TestASearchAnswerIsNarrowedToThisRepository(t *testing.T) {
	// A search answer is narrowed to this repository, whatever the text
	// asked.
	stand, client := serve(t, answers(200, jsonText(t, map[string]any{"data": map[string]any{
		"search": map[string]any{"nodes": []any{
			node(1, "Someone/Scratch"), node(7, "other/secret"), map[string]any{},
		}},
	}})))
	found, err := client.Search("crash repo:other/secret")
	must(t, err)
	same(t, len(found), 1)
	same(t, found[0].Number, 1)
	var sent struct{ Variables map[string]string }
	must(t, json.Unmarshal([]byte(stand.requests()[0].Body), &sent))
	same(t, sent.Variables["query"], "repo:someone/scratch is:issue crash repo:other/secret")
}

func TestWhoIsSignedInIsAskedOnceAndIssuesSwitchedOffIsRead(t *testing.T) {
	_, client := serve(t, answers(200, `{"data": {"viewer": {"login": "octo"}}}`))
	for range 3 {
		login, err := client.Viewer()
		must(t, err)
		same(t, login, "octo")
	}
	same(t, client.Requests(), 1)

	for body, want := range map[string]bool{
		`{"has_issues": true}`: true, `{"has_issues": false}`: false, `{"name": "scratch"}`: true,
	} {
		stand, client := serve(t, answers(200, body))
		has, err := client.HasIssues()
		must(t, err)
		same(t, has, want, body)
		same(t, stand.requests()[0].Path, "/repos/someone/scratch")
	}
}

func TestTheAdapterWorksOnTheRealClient(t *testing.T) {
	// The adapter on the real client, not the stand-in: an id that names
	// no issue is refused in the adapter's words, and what is known without
	// asking costs no request.
	stand, client := serve(t, answers(200, `{"data": {"repository": {"issue": null}}}`))
	adapter := New(client, "")
	same(t, *adapter.About().Repository, "someone/scratch")
	same(t, len(stand.requests()), 0)
	_, err := adapter.Show("12")
	wantRefused(t, err, `^There is no issue with id 12\.$`)
}
