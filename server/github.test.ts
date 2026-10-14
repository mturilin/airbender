// server/github.test.ts — tests for the parts of the GitHub sync that need
// neither GitHub nor beads.
//
// What: checks how a remote's address is read as a repository, how a beads
// issue's link to a GitHub issue is read, and how the text of
// `bd github sync` is taken apart.
// Why: the window lists and marks issues from the first two, and shows the
// owner what a sync would do from the third (bead-bb-rh3). The lines the
// command prints are taken from its source (beads 1.3.1).

import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedNumber, parseSyncOutput, repositoryOf, switchLists } from "./github.ts";

test("a github.com remote is read as owner and name, in each form git accepts", () => {
  const want = { owner: "mturilin", name: "airbender" };
  for (const url of [
    "https://github.com/mturilin/airbender.git",
    "https://github.com/mturilin/airbender",
    "https://github.com/mturilin/airbender/",
    "https://someone@github.com/mturilin/airbender.git",
    "git@github.com:mturilin/airbender.git",
    "git@github.com:mturilin/airbender",
    "ssh://git@github.com/mturilin/airbender.git",
    "  https://github.com/mturilin/airbender.git\n",
  ]) {
    assert.deepEqual(repositoryOf(url), want, url);
  }
  // A name may have dots in it.
  assert.deepEqual(repositoryOf("git@github.com:me/site.example.com.git"), {
    owner: "me",
    name: "site.example.com",
  });
});

test("a remote that is not on github.com is not a repository to sync with", () => {
  for (const url of [
    "https://gitlab.com/me/x.git",
    "git@github.example.com:me/x.git",
    "https://github.com/only-owner",
    "/srv/git/x.git",
    "",
  ]) {
    assert.equal(repositoryOf(url), null, url);
  }
});

test("a beads issue's link names the GitHub issue's number, in this repository only", () => {
  const here = { owner: "mturilin", name: "airbender" };
  assert.equal(linkedNumber("https://github.com/mturilin/airbender/issues/12", here), 12);
  assert.equal(linkedNumber("https://github.com/MTurilin/Airbender/issues/7", here), 7);
  assert.equal(linkedNumber("github:31", here), 31);
  assert.equal(linkedNumber(null, here), null);
  // Another repository's issue, another tracker's, a pull request.
  assert.equal(linkedNumber("https://github.com/other/repo/issues/12", here), null);
  assert.equal(linkedNumber("linear:ABC-12", here), null);
  assert.equal(linkedNumber("https://github.com/mturilin/airbender/pull/12", here), null);
});

test("a preview's lines become what would be done, in both directions", () => {
  const report = parseSyncOutput(
    [
      "Dry run mode - no changes will be made",
      "",
      "  [dry-run] Would import: 12 - Crash on start",
      "  [dry-run] Would update local issue: 7 - Rename: the tab",
      "  [dry-run] Would create in GitHub: Support JJ",
      "  [dry-run] Would update in GitHub: Epic mode",
      "  [dry-run] Would create 2 dependencies",
      "",
      "Run without --dry-run to apply changes",
    ].join("\n"),
    "",
  );
  assert.deepEqual(report.actions, [
    { kind: "import", what: "12 - Crash on start" },
    { kind: "update-local", what: "7 - Rename: the tab" },
    { kind: "create-remote", what: "Support JJ" },
    { kind: "update-remote", what: "Epic mode" },
  ]);
  assert.deepEqual(report.notes, ["Would create 2 dependencies"]);
  assert.deepEqual(report.warnings, []);
});

test("a real run's totals, its conflicts and its warnings are passed on as said", () => {
  const report = parseSyncOutput(
    [
      "  Conflict on x-1: external is newer, importing",
      "✓ Pulled 2 issues (1 created, 1 updated)",
      "✓ Pushed 1 issues",
      "→ Resolved 1 conflicts",
    ].join("\n"),
    "Warning: Issue 99 not found in GitHub\nWarning: Failed to fetch 5: timeout\n",
  );
  assert.deepEqual(report.actions, []);
  assert.deepEqual(report.notes, [
    "Conflict on x-1: external is newer, importing",
    "Pulled 2 issues (1 created, 1 updated)",
    "Pushed 1 issues",
    "Resolved 1 conflicts",
  ]);
  assert.deepEqual(report.warnings, [
    "Issue 99 not found in GitHub",
    "Failed to fetch 5: timeout",
  ]);
});

test("nothing to do reads as nothing, and unknown wording is kept as text", () => {
  assert.deepEqual(
    parseSyncOutput(
      "Dry run mode - no changes will be made\n\n\nRun without --dry-run to apply changes\n",
      "",
    ),
    { actions: [], notes: [], warnings: [] },
  );
  assert.deepEqual(parseSyncOutput("Something new in a later version\n", "").notes, [
    "Something new in a later version",
  ]);
});

test("what a switch of tracker would copy: only on the side being left and open; linked ones are brought up to date", () => {
  const mine = [
    { id: "t-1", status: "open", externalRef: null },
    { id: "t-2", status: "in_progress", externalRef: null },
    { id: "t-3", status: "closed", externalRef: null },
    { id: "t-4", status: "open", externalRef: "https://github.com/o/n/issues/7" },
    { id: "t-5", status: "closed", externalRef: "github:8" },
  ];
  const remote = [
    { number: 7, closed: false, linkedId: "t-4" },
    { number: 8, closed: true, linkedId: "t-5" },
    { number: 9, closed: false, linkedId: null },
    { number: 10, closed: true, linkedId: null },
    { number: 11, closed: true, linkedId: null },
  ];
  const links = [
    { id: "t-4", number: 7 },
    { id: "t-5", number: 8 },
  ];
  assert.deepEqual(switchLists("github", mine, remote, links), {
    update: ["t-4", "t-5"],
    createIds: ["t-1", "t-2"],
    createNumbers: [],
    closedLeft: 1,
  });
  assert.deepEqual(switchLists("beads", mine, remote, links), {
    update: ["t-4", "t-5"],
    createIds: [],
    createNumbers: [9],
    closedLeft: 2,
  });
  // Nothing on either side.
  assert.deepEqual(switchLists("github", [], [], []), {
    update: [],
    createIds: [],
    createNumbers: [],
    closedLeft: 0,
  });
});
