// server/bend-for-tests.ts — the bend program, for the tests of the tab's
// server.
//
// What: gives the path of a bend built from the source in this repository
// (bend/), building it on first use.
//
// Why: the tab's server reads and changes issues by running bend
// (server/bend.ts), so its tests need the program. Building it here, from
// the source beside the tests, means `npm test` always tests the plugin
// against the bend it is shipped with, never against whichever bend
// happens to be on the PATH.
//
// Design notes:
// - BEND_PROGRAM, when set, names the program to use instead; nothing is
//   built then.
// - Where Go is not installed there is no bend; the tests that need it are
//   skipped, like the ones that need bd.
//
// Gotchas:
// - Each test file is a process of its own and builds once; Go's build
//   cache makes every build after the first a fraction of a second.
// - A GOROOT that points at a folder that is not there (left behind when a
//   version manager removes a Go version) makes `go` fail; it is dropped
//   for the build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The program found or built; undefined until asked, null when there is none. */
let found: string | null | undefined;

/**
 * The bend program to test with.
 *
 * @returns Its path, or null when it cannot be built here (no Go).
 * Side effects: the first call may run `go build`, writing the program
 *   into a new temporary folder.
 */
export function builtBend(): string | null {
  if (found !== undefined) return found;
  const named = process.env.BEND_PROGRAM?.trim();
  if (named) return (found = named);
  const env = { ...process.env };
  if (env.GOROOT !== undefined && !existsSync(env.GOROOT)) delete env.GOROOT;
  const program = join(mkdtempSync(join(tmpdir(), "airbender-bend-")), "bend");
  try {
    execFileSync("go", ["build", "-o", program, "./cmd/bend"], {
      cwd: join(import.meta.dirname, "..", "bend"),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    found = program;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // No Go: no bend. Anything else is a broken build and must be seen.
    if (code !== "ENOENT") throw cause;
    found = null;
  }
  return found;
}
