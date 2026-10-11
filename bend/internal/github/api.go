// api.go — the connection to GitHub.
//
// What: the handful of things the GitHub adapter asks GitHub for, as one
// interface (Client), and its real implementation: signing in, sending
// requests, paging, and saying in plain words why a request failed.
//
// Why: everything that knows GitHub's wire format is here, and everything
// that knows how an issue is mapped is in github.go. The adapter is handed a
// client, so its rules are tested against an in-memory stand-in (fake.go)
// with no network, and this file is tested against a stand-in web server
// (api_test.go).
//
// Design notes:
//   - Reading uses GitHub's GraphQL interface: one request brings an issue
//     with its parent, its sub-issues and what blocks it, where the REST
//     interface would need a request for each. Changing uses REST, which has
//     a plain call for every change needed.
//   - Requests are sent by this program itself, not by running `gh` each
//     time: a process per request is slow, and a caller that keeps a copy of
//     the issues will send many from one long-lived process.
//   - The login is the one the `gh` program already holds: GH_TOKEN or
//     GITHUB_TOKEN if set, else `gh auth token`, asked once per client.
//   - The parent chain is read four levels up. An issue waits for what the
//     issues it sits inside wait for; deeper nesting than that is rare, and
//     each level costs a join on every issue of every list.
//   - The address of GitHub can be replaced (ClientOptions.BaseURL), which is
//     how the tests point the client at a stand-in server.
//
// Gotchas:
//   - The token is kept in memory only and must never reach a message or a
//     log. Failures are worded from GitHub's answer, not from the request.
//   - GraphQL reports a missing issue as an error next to `data` with a null
//     in it, not as a failed request.
//   - A sub-issue and a blocker are named by the issue's database id in
//     request bodies, not by its number.
//   - GitHub's `since` on a list of issues means "updated at or after".
//   - A set of labels or assignees that is to be emptied must be sent as an
//     empty list, which is why Changes holds pointers to lists: nil leaves
//     the set alone, a pointer to an empty list empties it.

package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// Ref is a short pointer to an issue, as GitHub gives it.
type Ref struct {
	Number int
	Title  string
	// State is "open" or "closed".
	State string
}

// Parent is an issue an issue sits inside, with what that one waits for.
type Parent struct {
	Ref
	BlockedBy []Ref
	// Parent is the next issue up; nil at the top, or past the fourth level.
	Parent *Parent
}

// Issue is one issue, with everything the adapter maps.
type Issue struct {
	Ref
	// ID is the database id, which sub-issue and blocker calls ask for.
	ID   int64
	Body string
	// StateReason is GitHub's word for why it was closed, lower case; nil
	// when open.
	StateReason *string
	CreatedAt   string
	UpdatedAt   string
	// Assignee is the first assignee's login; nil when there is none.
	Assignee     *string
	Labels       []string
	CommentCount int
	Parent       *Parent
	SubIssues    []Ref
	BlockedBy    []Ref
	Blocking     []Ref
}

// Comment is one comment, as GitHub gives it.
type Comment struct {
	ID        string
	Author    string
	CreatedAt string
	Body      string
}

// Changes is what Update can change; a field left nil or "" is left as it
// is.
type Changes struct {
	Title *string
	Body  *string
	// Labels is the whole set of labels the issue is to carry. A pointer to
	// an empty list takes every label off.
	Labels *[]string
	// Assignees is the whole set of assignees, by login. A pointer to an
	// empty list leaves the issue with nobody.
	Assignees *[]string
	// State is "open" or "closed".
	State string
	// StateReason is "completed", "not_planned" or "reopened".
	StateReason string
}

// ListOptions narrow what Issues gives.
type ListOptions struct {
	// State is "open", "closed" or "all".
	State string
	// Since narrows to the issues updated at or after this moment (an ISO
	// date and time); nil does not narrow.
	Since *string
}

// NewIssue is what Create makes an issue from.
type NewIssue struct {
	Title  string
	Body   string
	Labels []string
}

// Created names a new issue: its number and its database id.
type Created struct {
	Number int
	ID     int64
}

// Client is everything the adapter asks of GitHub, for one repository.
//
// Every method fails with a *tracker.Error, in plain words, when GitHub
// cannot be reached, the login is missing or not accepted (kind
// tracker.KindNotSignedIn), a limit is hit, or GitHub says no. A missing
// issue is not a failure where the answer can say so (Issue gives nil, Refs
// leaves it out).
type Client interface {
	// Repository is "owner/name". Nothing is asked of GitHub.
	Repository() string
	// Viewer is the login of the signed-in account.
	Viewer() (string, error)
	// HasIssues says whether the repository has issues switched on.
	HasIssues() (bool, error)
	// Issue gives one issue; nil, with no error, when there is none with
	// that number.
	Issue(number int) (*Issue, error)
	// Refs gives pointers to these issues; one that does not exist is left
	// out.
	Refs(numbers []int) ([]Ref, error)
	// Issues gives every issue in a state, oldest first; pull requests are
	// not issues.
	Issues(options ListOptions) ([]Issue, error)
	// Search gives the issues matching free text, best match first; at most
	// fifty.
	Search(text string) ([]Issue, error)
	// Comments gives an issue's comments, oldest first.
	Comments(number int) ([]Comment, error)
	// Create makes an issue and returns its number and database id.
	Create(draft NewIssue) (Created, error)
	Update(number int, changes Changes) error
	AddComment(number int, body string) error
	// SetParent puts an issue under a parent, taking it out of any other.
	SetParent(parentNumber int, childID int64) error
	RemoveParent(parentNumber int, childID int64) error
	// AddBlockedBy records that number waits for the issue with database id
	// blockerID.
	AddBlockedBy(number int, blockerID int64) error
	RemoveBlockedBy(number int, blockerID int64) error
	// Requests is how many requests this client has sent; for tests of what
	// a read costs.
	Requests() int
}

// signIn is how to sign in, said wherever a login is missing or refused.
const signIn = "Sign in with `gh auth login`, or set GH_TOKEN to a token that may read and write the repository's issues."

// defaultBaseURL is where GitHub's interface is, when no other address is
// given.
const defaultBaseURL = "https://api.github.com"

// ghTimeout is how long `gh auth token` may take before it is given up on.
const ghTimeout = 10 * time.Second

// findToken gives the token to sign in with: from the environment, else from
// `gh`.
//
// Fails with kind tracker.KindNotSignedIn when there is none: `gh` is not
// installed, or it holds no login.
// Side effects: may run `gh auth token` once.
func findToken() (string, error) {
	for _, name := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if given := strings.TrimSpace(os.Getenv(name)); given != "" {
			return given, nil
		}
	}
	limit, cancel := context.WithTimeout(context.Background(), ghTimeout)
	defer cancel()
	// Only what gh prints as its answer is read. What it prints about a
	// failure is dropped, so nothing of it can reach a message.
	output, err := exec.CommandContext(limit, "gh", "auth", "token").Output()
	token := strings.TrimSpace(string(output))
	if err == nil && token != "" {
		return token, nil
	}
	return "", tracker.Failed(tracker.KindNotSignedIn, "Not signed in to GitHub. %s", signIn)
}

// refFields are the fields read for a pointer to an issue.
const refFields = "number title state"

// issueFields are the fields read for an issue. The numbers are upper bounds
// on what is read with each issue, not on what GitHub allows; an issue with
// more sub-issues or blockers than this shows the first of them.
const issueFields = `
  ` + refFields + ` databaseId body stateReason createdAt updatedAt
  assignees(first: 1) { nodes { login } }
  labels(first: 100) { nodes { name } }
  comments { totalCount }
  subIssues(first: 100) { nodes { ` + refFields + ` } }
  blockedBy(first: 50) { nodes { ` + refFields + ` } }
  blocking(first: 50) { nodes { ` + refFields + ` } }
  parent { ...Up parent { ...Up parent { ...Up parent { ...Up } } } }
`

// upFragment is one level of the parent chain; see the header for why four
// are read.
const upFragment = `fragment Up on Issue { ` + refFields + ` blockedBy(first: 50) { nodes { ` + refFields + ` } } }`

// rawRef is a pointer as GraphQL gives it.
type rawRef struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	State  string `json:"state"`
}

// rawRefs is a list of pointers as GraphQL wraps it.
type rawRefs struct {
	Nodes []rawRef `json:"nodes"`
}

// rawParent is one level of the parent chain as GraphQL gives it.
type rawParent struct {
	rawRef
	BlockedBy rawRefs    `json:"blockedBy"`
	Parent    *rawParent `json:"parent"`
}

// rawIssue is an issue as GraphQL gives it.
type rawIssue struct {
	rawRef
	DatabaseID  int64   `json:"databaseId"`
	Body        *string `json:"body"`
	StateReason *string `json:"stateReason"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	Assignees   struct {
		Nodes []struct {
			Login string `json:"login"`
		} `json:"nodes"`
	} `json:"assignees"`
	Labels struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
	Comments struct {
		TotalCount int `json:"totalCount"`
	} `json:"comments"`
	SubIssues rawRefs    `json:"subIssues"`
	BlockedBy rawRefs    `json:"blockedBy"`
	Blocking  rawRefs    `json:"blocking"`
	Parent    *rawParent `json:"parent"`
}

// toRef turns GraphQL's shape of a pointer into this file's. Pure.
func toRef(raw rawRef) Ref {
	state := "open"
	if raw.State == "CLOSED" {
		state = "closed"
	}
	return Ref{Number: raw.Number, Title: raw.Title, State: state}
}

// toRefs turns a list of pointers; the result is never nil.
func toRefs(raw rawRefs) []Ref {
	refs := make([]Ref, 0, len(raw.Nodes))
	for _, node := range raw.Nodes {
		refs = append(refs, toRef(node))
	}
	return refs
}

// toParent turns GraphQL's shape of the parent chain into this file's; nil
// for no parent. Pure.
func toParent(raw *rawParent) *Parent {
	if raw == nil {
		return nil
	}
	return &Parent{
		Ref:       toRef(raw.rawRef),
		BlockedBy: toRefs(raw.BlockedBy),
		Parent:    toParent(raw.Parent),
	}
}

// toGhIssue turns GraphQL's shape of an issue into this file's. Pure.
func toGhIssue(raw rawIssue) Issue {
	issue := Issue{
		Ref:          toRef(raw.rawRef),
		ID:           raw.DatabaseID,
		CreatedAt:    raw.CreatedAt,
		UpdatedAt:    raw.UpdatedAt,
		Labels:       make([]string, 0, len(raw.Labels.Nodes)),
		CommentCount: raw.Comments.TotalCount,
		Parent:       toParent(raw.Parent),
		SubIssues:    toRefs(raw.SubIssues),
		BlockedBy:    toRefs(raw.BlockedBy),
		Blocking:     toRefs(raw.Blocking),
	}
	if raw.Body != nil {
		issue.Body = *raw.Body
	}
	if raw.StateReason != nil {
		reason := strings.ReplaceAll(strings.ToLower(*raw.StateReason), "_", " ")
		issue.StateReason = &reason
	}
	if len(raw.Assignees.Nodes) > 0 {
		login := raw.Assignees.Nodes[0].Login
		issue.Assignee = &login
	}
	for _, label := range raw.Labels.Nodes {
		issue.Labels = append(issue.Labels, label.Name)
	}
	return issue
}

// clock gives a time of day a person can read, for "try again at".
func clock(epochSeconds float64) string {
	return time.Unix(int64(epochSeconds), 0).Local().Format("15:04")
}

// headerNumber reads a header as a number, the way a missing or unreadable
// one counts for nothing: 0 when it is absent, not a number, or not finite.
func headerNumber(headers http.Header, name string) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(headers.Get(name)), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

// slowDownWords is how GitHub's own message names its limit on bursts.
var slowDownWords = regexp.MustCompile(`(?i)secondary rate limit|abuse`)

// explainFailure says why a request failed, in plain words, from GitHub's
// answer.
//
// status is the HTTP status; headers are the response's headers (the
// rate-limit ones are read); detail is GitHub's own message, "" when it gave
// none.
func explainFailure(status int, headers http.Header, detail string) string {
	remaining := headers.Get("x-ratelimit-remaining")
	reset := headerNumber(headers, "x-ratelimit-reset")
	retryAfter := headerNumber(headers, "retry-after")
	limited := status == 403 || status == 429
	if limited && remaining == "0" {
		lifts := "the top of the hour"
		if reset > 0 {
			lifts = clock(reset)
		}
		return "GitHub's hourly limit on requests is used up. It lifts at " + lifts + "."
	}
	if limited && (retryAfter > 0 || slowDownWords.MatchString(detail)) {
		wait := "a minute"
		if retryAfter > 0 {
			wait = strconv.FormatFloat(retryAfter, 'f', -1, 64) + " seconds"
		}
		return "GitHub asked to slow down (too many requests in a short time). Try again in " + wait + "."
	}
	switch {
	case status == 401:
		return "GitHub did not accept the login; it may have expired. " + signIn
	case status == 403:
		return strings.TrimSpace("GitHub refused: this login may not do that here. " + detail)
	case status == 404:
		return "GitHub found no such repository or issue, or this login may not see it."
	case status == 410:
		return "Issues are switched off for this repository on GitHub."
	case status >= 500:
		return fmt.Sprintf("GitHub is having trouble (status %d). Try again in a moment.", status)
	case detail == "":
		return fmt.Sprintf("GitHub refused the request (status %d).", status)
	default:
		return "GitHub refused: " + detail
	}
}

// mayWorkLater says whether a failed request may work when made again
// later: the login was not accepted (signing in cures it), GitHub was
// having trouble, or a limit was reached. Anything else GitHub said no to
// is the request's own fault.
func mayWorkLater(status int, headers http.Header, detail string) bool {
	if status == http.StatusUnauthorized || status >= 500 || status == http.StatusTooManyRequests {
		return true
	}
	return status == http.StatusForbidden && (headers.Get("x-ratelimit-remaining") == "0" ||
		headerNumber(headers, "retry-after") > 0 || slowDownWords.MatchString(detail))
}

// noSuchRepository is the failure for a repository that is not there, or
// that this login may not see.
func noSuchRepository() error {
	return tracker.Refused("%s", explainFailure(404, http.Header{}, ""))
}

// noAnswer is the failure for an answer that says nothing usable: GitHub
// reported success, but what it sent is missing or cannot be read.
func noAnswer() error {
	return tracker.Refused("GitHub refused: it gave no answer.")
}

// ClientOptions are the replaceable parts of the real client; every one may
// be left empty.
type ClientOptions struct {
	// BaseURL is where GitHub's interface is; https://api.github.com when
	// "". Tests point it at a stand-in server.
	BaseURL string
	// Token gives the token to sign in with; asked once. The default looks
	// in the environment and then asks `gh` (findToken).
	Token func() (string, error)
	// HTTP sends the requests; a client with the timeouts of defaultHTTP
	// when nil.
	HTTP *http.Client
}

// defaultHTTP builds the sender used when none is given.
//
// The timeouts are the ones the TypeScript version ran with (node's own
// sender): ten seconds to connect, five minutes for the answer to begin.
// There is no limit on the whole request, as there was none there.
func defaultHTTP() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	transport.ResponseHeaderTimeout = 5 * time.Minute
	return &http.Client{Transport: transport}
}

// realClient is the Client that talks to GitHub.
type realClient struct {
	repository string
	owner      string
	name       string
	// base is the path of the repository in the REST interface.
	base    string
	baseURL string
	http    *http.Client
	token   func() (string, error)
	// sent counts the requests sent.
	sent atomic.Int64

	// The token is asked for once, and the answer kept, a failure too.
	tokenOnce sync.Once
	bearer    string
	tokenErr  error

	// The signed-in account is asked for once, and the answer kept, a
	// failure too.
	whoAmI    sync.Once
	login     string
	viewerErr error
}

// NewClient builds the real client for one repository.
//
// repository is "owner/name". options replace the address, the login and the
// sender; see ClientOptions.
// Side effects: none until a method is called; then HTTPS requests to
// GitHub, which read or change the repository's issues.
func NewClient(repository string, options ClientOptions) Client {
	owner, name, _ := strings.Cut(repository, "/")
	client := &realClient{
		repository: repository,
		owner:      owner,
		name:       name,
		base:       "/repos/" + owner + "/" + name,
		baseURL:    strings.TrimRight(options.BaseURL, "/"),
		http:       options.HTTP,
		token:      options.Token,
	}
	if client.baseURL == "" {
		client.baseURL = defaultBaseURL
	}
	if client.http == nil {
		client.http = defaultHTTP()
	}
	if client.token == nil {
		client.token = findToken
	}
	return client
}

// failureDetail gives GitHub's own words from the body of a refused request:
// its message, then the message of each error it lists. "" when the body
// holds none, or is not JSON.
func failureDetail(body []byte) string {
	var answer struct {
		Message any `json:"message"`
		Errors  any `json:"errors"`
	}
	// Not JSON: nothing is taken from it.
	_ = json.Unmarshal(body, &answer)
	parts := []string{}
	if message, ok := answer.Message.(string); ok && message != "" {
		parts = append(parts, message)
	}
	if errors, ok := answer.Errors.([]any); ok {
		for _, entry := range errors {
			switch found := entry.(type) {
			case string:
				if found != "" {
					parts = append(parts, found)
				}
			case map[string]any:
				if message, ok := found["message"].(string); ok && message != "" {
					parts = append(parts, message)
				}
			}
		}
	}
	return strings.Join(parts, " ")
}

// request sends one request and reads the answer.
//
// path starts with "/"; "/graphql" for GraphQL. body, when not nil, is sent
// as JSON. answer, when not nil, is what the JSON answer is read into.
//
// Fails in plain words for every kind of failure: kind
// tracker.KindNotSignedIn when there is no login or GitHub does not accept
// it, a refusal otherwise. An answer that reports success but cannot be read
// into answer is a refusal too.
// Side effects: asks for the token the first time; one HTTP request.
func (client *realClient) request(method, path string, body, answer any) error {
	client.tokenOnce.Do(func() { client.bearer, client.tokenErr = client.token() })
	if client.tokenErr != nil {
		// Signing in cures it: a change that waits to be sent keeps waiting.
		var failure *tracker.Error
		if errors.As(client.tokenErr, &failure) {
			later := *failure
			later.Later = true
			return &later
		}
		return client.tokenErr
	}
	client.sent.Add(1)
	// The cause of a failure to send is not passed on: it can name the
	// request, and nothing about the request belongs in a message.
	unreachable := tracker.Refused("GitHub could not be reached. Check the network connection and try again.")
	unreachable.Later = true
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return unreachable
		}
		payload = bytes.NewReader(encoded)
	}
	asked, err := http.NewRequest(method, client.baseURL+path, payload)
	if err != nil {
		return unreachable
	}
	asked.Header.Set("Authorization", "Bearer "+client.bearer)
	asked.Header.Set("Accept", "application/vnd.github+json")
	asked.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	asked.Header.Set("User-Agent", "bend")
	if body != nil {
		asked.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(asked)
	if err != nil {
		return unreachable
	}
	defer response.Body.Close()
	text, err := io.ReadAll(response.Body)
	if err != nil {
		return unreachable
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		detail := failureDetail(text)
		words := explainFailure(response.StatusCode, response.Header, detail)
		failure := tracker.Refused("%s", words)
		if response.StatusCode == http.StatusUnauthorized {
			failure = tracker.Failed(tracker.KindNotSignedIn, "%s", words)
		}
		failure.Later = mayWorkLater(response.StatusCode, response.Header, detail)
		return failure
	}
	if answer == nil {
		return nil
	}
	if json.Unmarshal(text, answer) != nil {
		return noAnswer()
	}
	return nil
}

// graphql sends one GraphQL request and reads `data` into data.
//
// A missing issue is not a failure: its place in `data` is null and the
// caller decides what that means. Any other error GraphQL reports is a
// refusal.
func (client *realClient) graphql(query string, variables map[string]any, data any) error {
	var answer struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	body := struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}{query, variables}
	if err := client.request("POST", "/graphql", body, &answer); err != nil {
		return err
	}
	messages := []string{}
	for _, failure := range answer.Errors {
		if failure.Type == "NOT_FOUND" {
			continue
		}
		if failure.Type == "RATE_LIMITED" {
			limited := tracker.Refused("GitHub's hourly limit on requests is used up. Try again within the hour.")
			limited.Later = true
			return limited
		}
		messages = append(messages, failure.Message)
	}
	missing := len(answer.Data) == 0 || string(answer.Data) == "null"
	if len(messages) > 0 || missing {
		words := strings.Join(messages, " ")
		if words == "" {
			words = "it gave no answer."
		}
		return tracker.Refused("GitHub refused: %s", words)
	}
	if json.Unmarshal(answer.Data, data) != nil {
		return noAnswer()
	}
	return nil
}

// everyPage gives every page of a REST list, a hundred at a time.
//
// A function and not a method, because a method cannot have a type of its
// own for the rows.
func everyPage[Row any](client *realClient, path string) ([]Row, error) {
	rows := []Row{}
	joiner := "?"
	if strings.Contains(path, "?") {
		joiner = "&"
	}
	for page := 1; ; page++ {
		var batch []Row
		err := client.request("GET", fmt.Sprintf("%s%sper_page=100&page=%d", path, joiner, page), nil, &batch)
		if err != nil {
			return nil, err
		}
		rows = append(rows, batch...)
		if len(batch) < 100 {
			return rows, nil
		}
	}
}

// Repository is "owner/name".
func (client *realClient) Repository() string { return client.repository }

// Viewer is the login of the signed-in account; asked once, and the answer
// kept for the life of the client.
func (client *realClient) Viewer() (string, error) {
	client.whoAmI.Do(func() {
		var data struct {
			Viewer struct {
				Login string `json:"login"`
			} `json:"viewer"`
		}
		client.viewerErr = client.graphql("query { viewer { login } }", map[string]any{}, &data)
		client.login = data.Viewer.Login
	})
	return client.login, client.viewerErr
}

// HasIssues says whether the repository has issues switched on.
func (client *realClient) HasIssues() (bool, error) {
	var repo struct {
		HasIssues *bool `json:"has_issues"`
	}
	if err := client.request("GET", client.base, nil, &repo); err != nil {
		return false, err
	}
	return repo.HasIssues == nil || *repo.HasIssues, nil
}

// Issue gives one issue with its parents, sub-issues and blockers, in one
// request; nil when there is none with that number.
func (client *realClient) Issue(number int) (*Issue, error) {
	var data struct {
		Repository *struct {
			Issue *rawIssue `json:"issue"`
		} `json:"repository"`
	}
	err := client.graphql(
		upFragment+` query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) { issue(number: $number) { `+issueFields+` } }
        }`,
		map[string]any{"owner": client.owner, "name": client.name, "number": number},
		&data,
	)
	if err != nil {
		return nil, err
	}
	// No repository at all is not "no such issue": the name is wrong, or
	// this login may not see it. Said as that, so nobody goes looking for
	// an issue number.
	if data.Repository == nil {
		return nil, noSuchRepository()
	}
	if data.Repository.Issue == nil {
		return nil, nil
	}
	issue := toGhIssue(*data.Repository.Issue)
	return &issue, nil
}

// Refs gives pointers to these issues, in the order asked; one that does not
// exist is left out. No request is sent for an empty list.
func (client *realClient) Refs(numbers []int) ([]Ref, error) {
	if len(numbers) == 0 {
		return []Ref{}, nil
	}
	// One request for all of them, each under a name of its own.
	fields := make([]string, 0, len(numbers))
	for at, number := range numbers {
		fields = append(fields, fmt.Sprintf("i%d: issue(number: %d) { %s }", at, number, refFields))
	}
	var data struct {
		Repository map[string]*rawRef `json:"repository"`
	}
	err := client.graphql(
		`query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { `+strings.Join(fields, " ")+` }
        }`,
		map[string]any{"owner": client.owner, "name": client.name},
		&data,
	)
	if err != nil {
		return nil, err
	}
	if data.Repository == nil {
		return nil, noSuchRepository()
	}
	refs := []Ref{}
	for at := range numbers {
		if raw := data.Repository[fmt.Sprintf("i%d", at)]; raw != nil {
			refs = append(refs, toRef(*raw))
		}
	}
	return refs, nil
}

// Issues gives every issue in a state, oldest first, a hundred to a request.
func (client *realClient) Issues(options ListOptions) ([]Issue, error) {
	states := []string{strings.ToUpper(options.State)}
	if options.State == "all" {
		states = []string{"OPEN", "CLOSED"}
	}
	var since any
	if options.Since != nil {
		since = *options.Since
	}
	found := []Issue{}
	var after any
	for {
		var data struct {
			Repository *struct {
				Issues *struct {
					PageInfo struct {
						HasNextPage bool    `json:"hasNextPage"`
						EndCursor   *string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []rawIssue `json:"nodes"`
				} `json:"issues"`
			} `json:"repository"`
		}
		err := client.graphql(
			upFragment+` query($owner: String!, $name: String!, $states: [IssueState!], $since: DateTime, $after: String) {
            repository(owner: $owner, name: $name) {
              issues(first: 100, after: $after, states: $states, filterBy: { since: $since },
                     orderBy: { field: CREATED_AT, direction: ASC }) {
                pageInfo { hasNextPage endCursor }
                nodes { `+issueFields+` }
              }
            }
          }`,
			map[string]any{
				"owner": client.owner, "name": client.name,
				"states": states, "since": since, "after": after,
			},
			&data,
		)
		if err != nil {
			return nil, err
		}
		if data.Repository == nil || data.Repository.Issues == nil {
			return nil, noSuchRepository()
		}
		page := data.Repository.Issues
		for _, node := range page.Nodes {
			found = append(found, toGhIssue(node))
		}
		if !page.PageInfo.HasNextPage {
			return found, nil
		}
		after = nil
		if page.PageInfo.EndCursor != nil {
			after = *page.PageInfo.EndCursor
		}
	}
}

// Search gives the issues of this repository matching free text, best match
// first; at most fifty.
func (client *realClient) Search(text string) ([]Issue, error) {
	var data struct {
		Search struct {
			Nodes []struct {
				rawIssue
				Repository *struct {
					NameWithOwner string `json:"nameWithOwner"`
				} `json:"repository"`
			} `json:"nodes"`
		} `json:"search"`
	}
	err := client.graphql(
		upFragment+` query($query: String!) {
          search(query: $query, type: ISSUE, first: 50) {
            nodes { ... on Issue { repository { nameWithOwner } `+issueFields+` } }
          }
        }`,
		map[string]any{"query": "repo:" + client.repository + " is:issue " + text},
		&data,
	)
	if err != nil {
		return nil, err
	}
	// The text is the caller's and GitHub reads qualifiers in it: a second
	// "repo:" would widen the search to another repository, whose issues
	// would then pass for this one's, numbers and all. Whatever GitHub
	// answers, only this repository's issues are given. (A node that is not
	// an issue comes as an empty object, and is dropped here too.)
	found := []Issue{}
	for _, node := range data.Search.Nodes {
		if node.Repository != nil &&
			strings.ToLower(node.Repository.NameWithOwner) == strings.ToLower(client.repository) {
			found = append(found, toGhIssue(node.rawIssue))
		}
	}
	return found, nil
}

// Comments gives an issue's comments, oldest first, every page of them.
func (client *realClient) Comments(number int) ([]Comment, error) {
	type row struct {
		ID   int64 `json:"id"`
		User *struct {
			Login string `json:"login"`
		} `json:"user"`
		CreatedAt string  `json:"created_at"`
		Body      *string `json:"body"`
	}
	rows, err := everyPage[row](client, fmt.Sprintf("%s/issues/%d/comments", client.base, number))
	if err != nil {
		return nil, err
	}
	comments := make([]Comment, 0, len(rows))
	for _, found := range rows {
		comment := Comment{ID: strconv.FormatInt(found.ID, 10), CreatedAt: found.CreatedAt}
		if found.User != nil {
			comment.Author = found.User.Login
		}
		if found.Body != nil {
			comment.Body = *found.Body
		}
		comments = append(comments, comment)
	}
	return comments, nil
}

// Create makes an issue and returns its number and database id.
func (client *realClient) Create(draft NewIssue) (Created, error) {
	labels := draft.Labels
	if labels == nil {
		// Sent as an empty list, never as null.
		labels = []string{}
	}
	body := struct {
		Title  string   `json:"title"`
		Body   string   `json:"body"`
		Labels []string `json:"labels"`
	}{draft.Title, draft.Body, labels}
	var made struct {
		Number int   `json:"number"`
		ID     int64 `json:"id"`
	}
	if err := client.request("POST", client.base+"/issues", body, &made); err != nil {
		return Created{}, err
	}
	return Created{Number: made.Number, ID: made.ID}, nil
}

// sendable gives a set as it is to be sent: left out when nil, and an empty
// list (never null) when it is to be emptied.
func sendable(set *[]string) *[]string {
	if set == nil || *set != nil {
		return set
	}
	return &[]string{}
}

// Update changes an issue; what changes leaves out is left as it is.
func (client *realClient) Update(number int, changes Changes) error {
	body := struct {
		Title       *string   `json:"title,omitempty"`
		Body        *string   `json:"body,omitempty"`
		Labels      *[]string `json:"labels,omitempty"`
		Assignees   *[]string `json:"assignees,omitempty"`
		State       string    `json:"state,omitempty"`
		StateReason string    `json:"state_reason,omitempty"`
	}{
		changes.Title, changes.Body, sendable(changes.Labels), sendable(changes.Assignees),
		changes.State, changes.StateReason,
	}
	return client.request("PATCH", fmt.Sprintf("%s/issues/%d", client.base, number), body, nil)
}

// AddComment adds a comment to an issue, as the signed-in account.
func (client *realClient) AddComment(number int, body string) error {
	return client.request(
		"POST", fmt.Sprintf("%s/issues/%d/comments", client.base, number),
		map[string]any{"body": body}, nil,
	)
}

// SetParent puts an issue under a parent, taking it out of any other.
func (client *realClient) SetParent(parentNumber int, childID int64) error {
	return client.request(
		"POST", fmt.Sprintf("%s/issues/%d/sub_issues", client.base, parentNumber),
		map[string]any{"sub_issue_id": childID, "replace_parent": true}, nil,
	)
}

// RemoveParent takes an issue out of its parent, back to the top level.
func (client *realClient) RemoveParent(parentNumber int, childID int64) error {
	return client.request(
		"DELETE", fmt.Sprintf("%s/issues/%d/sub_issue", client.base, parentNumber),
		map[string]any{"sub_issue_id": childID}, nil,
	)
}

// AddBlockedBy records that number waits for the issue with database id
// blockerID.
func (client *realClient) AddBlockedBy(number int, blockerID int64) error {
	return client.request(
		"POST", fmt.Sprintf("%s/issues/%d/dependencies/blocked_by", client.base, number),
		map[string]any{"issue_id": blockerID}, nil,
	)
}

// RemoveBlockedBy removes the record that number waits for the issue with
// database id blockerID.
func (client *realClient) RemoveBlockedBy(number int, blockerID int64) error {
	return client.request(
		"DELETE",
		fmt.Sprintf("%s/issues/%d/dependencies/blocked_by/%d", client.base, number, blockerID),
		nil, nil,
	)
}

// Requests is how many requests this client has sent.
func (client *realClient) Requests() int { return int(client.sent.Load()) }
