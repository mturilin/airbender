// Dialog availability tests; submissions are separately rechecked by the server.
import test from "node:test";
import assert from "node:assert/strict";
import { closeChoiceProblem, defaultCloseGit } from "./close-model.ts";

const available = { message: null, blocked: null, changes: true, conversationId: "working", unavailableReason: null };

test("Simple close waits for a preview and refuses blocked parents", () => {
  assert.ok(closeChoiceProblem(null, "none"));
  assert.equal(closeChoiceProblem({ ...available, blocked: "Open children" }, "none"), "Open children");
});
test("commit choices require changes and a working conversation", () => {
  assert.equal(closeChoiceProblem(available, "push"), null);
  assert.ok(closeChoiceProblem({ ...available, changes: false }, "commit"));
  assert.ok(closeChoiceProblem({ ...available, conversationId: null }, "commit"));
  assert.equal(closeChoiceProblem({ ...available, conversationId: null }, "none"), null);
});

test("Simple close defaults to Commit & push only when the preview permits it", () => {
  assert.equal(defaultCloseGit(available), "push");
  assert.equal(defaultCloseGit(null), "none");
  assert.equal(defaultCloseGit({ ...available, changes: false }), "none");
  assert.equal(defaultCloseGit({ ...available, conversationId: null }), "none");
  assert.equal(defaultCloseGit({ ...available, unavailableReason: "No checked-out branch" }), "none");
  assert.equal(defaultCloseGit({ ...available, blocked: "Open children" }), "none");
  assert.equal(defaultCloseGit({ ...available, message: "Read failed" }), "none");
});
