// Current-conversation routing tests with injected metadata and folder checks.
import test from "node:test";
import assert from "node:assert/strict";
import { createCurrentBead } from "./current-bead.ts";

/** Supplies only the BB calls used by the current-issue routing operation. */
function currentIn(ids: string[]) {
  return createCurrentBead({ sdk: { threads: {
    list: async () => ids.map((id) => ({ id })),
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "p", archivedAt: null }),
    getPluginMetadata: async () => ({ currentBead: "issue-1" }),
  } } } as never);
}
test("the invoking working conversation wins over other matches", async () => {
  const current = currentIn(["other", "here"]);
  assert.deepEqual(await current.workingFor("p", "issue-1", "here", async () => "/repo"), { threadId: "here", path: "/repo" });
});
test("the invoking conversation can be resolved without listing the project", async () => {
  const current = currentIn([]);
  assert.deepEqual(await current.workingFor("p", "issue-1", "beyond-the-page", async () => "/repo"), { threadId: "beyond-the-page", path: "/repo" });
});
test("routing rejects ambiguity and excludes unrelated folders", async () => {
  const current = currentIn(["one", "two"]);
  const ambiguous = await current.workingFor("p", "issue-1", null, async () => "/repo");
  assert.ok("reason" in ambiguous && ambiguous.reason.includes("Several"));
  assert.deepEqual(await current.workingFor("p", "issue-1", null, async (id) => id === "one" ? "/repo" : null), { threadId: "one", path: "/repo" });
  assert.ok("reason" in await current.workingFor("p", "issue-1", null, async () => null));
});
