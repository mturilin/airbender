// server/work.ts — starting work on an issue and finishing it.
//
// What: the three operations that involve the thread's agent or its current
// issue: play (make an issue current and tell the agent to start), setting
// or clearing the current issue without a message, and closing an issue
// with the option of asking the agent to commit its work.
//
// Why: these are the points where the tab drives the conversation, not just
// the issue list. They are kept apart from the plain issue operations in
// server/store.ts because they send messages to an agent.
//
// Design notes:
// - Messages are sent with mode "auto": a turn starts when the agent is
//   idle and the message queues behind a running turn otherwise, so nothing
//   here ever interrupts work.
// - The plugin never runs git. "Close & commit" asks the agent, which
//   commits under its own rules, including any need to ask first.
// - Problems are returned as a message in plain words, like every other
//   operation, so the tab shows them all in one place.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEAD_ID_PATTERN, CLOSED_STATUS } from "../shared/constants.ts";
import type { Issue } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import { descendantsOf } from "../shared/tree.ts";
import { workRequest } from "./prompts.ts";
import type { FolderRef, Outcome, Store } from "./store.ts";

/** Turns anything thrown into a sentence. */
const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Builds the work operations for this plugin instance.
 *
 * @returns `startWork`, `setCurrent` and `closeIssue`.
 * Side effects: none until one of them is called.
 */
export function createWork({
  bb,
  store,
  currentBead,
}: {
  bb: BbPluginApi;
  store: Store;
  currentBead: CurrentBead;
}) {
  const { issuesIn, setIssueOpen, changed } = store;

  /**
   * The play button: makes an issue the thread's current one and sends the
   * thread's agent the message that starts work on it (see workRequest).
   *
   * The issue is looked up first, so the message can carry its title and so
   * a stale row (closed or deleted since the tab loaded) fails before
   * anything is sent.
   */
  async function startWork({
    threadId,
    beadId,
  }: {
    threadId: string;
    beadId: string;
  }): Promise<Outcome> {
    const found = await issuesIn({ threadId, projectId: null }, beadId);
    if ("message" in found) {
      // A row that has gone since the tab loaded: say how to get it back.
      return {
        message: found.message.endsWith("no longer in the list.")
          ? `${found.message} Refresh and try again.`
          : found.message,
      };
    }
    const issue = found.issues.find((candidate) => candidate.id === beadId)!;
    if (issue.status === CLOSED_STATUS) {
      return {
        message: `Issue ${beadId} is closed. Reopen it before starting work on it.`,
      };
    }
    try {
      await currentBead.write(threadId, beadId);
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            mentions: [],
            text: workRequest(
              issue.id,
              issue.title,
              descendantsOf(issue.id, found.issues).filter(
                (candidate) => candidate.status !== CLOSED_STATUS,
              ),
            ),
          },
        ],
      });
    } catch (cause) {
      return {
        message: `The agent could not be started on ${beadId}: ${reason(cause)}`,
      };
    }
    return { message: null };
  }

  /**
   * Sets the thread's current issue without messaging the agent; null
   * clears it.
   */
  async function setCurrent({
    threadId,
    beadId,
  }: {
    threadId: string;
    beadId: string | null;
  }): Promise<Outcome> {
    if (beadId !== null && !BEAD_ID_PATTERN.test(beadId)) {
      return { message: `"${beadId}" is not a beads issue id.` };
    }
    try {
      await currentBead.write(threadId, beadId);
    } catch (cause) {
      return { message: reason(cause) };
    }
    return { message: null };
  }

  /**
   * Closes an issue and, with `commit`, closes its open sub-issues first and
   * asks the thread's agent to commit the work.
   *
   * @param commit True is the happy path: the work is accepted. False is the
   *   "drop this issue" action: nothing is committed and sub-issues are left
   *   alone.
   * Side effects: one `bd close` per issue closed; one message to the
   *   thread when committing; one change published at the end.
   */
  async function closeIssue({
    commit,
    ...input
  }: FolderRef & { beadId: string; commit: boolean }): Promise<Outcome> {
    // Read the issue before closing: its title goes into the message to
    // the agent, and its open sub-issues have to be closed first.
    const listed =
      commit && input.threadId !== null ? await issuesIn(input) : null;
    const before = listed !== null && "issues" in listed ? listed : null;
    const title =
      before?.issues.find((issue) => issue.id === input.beadId)?.title ??
      null;
    // "Close & commit" on an epic closes everything still open inside it
    // (the user's decision, bead-bb-5qt). Deepest first, because beads
    // refuses to close an issue that still has open sub-issues. A plain
    // close (commit false) does not do this: it is the "drop this issue"
    // action, and dropping a whole tree by one click would be too easy.
    const closedSubIssues: Issue[] = [];
    if (before !== null) {
      const open = descendantsOf(input.beadId, before.issues).filter(
        (issue) => issue.status !== CLOSED_STATUS,
      );
      for (const subIssue of open.reverse()) {
        // Not published one by one: every open tab would reload once per
        // sub-issue. One change is published at the end instead.
        const closedOne = await setIssueOpen(
          "close",
          { ...input, beadId: subIssue.id },
          false,
        );
        if (closedOne.message !== null) {
          // Some sub-issues may already be closed; the tabs must see that.
          if (closedSubIssues.length > 0) changed(input.threadId);
          return {
            message: `Could not close sub-issue ${subIssue.id}, so ${input.beadId} was left open: ${closedOne.message}`,
          };
        }
        closedSubIssues.push(subIssue);
      }
    }
    const outcome = await setIssueOpen("close", input);
    // A refused close publishes nothing itself, but sub-issues closed on the
    // way stay closed, and the tabs must see that.
    if (outcome.message !== null && closedSubIssues.length > 0) {
      changed(input.threadId);
    }
    // Only after bd close succeeded: a failed close (for example a blocked
    // issue) must not leave the agent committing work that is not accepted.
    if (outcome.message !== null || !commit || input.threadId === null) {
      return outcome;
    }
    try {
      // "auto" starts a turn when the agent is idle and queues behind the
      // running turn otherwise. The plugin never runs git itself; the agent
      // commits under its own rules, including any need to ask first.
      await bb.sdk.threads.send({
        threadId: input.threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            mentions: [],
            text:
              `The user closed beads issue ${input.beadId}${title === null ? "" : `: ${JSON.stringify(title)}`} from the Airbender tab and asked for its work to be committed.` +
              (closedSubIssues.length === 0
                ? " Commit the changes that belong to this issue, following the commit rules in AGENTS.md: only this issue's files, and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit for it, say so."
                : ` Its sub-issues were closed with it: ${closedSubIssues
                    .map((issue) => `${issue.id} (${JSON.stringify(issue.title)})`)
                    .join(
                      ", ",
                    )}. Commit the changes that belong to this issue and those sub-issues, following the commit rules in AGENTS.md: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title; only these issues' files; and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit, say so.`),
          },
        ],
      });
    } catch (cause) {
      return {
        message: `The issue was closed, but the agent could not be asked to commit: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    return outcome;
  }

  return { startWork, setCurrent, closeIssue };
}
