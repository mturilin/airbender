// server/autopilot.ts — working an epic's issues one after another.
//
// What: "autopilot" for an epic in one conversation. While it is on, the
// plugin starts the epic's next ready issue whenever the conversation is on
// no issue, so the owner does not have to press Start on each one.
//
// Why: an epic with many issues is worked one at a time, and each had to be
// started by hand after the one before was committed (bead-bb-8ff). Of
// three kinds of autopilot the user chose the supervised one first ("Let's
// have b first, and then we'll create a as automation for b"): every review
// stays the owner's; autopilot only strings the issues together.
//
// Design notes:
// - The loop lives here, in the server, and is driven by events: the tab
//   may be closed while an epic is worked. `advance` is asked for when an
//   issue is closed, when the tab reads the list, and when autopilot is
//   turned on.
// - It starts an issue the way the buttons do (work.begin), so nothing
//   about steps is repeated here, and this file knows no step by name.
// - It fails fast (the user: "if a stuck issue, make it fail fast ... it
//   fails and tells you, like, oh, I couldn't do it. Let's go manually").
//   A stuck issue turns autopilot off with the reason; it does not retry,
//   wait or skip ahead. Stuck means: the agent's turn ended with the issue
//   still at one of the agent's steps; the agent sent the issue back from
//   the step that closes it; or it could not be started. The user said the
//   resistance may be raised later: this is the place.
// - To see "the agent's turn ended", the conversation is watched after
//   every step handed to the agent while autopilot is on: wait until BB
//   says it is idle, look again a few seconds later (a queued message
//   starts the next turn a moment after the last one ends, and that gap
//   must not be taken for a stop), then look at the current issue.
// - Which conversations have it on is kept in the plugin's storage, so a
//   reload keeps it. A watch that a reload cut short is taken up again the
//   next time the tab reads the list.
//
// Gotchas:
// - Everything here runs after the answer to whoever caused it has gone
//   back; a failure is logged and turns autopilot off, never thrown.
// - Autopilot sets the conversation's current issue itself, not through
//   work.setCurrent: that one is the owner stepping in, which turns
//   autopilot off.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { stateOf } from "../shared/workflow.ts";
import type { Issue } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Store } from "./store.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";

/** What is remembered for one conversation. */
export interface AutopilotState {
  /** The epic it is, or was last, on for. */
  epicId: string;
  on: boolean;
  /** Why it last turned itself off, in plain words; null when it did not. */
  reason: string | null;
}

/** What the picker needs to know of an issue. */
export type PickIssue = Pick<
  Issue,
  | "id"
  | "parentId"
  | "status"
  | "priority"
  | "createdAt"
  | "blockedBy"
  | "subIssuesBlocked"
>;

/** What there is to do next in an epic. */
export type Pick_ =
  | { kind: "next"; id: string }
  /** No open issue is left under the epic. */
  | { kind: "finished" }
  /** Open issues are left, but none can be started; how many. */
  | { kind: "none"; left: number };

/**
 * The epic's next issue to work on: among its direct sub-issues that are
 * open, not blocked and not being worked on elsewhere, the most urgent,
 * and among equals the oldest (the user's review accepted this order; the
 * tab's own list puts the most recently changed first, which would make a
 * run jump around).
 *
 * @param heldElsewhere Issues that are the current issue of another
 *   conversation.
 * Changes nothing.
 */
export function nextIssue(
  issues: readonly PickIssue[],
  epicId: string,
  heldElsewhere: ReadonlySet<string>,
): Pick_ {
  const open = issues.filter(
    (issue) => issue.parentId === epicId && issue.status !== CLOSED_STATUS,
  );
  if (open.length === 0) return { kind: "finished" };
  const ready = open
    .filter(
      (issue) =>
        issue.blockedBy.length === 0 &&
        !issue.subIssuesBlocked &&
        !heldElsewhere.has(issue.id),
    )
    .sort(
      (left, right) =>
        (left.priority ?? 99) - (right.priority ?? 99) ||
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  return ready.length === 0
    ? { kind: "none", left: open.length }
    : { kind: "next", id: ready[0]!.id };
}

/** Storage key for the conversations' autopilot, kept across reloads. */
const STATE_KEY = "autopilot";

/** How long after "idle" the conversation is looked at again. */
const SETTLE_MS = 6_000;

/** Longest one wait for a turn to end; waited again while still busy. */
const TURN_MS = 30 * 60_000;

/** Statuses in which a conversation's agent is at work. */
const BUSY: ReadonlySet<string> = new Set(["starting", "active", "stopping"]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** How to go on by hand, said after every reason for stopping on an issue. */
const BY_HAND = "Carry on by hand; turn autopilot on again to resume.";

/**
 * Builds autopilot for this plugin instance.
 *
 * @param begin Starts, or takes up again, an issue in a conversation, as
 *   the tab's buttons would (work.begin). Resolves to a message when it
 *   could not.
 * @returns `stateFor`, `set`, `advance`, `watch`, `stuck`, `ownerSteppedIn`
 *   and `consider`.
 * Side effects: one read of the plugin's storage now.
 */
export async function createAutopilot({
  bb,
  store,
  currentBead,
  workflowChoice,
  begin,
}: {
  bb: BbPluginApi;
  store: Store;
  currentBead: CurrentBead;
  workflowChoice: WorkflowChoice;
  begin: (input: {
    threadId: string;
    beadId: string;
    preface: string;
  }) => Promise<{ message: string | null }>;
}) {
  /** Conversation id -> its autopilot. */
  const states = new Map<string, AutopilotState>();
  const saved = await bb.storage.kv.get<unknown>(STATE_KEY).catch(() => undefined);
  if (typeof saved === "object" && saved !== null) {
    for (const [threadId, entry] of Object.entries(saved)) {
      const { epicId, on, reason: why } = (entry ?? {}) as Partial<AutopilotState>;
      if (typeof epicId === "string" && typeof on === "boolean") {
        states.set(threadId, {
          epicId,
          on,
          reason: typeof why === "string" ? why : null,
        });
      }
    }
  }
  const save = () =>
    bb.storage.kv
      .set(STATE_KEY, Object.fromEntries(states))
      .catch((cause) => bb.log.warn("could not save autopilot: " + cause));

  /** Conversations being advanced or looked at right now. */
  const busy = new Set<string>();
  /** The newest watch per conversation; an older one gives way to it. */
  const watches = new Map<string, number>();
  let watchCount = 0;

  /** A conversation's autopilot; null when it never had one. */
  const stateFor = (threadId: string | null): AutopilotState | null =>
    threadId === null ? null : (states.get(threadId) ?? null);

  const isOn = (threadId: string) => states.get(threadId)?.on === true;

  /** Turns it off, remembering why, and tells the tabs. */
  function stop(threadId: string, why: string | null): void {
    const state = states.get(threadId);
    if (state === undefined || !state.on) return;
    states.set(threadId, { ...state, on: false, reason: why });
    watches.delete(threadId);
    void save();
    store.changed(threadId);
  }

  /** Whether the conversation's agent is at work; false when it cannot be told. */
  async function agentBusy(threadId: string): Promise<boolean> {
    try {
      return BUSY.has((await bb.sdk.threads.get({ threadId })).status);
    } catch {
      return false;
    }
  }

  /**
   * The one look at a conversation that has autopilot on: start the next
   * issue when it is on none, stop when the one it is on is stuck.
   *
   * @param turnEnded The caller knows the agent's turn has ended (a
   *   watch): an issue still at one of the agent's steps is then stuck.
   *   Without it, such an issue is taken up again when the agent is idle.
   * Never throws; one look at a time per conversation.
   */
  async function look(threadId: string, turnEnded: boolean): Promise<void> {
    if (!isOn(threadId) || busy.has(threadId)) return;
    busy.add(threadId);
    try {
      const { epicId } = states.get(threadId)!;
      const found = await store.issuesIn({ threadId, projectId: null }, epicId);
      if ("message" in found) {
        stop(threadId, `The epic ${epicId} could not be read: ${found.message}`);
        return;
      }
      const { issues, path } = found;
      const workflow = workflowChoice.workflowFor(path);
      const epic = issues.find((issue) => issue.id === epicId)!;
      if (workflow === null || epic.status === CLOSED_STATUS) {
        stop(threadId, null);
        return;
      }
      const preface = `Autopilot is on for the epic ${epic.id} (${JSON.stringify(epic.title)}): it started this issue because it is the epic's next ready one. Work on it as usual. Every review is still the user's: do not approve or accept anything for them.`;
      const currentId = await currentBead.read(threadId);
      const current = issues.find(
        (issue) => issue.id === currentId && issue.status !== CLOSED_STATUS,
      );
      if (current !== undefined) {
        // On an issue from outside the epic: the conversation is doing
        // something else, which is not autopilot's to touch.
        if (current.parentId !== epicId) return;
        const state = stateOf(workflow, current.step);
        // Waiting for the owner: the run waits with it.
        if (state.actor !== "agent") return;
        if (await agentBusy(threadId)) {
          watch(threadId);
          return;
        }
        if (turnEnded) {
          stop(
            threadId,
            `The agent stopped on ${current.id} at "${state.label}" without finishing it. ${BY_HAND}`,
          );
          return;
        }
        // Turned on, or found again after a reload, with the issue at one
        // of the agent's steps and the agent idle: take it up again.
        const resumed = await begin({ threadId, beadId: current.id, preface });
        if (resumed.message !== null) {
          stop(threadId, `${current.id} could not be taken up again: ${resumed.message} ${BY_HAND}`);
        }
        return;
      }
      const open = issues.filter(
        (issue) => issue.parentId === epicId && issue.status !== CLOSED_STATUS,
      );
      const { projectId } = await bb.sdk.threads.get({ threadId });
      const held = new Set(
        await currentBead.heldAmong(
          projectId,
          new Set(open.map((issue) => issue.id)),
        ),
      );
      const pick = nextIssue(issues, epicId, held);
      if (pick.kind === "finished") {
        stop(threadId, "Every issue of this epic is closed.");
        return;
      }
      if (pick.kind === "none") {
        stop(
          threadId,
          `${pick.left === 1 ? "The one issue left is" : `The ${pick.left} issues left are`} blocked or being worked on in another conversation.`,
        );
        return;
      }
      const started = await begin({ threadId, beadId: pick.id, preface });
      if (started.message !== null) {
        stop(threadId, `${pick.id} could not be started: ${started.message} ${BY_HAND}`);
      }
    } catch (cause) {
      stop(threadId, `Autopilot failed: ${reason(cause)}`);
    } finally {
      busy.delete(threadId);
    }
  }

  /**
   * Watches a conversation until its agent's turn has really ended, then
   * looks at it. Called whenever the agent is handed a step. Returns at
   * once; a newer watch on the same conversation replaces this one.
   */
  function watch(threadId: string): void {
    if (!isOn(threadId)) return;
    watchCount += 1;
    const mine = watchCount;
    watches.set(threadId, mine);
    const current = () => watches.get(threadId) === mine && isOn(threadId);
    void (async () => {
      // The message may not have started a turn yet.
      await pause(SETTLE_MS);
      while (current()) {
        await bb.sdk.threads
          .wait({ threadId, status: "idle", timeoutMs: TURN_MS })
          .catch(() => undefined);
        await pause(SETTLE_MS);
        if (!current()) return;
        if (!(await agentBusy(threadId))) break;
      }
      if (!current()) return;
      watches.delete(threadId);
      await look(threadId, true);
    })().catch((cause) => bb.log.warn(`autopilot watch of ${threadId} failed: ${reason(cause)}`));
  }

  /**
   * Turns autopilot on for an epic in a conversation, or off (null).
   *
   * @returns `message` null on success, else why it could not be turned on.
   * Side effects: remembers the choice, tells the tabs, and, when turned
   *   on, starts the look that begins or takes up an issue.
   */
  async function set(input: {
    threadId: string;
    epicId: string | null;
  }): Promise<{ message: string | null }> {
    const { threadId, epicId } = input;
    if (epicId === null) {
      const state = states.get(threadId);
      if (state !== undefined) {
        states.set(threadId, { ...state, on: false, reason: null });
        watches.delete(threadId);
        void save();
        store.changed(threadId);
      }
      return { message: null };
    }
    const found = await store.issuesIn({ threadId, projectId: null }, epicId);
    if ("message" in found) return { message: found.message };
    if (workflowChoice.workflowFor(found.path) === null) {
      return { message: "Autopilot needs the standard workflow: on the simple one issues have no steps to take." };
    }
    const epic = found.issues.find((issue) => issue.id === epicId)!;
    if (epic.status === CLOSED_STATUS) {
      return { message: `${epicId} is closed.` };
    }
    states.set(threadId, { epicId, on: true, reason: null });
    void save();
    store.changed(threadId);
    void look(threadId, false);
    return { message: null };
  }

  return {
    stateFor,
    set,
    /** The conversation may have become free: an issue was closed. */
    advance: (threadId: string) => void look(threadId, false),
    watch,
    /**
     * The agent could not finish an issue (it sent it back from the step
     * that closes it): autopilot stops and says so.
     */
    stuck(threadId: string, beadId: string, why: string): void {
      if (!isOn(threadId)) return;
      stop(threadId, `The agent could not finish ${beadId}: ${why} ${BY_HAND}`);
    },
    /** The owner made another issue current, or released one, by hand. */
    ownerSteppedIn: (threadId: string) => stop(threadId, null),
    /**
     * The tab read the list: take up a look that a reload cut short, and
     * notice an issue closed outside the plugin. Does nothing while a
     * watch is running.
     */
    consider(threadId: string | null): void {
      if (threadId === null || !isOn(threadId) || watches.has(threadId)) return;
      void (async () => {
        if (await agentBusy(threadId)) watch(threadId);
        else await look(threadId, false);
      })();
    },
  };
}

/** What createAutopilot returns. */
export type Autopilot = Awaited<ReturnType<typeof createAutopilot>>;
