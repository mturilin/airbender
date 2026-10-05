// server/define.ts — the background agent behind the Define button.
//
// What: starts a hidden worker thread that writes up an issue (what is wanted,
// what done means, a design, open questions), marks the issue as being defined
// while it runs, and tidies the thread away afterwards.
//
// Why: the user wanted issues fleshed out without their own conversation being
// touched: "I don't want a separate thread, but a background agent is ok".
//
// Design notes:
// - The mark lives only in the running plugin; a reload forgets it, which
//   costs the "in progress" mark and not the work.
//
// Gotchas:
// - One run per issue at a time; a second press while one is running reuses
//   it.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEAD_ID_PATTERN, CHANGED_CHANNEL } from "../shared/constants.ts";
import type { Issue } from "./contract.ts";
import { definePrompt } from "./prompts.ts";
import type { Store } from "./store.ts";

/**
 * Builds the Define operation for this plugin instance.
 *
 * @returns `startDefine`, which starts (or reuses) a worker for one issue.
 */
export function createDefine({
  bb,
  store,
  defineModel,
}: {
  bb: BbPluginApi;
  store: Store;
  /** Model id for the worker; empty means the project's default model. */
  defineModel: string;
}) {
  const { listIssues, defining, defineKey } = store;
  /** Longest a define run is shown as running before the mark is dropped. */
  const DEFINE_TIMEOUT_MS = 20 * 60_000;

  /**
   * Starts a background agent that defines one issue (see
   * issue_define in the contract).
   *
   * @returns The worker thread's id, or the reason nothing was started. If
   *   one is already running for the issue, its id is returned and no second
   *   one is started.
   */
  async function startDefine({
    threadId,
    projectId,
    beadId,
  }: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
  }): Promise<{ threadId: string | null; message: string | null }> {
    const fail = (message: string) => ({ threadId: null, message });
    if (!BEAD_ID_PATTERN.test(beadId)) {
      return fail(`"${beadId}" is not a beads issue id.`);
    }
    const listed = await listIssues({ threadId, projectId });
    const issue = listed.issues.find((candidate) => candidate.id === beadId);
    if (listed.state !== "ok" || listed.path === null) {
      return fail(listed.message ?? "The issues could not be read.");
    }
    if (issue === undefined) {
      return fail(`Issue ${beadId} is no longer in the list.`);
    }
    const key = defineKey(listed.path, beadId);
    const running = defining.get(key);
    if (running !== undefined) return { threadId: running, message: null };
    // Run in the same folder as the thread the user is in (it may be a
    // worktree); from the New thread screen, in the project's default one.
    let spawnProjectId = projectId;
    let environment:
      | { type: "reuse"; environmentId: string }
      | { type: "project-default" } = { type: "project-default" };
    if (threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId });
      spawnProjectId = thread.projectId;
      if (thread.environmentId !== null) {
        environment = { type: "reuse", environmentId: thread.environmentId };
      }
    }
    if (spawnProjectId === null) return fail("Pick a project first.");
    // A hidden worker: a background agent that does not show up in the
    // sidebar. The user asked for exactly this ("no separate thread, a
    // background agent is fine"). It is deliberately not made a child of
    // the user's thread, so nothing about it is reported into that thread.
    // Cost of hiding it: if its agent stops to ask for permission, nobody
    // sees that in the sidebar; the row's "open" link is the way in, and
    // the time limit below cleans up a worker that never finishes.
    let worker;
    try {
      worker = await bb.sdk.threads.spawn({
        projectId: spawnProjectId,
        environment,
        title: `Define ${issue.id}: ${issue.title}`.slice(0, 120),
        visibility: "hidden",
        // Defining is reading code and making design judgments, and it
        // runs in the background, so a stronger, slower model is worth it.
        // The model is a setting; empty means "whatever the project uses".
        ...(defineModel.trim() === ""
          ? {}
          : { model: defineModel.trim() }),
        prompt: definePrompt(issue.id, issue.title),
      });
    } catch (cause) {
      return fail(
        `Could not start a background agent to define the issue: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    defining.set(key, worker.id);
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    // Not awaited: the answer goes back now, and the mark is cleared when
    // the new thread's agent goes idle (finished, or waiting for the user),
    // fails, or runs past the time limit.
    void bb.sdk.threads
      .wait({
        threadId: worker.id,
        status: "idle",
        timeoutMs: DEFINE_TIMEOUT_MS,
      })
      .catch((cause) => bb.log.warn("define wait ended: " + cause))
      .finally(async () => {
        if (defining.get(key) === worker.id) defining.delete(key);
        bb.realtime.publish(CHANGED_CHANNEL, { threadId });
        // A hidden worker is not cleaned up by anyone else: archive it so
        // it leaves the active lists, then stop it so its agent process is
        // released. Each step is attempted even if the other fails.
        await bb.sdk.threads
          .archive({ threadId: worker.id })
          .catch((cause) => bb.log.warn("define archive failed: " + cause));
        await bb.sdk.threads
          .stop({ threadId: worker.id })
          .catch((cause) => bb.log.warn("define stop failed: " + cause));
      });
    return { threadId: worker.id, message: null };

  }

  return { startDefine };
}
