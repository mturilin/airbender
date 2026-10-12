// server/sizing.ts — sizing issues in the background.
//
// What: decides which issues of a repository need a size (new ones, and
// changed ones the background sized before), and has a hidden worker
// thread give them one: S, M or L, with a one-line reason on the issue.
//
// Why: the user wants sizes on the backlog before an issue is started, and
// without their conversation being used for it (bead-bb-zkc): "can we
// assess the issue size using background thread? ... when it changes /
// created". Their rules: every change counts; a size they chose themselves
// is never overwritten; an issue that has started is not re-sized; all
// issues are sized, whoever created them; an agent may size an issue it
// creates; it can be turned off; Haiku to begin with.
//
// Design notes:
// - Checked whenever a tab reads a repository's issues (server.ts calls
//   `consider` after every list). That already happens when a tab opens, on
//   refresh, and after any change the watcher sees, so issues made by
//   agents or from a terminal are covered. With no tab open nothing is
//   sized until one opens. A timer over every repository ever seen was
//   rejected.
// - "Changed" is judged by a fingerprint of the issue's own content: title,
//   description, acceptance criteria, design, notes, type and the ids of
//   its sub-issues. Labels, status, step and comments are left out although
//   the user said "everything counts": the sizing itself writes a label and
//   a comment and would set itself off.
// - Whose size it is: the plugin remembers, per repository, the fingerprint
//   and the size it gave. A size it did not give (the user's, an agent's)
//   is never touched. When the user sets a size in the tab the memory of
//   that issue is dropped (`forget`), so it is theirs from then on.
// - One worker per repository at a time, for up to ten issues, started ten
//   seconds after the first one was queued so a burst is taken together. A
//   worker per issue was rejected: the first run on an existing backlog
//   would start dozens.
// - The worker writes nothing itself. It is given the issues' text, judges
//   them (it may read the code), and reports its sizes through a tool of
//   the plugin's, `airbender_report_sizes`; the plugin writes the label and the
//   comment, after checking at that moment that the issue may still be
//   sized. The first version had the worker run bd, and failed on its
//   first real run: an agent's sandbox has the beads database read-only,
//   the same wall that makes the conversation's agent use native tools.
// - That tool is offered only to the plugin's own workers, recognised by
//   their title when BB asks which tools a thread gets (`isWorker`), so
//   ordinary threads do not carry a third tool.
// - The user can also ask for one issue to be sized now, from its row's
//   menu (their addition: "a menu command resize for each issue to trigger
//   sizing manually"). That works with the automatic sizing switched off,
//   and replaces a size the issue already has, the user's own included:
//   asking is their leave.
// - An issue the worker did not manage to size is remembered as tried, so
//   it is not tried again and again; it is tried again when it changes.
//
// Gotchas:
// - A hidden worker that stops to ask for permission is seen by nobody;
//   the time limit below archives it. Its instructions therefore tell it
//   to run no commands and to read only inside its own folder.
// - A worker started from the new-thread screen (no thread) runs in the
//   project's default environment, which may be a work tree.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL, CLOSED_STATUS } from "../shared/constants.ts";
import { stateOf } from "../shared/workflow.ts";
import type { Workflow } from "../shared/workflow.ts";
import type { Issue } from "./contract.ts";

/** What is remembered about one issue the background has dealt with. */
export interface Sized {
  /** The issue's content when it was sized (see `fingerprint`). */
  fingerprint: string;
  /** The size the background gave; null when it tried and gave none. */
  size: string | null;
}

/** Storage key for what is remembered, kept across reloads. */
// "2": what the first version remembered (issues its failed worker could
// not size) is left behind, so they are tried again.
const MEMORY_KEY = "backgroundSizes2";

/** Most issues one worker is given. */
export const BATCH_SIZE = 10;

/** How long after the first issue is queued the worker starts. */
const COLLECT_MS = 10_000;

/** How long a switched-off setting is trusted before it is read again. */
const OFF_RECHECK_MS = 60_000;

/** Longest a worker may run before it is tidied away. */
const WORKER_TIMEOUT_MS = 10 * 60_000;

/**
 * An issue's content, as one string: what a change to must lead to a new
 * size. See the design notes for what is left out and why.
 *
 * @param subIssueIds The ids of its direct sub-issues, in any order.
 */
export function fingerprint(issue: Issue, subIssueIds: string[]): string {
  return JSON.stringify([
    issue.title,
    issue.description,
    issue.acceptance,
    issue.design,
    issue.notes,
    issue.type,
    [...subIssueIds].sort(),
  ]);
}

/**
 * Whether the background should size an issue now.
 *
 * @param current The issue's fingerprint as it is now.
 * @param remembered What the background did about it before, if anything.
 * @returns True for an open issue nobody has started that either has no
 *   size (and was not already tried as it is), or still has the size the
 *   background gave it and has changed since.
 */
export function needsSizing(
  workflow: Workflow,
  issue: Issue,
  current: string,
  remembered: Sized | undefined,
): boolean {
  if (workflow.sizes === undefined) return false;
  if (issue.status === CLOSED_STATUS) return false;
  // Started: from here the size is the user's and the agent's.
  if (stateOf(workflow, issue.step).id !== workflow.initial) return false;
  if (issue.size === null) {
    // Tried as it is and nothing came of it: wait for a change.
    return !(
      remembered !== undefined &&
      remembered.size === null &&
      remembered.fingerprint === current
    );
  }
  // It has a size. Only the background's own may be redone.
  return (
    remembered !== undefined &&
    remembered.size === issue.size &&
    remembered.fingerprint !== current
  );
}

/**
 * The issues of a list that need sizing, with each one's fingerprint.
 *
 * @param memory What is remembered for this repository, by issue id.
 */
export function toSize(
  workflow: Workflow,
  issues: Issue[],
  memory: Record<string, Sized>,
): { issue: Issue; fingerprint: string }[] {
  const children = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.parentId === null) continue;
    children.set(issue.parentId, [
      ...(children.get(issue.parentId) ?? []),
      issue.id,
    ]);
  }
  return issues
    .map((issue) => ({
      issue,
      fingerprint: fingerprint(issue, children.get(issue.id) ?? []),
    }))
    .filter((entry) =>
      needsSizing(workflow, entry.issue, entry.fingerprint, memory[entry.issue.id]),
    );
}

/** The tool a worker reports its sizes with (registered in server.ts). */
export const REPORT_TOOL = "airbender_report_sizes";

/** What every worker's title begins with; how its thread is recognised. */
const WORKER_TITLE = "Airbender sizing ";

/** Most of one text field of an issue that a worker is shown. */
const FIELD_LIMIT = 2000;

/** One text field of an issue for the worker's instructions, cut if long. */
function field(name: string, text: string): string[] {
  const clean = text.trim();
  if (clean === "") return [];
  return [
    `${name}:`,
    clean.length <= FIELD_LIMIT
      ? clean
      : `${clean.slice(0, FIELD_LIMIT)}\n[cut here; ${clean.length - FIELD_LIMIT} more characters]`,
  ];
}

/**
 * What the worker is told.
 *
 * @param issues The issues to size, with their text.
 * @param guide The workflow's own description of its sizes.
 * @param sizeIds The size ids, smallest first, e.g. ["s", "m", "l"].
 */
export function sizingPrompt(
  issues: Issue[],
  guide: string,
  sizeIds: readonly string[],
): string {
  return [
    "You are sizing issues in the background, so that the person who owns them sees how big each one is before work starts. Nobody is reading this conversation and nobody can answer a prompt: do not ask questions, do not do any of the work the issues describe, and do not run any commands (no issue tracker, no git, no shell). You may read files in this folder where that is needed to judge an issue; keep it quick, and read nothing outside it.",
    "",
    "The sizes:",
    guide,
    "",
    "Choose one size for each issue below. In doubt between two, take the larger. A vague or one-line issue is not small because it is short: judge what it would take.",
    "",
    `Then report all of them in ONE call of the \`${REPORT_TOOL}\` tool: for each issue its id, the size (${sizeIds.map((id) => `"${id}"`).join(", ")}) and one line saying why. That tool writes the sizes onto the issues; you change nothing yourself. After the call, say "done" and stop.`,
    "",
    "The issues:",
    ...issues.flatMap((issue) => [
      "",
      `### ${issue.id}: ${issue.title}`,
      ...(issue.type === null ? [] : [`Type: ${issue.type}`]),
      ...field("Description", issue.description),
      ...field("Acceptance criteria", issue.acceptance),
      ...field("Design", issue.design),
      ...field("Notes", issue.notes),
    ]),
  ].join("\n");
}

/** Where a tab was looking when it read the issues: how a worker is placed. */
interface Scope {
  threadId: string | null;
  projectId: string | null;
}

/** One worker's errand. */
interface Job {
  path: string;
  workflow: Workflow;
  /** The issues it was given, with the content they had then. */
  batch: { issue: Issue; fingerprint: string }[];
  /** Ids the user asked for by hand: their present size may be replaced. */
  asked: Set<string>;
  /** Ids the worker has reported; the rest are remembered as tried. */
  done: Set<string>;
}

/**
 * Builds the background sizing for this plugin instance.
 *
 * @param readSettings Reads the settings afresh: whether sizing is on, and
 *   the provider and model for the worker.
 * @param readIssues Reads a folder's issues (store.readIssues).
 * @param setSize Writes an issue's size label (store.setSize).
 * @param addComment Adds a comment to an issue (store.addComment).
 * @param workflowFor The folder's workflow; null on the simple one.
 * @returns `consider`, called after a list; `forget`, called when the user
 *   sets a size; `request`, called when the user asks for an issue to be
 *   sized now; `isWorker` and `report`, for the worker's tool.
 * Side effects: one read of the plugin's storage now; worker threads,
 *   timers and storage writes later.
 */
export async function createSizing({
  bb,
  readSettings,
  readIssues,
  setSize,
  addComment,
  workflowFor,
}: {
  bb: BbPluginApi;
  readSettings: () => Promise<{
    enabled: boolean;
    providerId: string;
    model: string;
  }>;
  readIssues: (
    path: string,
  ) => Promise<{ state: "ok"; issues: Issue[] } | { state: string }>;
  setSize: (
    path: string,
    threadId: string | null,
    beadId: string,
    size: string,
    publish?: boolean,
  ) => Promise<{ message: string | null }>;
  addComment: (
    path: string,
    beadId: string,
    text: string,
  ) => Promise<{ message: string | null }>;
  workflowFor: (path: string) => Workflow | null;
}) {
  /** Folder path -> issue id -> what the background did. */
  const memory = new Map<string, Record<string, Sized>>();
  const saved = await bb.storage.kv.get<unknown>(MEMORY_KEY).catch(() => undefined);
  if (typeof saved === "object" && saved !== null) {
    for (const [path, entries] of Object.entries(saved)) {
      if (typeof entries === "object" && entries !== null) {
        memory.set(path, entries as Record<string, Sized>);
      }
    }
  }
  const save = () =>
    bb.storage.kv
      .set(MEMORY_KEY, Object.fromEntries(memory))
      .catch((cause) => bb.log.warn("could not save background sizes: " + cause));
  const remember = (path: string, beadId: string, sized: Sized) => {
    memory.set(path, { ...(memory.get(path) ?? {}), [beadId]: sized });
  };

  /** Per folder: the collecting timer, and whether a worker is running. */
  const pending = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  /** Issues the user asked to have sized now, per folder. */
  const asked = new Map<string, Set<string>>();
  /** Per folder: where the tab that last listed it was looking. */
  const scopes = new Map<string, Scope>();
  /**
   * While the automatic sizing is found switched off, the time until it is
   * looked at again. Without it every refresh of a tab with unsized issues
   * would set a timer and read the issues once more, only to do nothing.
   */
  let offUntil = 0;
  /** The errands under way, by the worker thread's title. */
  const jobs = new Map<string, Job>();
  let serial = 0;

  /**
   * Looks at a freshly read list and, if anything needs a size, arranges
   * for a worker. Returns at once; never throws.
   */
  function consider(path: string, issues: Issue[], scope: Scope): void {
    const workflow = workflowFor(path);
    if (workflow === null) return;
    scopes.set(path, scope);
    if (pending.has(path) || running.has(path)) return;
    // Found switched off a moment ago: do not look again on every refresh.
    if (Date.now() < offUntil) return;
    if (toSize(workflow, issues, memory.get(path) ?? {}).length === 0) return;
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path);
        void run(path).catch((cause) =>
          bb.log.warn("background sizing failed: " + cause),
        );
      }, COLLECT_MS),
    );
  }

  /** The user set this issue's size: it is theirs now. */
  function forget(path: string, beadId: string): void {
    const entries = memory.get(path);
    if (entries !== undefined && beadId in entries) {
      delete entries[beadId];
      void save();
    }
    // A worker that is on it at this moment must not write over it, nor
    // have what it finds remembered as the background's.
    for (const job of jobs.values()) {
      if (job.path === path) job.done.add(beadId);
    }
  }

  /**
   * The user asked for this issue to be sized now (the "Size in the
   * background" entry of a row's menu): whatever was remembered about it
   * is dropped, and it goes to a worker at once, also when the automatic
   * sizing is switched off, and also when it has a size already; asking is
   * the user's leave to replace it.
   *
   * @returns `message` null when a worker was started or the issue was
   *   queued behind a running one; otherwise why it could not be.
   */
  async function request(
    path: string,
    beadId: string,
    scope: Scope,
  ): Promise<{ message: string | null }> {
    scopes.set(path, scope);
    asked.set(path, (asked.get(path) ?? new Set()).add(beadId));
    const entries = memory.get(path);
    if (entries !== undefined) delete entries[beadId];
    if (running.has(path)) return { message: null };
    const timer = pending.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(path);
    }
    return run(path);
  }

  /** Whether BB is asking about one of this plugin's own workers. */
  function isWorker(title: string | null): boolean {
    return title !== null && jobs.has(title);
  }

  /**
   * The worker's report: writes each size it may write, with its reason.
   *
   * Checked again at this moment, against the issues as they are now: the
   * issue was in this worker's batch, has not been reported already, is
   * still open and not started, and its size is still the one the worker
   * was shown (unless the user asked for this sizing, which is their leave
   * to replace whatever is there).
   *
   * @param threadId The thread the tool was called from.
   * @returns What was written and what was not, for the worker.
   */
  async function report(
    threadId: string,
    sizes: { id: string; size: string; reason: string }[],
  ): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const job = thread?.title == null ? undefined : jobs.get(thread.title);
    if (job === undefined) {
      return "This tool is only for Airbender's own background sizing; nothing was changed.";
    }
    const read = await readIssues(job.path);
    if (!("issues" in read)) return "The issues could not be read; nothing was changed.";
    const now = new Map(read.issues.map((issue) => [issue.id, issue]));
    const lines: string[] = [];
    for (const entry of sizes) {
      const given = job.batch.find(({ issue }) => issue.id === entry.id);
      const known = job.workflow.sizes?.find((size) => size.id === entry.size.trim().toLowerCase());
      const issue = now.get(entry.id);
      const skip = (why: string) => lines.push(`${entry.id}: not written, ${why}`);
      if (given === undefined) skip("it was not one of the issues you were given");
      else if (job.done.has(entry.id)) skip("it was sized by someone meanwhile, or already reported");
      else if (known === undefined) skip(`"${entry.size}" is not a size`);
      else if (issue === undefined || issue.status === CLOSED_STATUS) skip("it is closed or gone");
      else if (stateOf(job.workflow, issue.step).id !== job.workflow.initial) skip("it has been started");
      else if (!job.asked.has(entry.id) && issue.size !== given.issue.size) skip("its size was changed meanwhile");
      else {
        job.done.add(entry.id);
        const written = await setSize(job.path, null, entry.id, known.id, false);
        if (written.message !== null) {
          skip(written.message);
          continue;
        }
        const reason = entry.reason.trim().replace(/\s+/gu, " ").slice(0, 300);
        await addComment(
          job.path,
          entry.id,
          `Size ${known.label}, sized in the background${reason === "" ? "." : `: ${reason}`}`,
        );
        remember(job.path, entry.id, {
          fingerprint: given.fingerprint,
          size: known.id,
        });
        lines.push(`${entry.id}: ${known.label}`);
      }
    }
    void save();
    bb.realtime.publish(CHANGED_CHANNEL, { path: job.path });
    return lines.length === 0 ? "Nothing was reported." : lines.join("\n");
  }

  /**
   * Starts one worker for a folder's next batch.
   *
   * @returns Once the worker has been started (or there was nothing to do,
   *   or it could not be): `message` is the reason in the last case. The
   *   waiting for the worker and the tidying up go on afterwards.
   */
  async function run(path: string): Promise<{ message: string | null }> {
    const workflow = workflowFor(path);
    const scope = scopes.get(path);
    if (workflow === null || workflow.sizes === undefined || scope === undefined) {
      return { message: "This folder's workflow has no sizes." };
    }
    const settings = await readSettings();
    if (!settings.enabled) {
      offUntil = Date.now() + OFF_RECHECK_MS;
      // Switched off, and nobody asked by hand: nothing to do.
      if ((asked.get(path)?.size ?? 0) === 0) return { message: null };
    }
    // Read again: time has passed, and the list that queued this may be
    // stale.
    const read = await readIssues(path);
    if (!("issues" in read)) {
      return { message: "The issues could not be read." };
    }
    // Asked for by the user first; then, unless switched off, what the
    // rules find.
    const wanted = asked.get(path) ?? new Set<string>();
    asked.delete(path);
    const children = (id: string) =>
      read.issues.filter((issue) => issue.parentId === id).map((issue) => issue.id);
    const byRequest = read.issues
      .filter(
        (issue) =>
          wanted.has(issue.id) &&
          issue.status !== CLOSED_STATUS &&
          stateOf(workflow, issue.step).id === workflow.initial,
      )
      .map((issue) => ({
        issue,
        fingerprint: fingerprint(issue, children(issue.id)),
      }));
    const byRule = settings.enabled
      ? toSize(workflow, read.issues, memory.get(path) ?? {}).filter(
          ({ issue }) => !wanted.has(issue.id),
        )
      : [];
    const batch = [...byRequest, ...byRule].slice(0, BATCH_SIZE);
    if (batch.length === 0) {
      return wanted.size === 0
        ? { message: null }
        : {
            message:
              "Only an open issue that has not been started can be sized in the background. Use the size dropdown on a started one.",
          };
    }

    // The errand is filed under the worker's title before the worker
    // exists: BB asks which tools a thread gets as its session starts,
    // which can be before the call that creates it has returned.
    const title = `${WORKER_TITLE}${Date.now().toString(36)}-${++serial}`;
    const job: Job = { path, workflow, batch, asked: wanted, done: new Set() };
    jobs.set(title, job);
    running.add(path);
    /** Whatever was not reported is remembered as tried, as it was. */
    const settle = () => {
      for (const { issue, fingerprint: content } of batch) {
        if (job.done.has(issue.id)) continue;
        remember(path, issue.id, { fingerprint: content, size: issue.size });
      }
      void save();
      jobs.delete(title);
      running.delete(path);
    };

    let workerId: string;
    try {
      // In the folder the tab was looking at (it may be a work tree): the
      // thread's own environment where there is a thread, and otherwise
      // that same folder, used as it is. Never the project's default
      // environment: where that is a fresh work tree, every run made one,
      // with a branch that BB left behind when it removed the tree
      // (bead-bb-2u0). A worker only reads, so it needs no folder of its
      // own.
      let projectId = scope.projectId;
      let environment:
        | { type: "reuse"; environmentId: string }
        | {
            type: "host";
            hostId?: string;
            workspace: { type: "unmanaged"; path: string };
          }
        | null = null;
      if (scope.threadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId: scope.threadId });
        projectId = thread.projectId;
        if (thread.environmentId !== null) {
          environment = { type: "reuse", environmentId: thread.environmentId };
        }
      }
      if (projectId === null) throw new Error("Pick a project first.");
      if (environment === null) {
        // The machine the folder is on: the project's default source,
        // which is where the folder was found (server/folder.ts).
        const project = await bb.sdk.projects.get({ projectId });
        const hostId = project.sources.find((source) => source.isDefault)?.hostId;
        environment = {
          type: "host",
          ...(hostId === undefined ? {} : { hostId }),
          workspace: { type: "unmanaged", path },
        };
      }
      const worker = await bb.sdk.threads.spawn({
        projectId,
        environment,
        title,
        // Hidden: a background agent that does not show in the sidebar and
        // is not a child of the user's thread, so nothing is reported there.
        visibility: "hidden",
        ...(settings.providerId.trim() === ""
          ? {}
          : { providerId: settings.providerId.trim() }),
        ...(settings.model.trim() === "" ? {} : { model: settings.model.trim() }),
        prompt: sizingPrompt(
          batch.map(({ issue }) => issue),
          workflow.sizeGuide ?? "",
          workflow.sizes.map((size) => size.id),
        ),
      });
      workerId = worker.id;
    } catch (cause) {
      // Remembered as tried (in settle), so a provider that is not
      // installed or a model name that is wrong is not hammered on every
      // refresh; a change to the issue, or the user's request, tries again.
      settle();
      const message = `Could not start a background agent to size issues: ${cause instanceof Error ? cause.message : String(cause)}`;
      bb.log.warn(`${message} (${path})`);
      return { message };
    }

    // Not awaited: the answer goes back now. The rest happens when the
    // worker goes idle (finished, or stuck waiting for someone), fails, or
    // runs past the time limit.
    void bb.sdk.threads
      .wait({ threadId: workerId, status: "idle", timeoutMs: WORKER_TIMEOUT_MS })
      .catch((cause) => bb.log.warn("sizing wait ended: " + cause))
      .then(async () => {
        // A hidden worker is cleaned up by nobody else: archive it so it
        // leaves the active lists, then stop it to release its agent.
        await bb.sdk.threads
          .archive({ threadId: workerId })
          .catch((cause) => bb.log.warn("sizing archive failed: " + cause));
        await bb.sdk.threads
          .stop({ threadId: workerId })
          .catch((cause) => bb.log.warn("sizing stop failed: " + cause));
      })
      .finally(() => {
        settle();
        bb.realtime.publish(CHANGED_CHANNEL, { path });
        // Anything the user asked for meanwhile goes next.
        if ((asked.get(path)?.size ?? 0) > 0) {
          void run(path).catch((cause) =>
            bb.log.warn("background sizing failed: " + cause),
          );
        }
      });
    return { message: null };
  }

  bb.onDispose(() => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });

  return { consider, forget, request, isWorker, report };
}
