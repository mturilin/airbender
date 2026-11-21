// What: checks that the plugin never needs a newer bend than the bend in
// this repository reports.
// Why: the plugin is installed from main and setup installs the bend
// released from main. When NEEDED_VERSION ran ahead of bend's Version, no
// bend anywhere was new enough and every new machine was stuck
// (bead-bb-vqw). The release workflow makes the same check on main; this
// one catches it before the commit.
// Design: reads bend's Go source as text, so no Go toolchain is needed.
// Gotchas: the pattern expects `const Version = N` on one line in
// bend/internal/cli/run.go; if that moves, this test fails to find it and
// says so rather than passing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NEEDED_VERSION } from "./bend.ts";

test("the plugin needs no newer bend than the bend in this repository", () => {
  const source = readFileSync(new URL("../bend/internal/cli/run.go", import.meta.url), "utf8");
  const found = /^const Version = (\d+)$/mu.exec(source);
  assert.ok(found, "const Version not found in bend/internal/cli/run.go");
  const offered = Number(found[1]);
  assert.ok(
    NEEDED_VERSION <= offered,
    `The plugin needs bend ${NEEDED_VERSION}, but bend reports ${offered}: raise Version in bend/internal/cli/run.go.`,
  );
});
