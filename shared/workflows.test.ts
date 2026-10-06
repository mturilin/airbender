// shared/workflows.test.ts — tests for the list of workflows to choose from.
//
// What: checks that every choice is listed once, that the default is one of
// them, and which choices have a state machine behind them.
//
// Why: the tab draws its menu from this list and the server stores its ids;
// a choice missing from either side would be unselectable or unreadable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { standardWorkflow } from "./standard-workflow.ts";
import {
  DEFAULT_WORKFLOW_ID,
  WORKFLOW_CHOICES,
  WORKFLOW_IDS,
  isWorkflowId,
  workflowFor,
} from "./workflows.ts";

test("every workflow id is offered exactly once, with a label", () => {
  assert.deepEqual(
    WORKFLOW_CHOICES.map((choice) => choice.id),
    [...WORKFLOW_IDS],
  );
  for (const choice of WORKFLOW_CHOICES) {
    assert.notEqual(choice.label.trim(), "");
    assert.notEqual(choice.hint.trim(), "");
  }
});

test("a repository that never chose is on the standard workflow", () => {
  assert.equal(DEFAULT_WORKFLOW_ID, "standard");
  assert.equal(workflowFor(DEFAULT_WORKFLOW_ID), standardWorkflow);
});

test("the simple workflow has no state machine", () => {
  assert.equal(workflowFor("simple"), null);
});

test("only the listed ids are accepted as a stored choice", () => {
  assert.ok(isWorkflowId("standard"));
  assert.ok(isWorkflowId("simple"));
  for (const other of ["", "Standard", "kanban", null, undefined, 1, {}]) {
    assert.equal(isWorkflowId(other), false);
  }
});
