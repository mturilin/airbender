// Sizing is an explicit issue-menu action, never a side effect of a read.
// One worker per repository handles only requested issues. A report is checked
// against current issue state before the plugin writes its size and comment.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL, CLOSED_STATUS } from "../shared/constants.ts";
import { stateOf } from "../shared/workflow.ts";
import type { Workflow } from "../shared/workflow.ts";
import type { Issue } from "./contract.ts";

/** Longest a worker may run before it is tidied away. */
const WORKER_TIMEOUT_MS = 10 * 60_000;

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
  /** Only the issues the user explicitly requested. */
  batch: Issue[];
  /** Ids the worker has reported or the user has sized meanwhile. */
  done: Set<string>;
}

/**
 * Builds the background sizing for this plugin instance.
 *
 * @param readSettings The provider and model for the requested worker.
 * @param readIssues Reads a folder's issues (store.readIssues).
 * @param setSize Writes an issue's size label (store.setSize).
 * @param addComment Adds a comment to an issue (store.addComment).
 * @param workflowFor The folder's workflow; null on the simple one.
 * @returns `forget`, called when the user sets a size; `request`, the only
 *   worker entry point; `isWorker` and `report`, for the worker's tool.
 * Side effects: none until a request; worker threads and tracker writes later.
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
  const running = new Set<string>();
  /** Issues the user asked to have sized now, per folder. */
  const asked = new Map<string, Set<string>>();
  /** Per folder: where the explicit request originated. */
  const scopes = new Map<string, Scope>();
  /** The errands under way, by the worker thread's title. */
  const jobs = new Map<string, Job>();
  let serial = 0;


  /** The user set this issue's size: it is theirs now. */
  function forget(path: string, beadId: string): void {
    asked.get(path)?.delete(beadId);
    // A worker already handling the issue must not overwrite the user's size.
    for (const job of jobs.values()) {
      if (job.path === path) job.done.add(beadId);
    }
  }

  /**
   * Explicitly requests an issue's size, replacing its current size only
   * if nobody changes it while the worker is running.
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
    if (running.has(path)) return { message: null };
    return run(path);
  }

  /** Whether BB is asking about one of this plugin's own workers. */
  function isWorker(title: string | null): boolean {
    return title !== null && jobs.has(title);
  }

  /**
   * The worker's report: writes each size it may write, with its reason.
   *
   * The issue must belong to this job, still be open and not started, and
   * have the size the worker was shown.
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
      const given = job.batch.find((issue) => issue.id === entry.id);
      const known = job.workflow.sizes?.find((size) => size.id === entry.size.trim().toLowerCase());
      const issue = now.get(entry.id);
      const skip = (why: string) => lines.push(`${entry.id}: not written, ${why}`);
      if (given === undefined) skip("it was not one of the issues you were given");
      else if (job.done.has(entry.id)) skip("it was sized by someone meanwhile, or already reported");
      else if (known === undefined) skip(`"${entry.size}" is not a size`);
      else if (issue === undefined || issue.status === CLOSED_STATUS) skip("it is closed or gone");
      else if (stateOf(job.workflow, issue.step).id !== job.workflow.initial) skip("it has been started");
      else if (issue.size !== given.size) skip("its size was changed meanwhile");
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
        lines.push(`${entry.id}: ${known.label}`);
      }
    }
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
    // Read again: time has passed, and the list that queued this may be
    // stale.
    const read = await readIssues(path);
    if (!("issues" in read)) {
      return { message: "The issues could not be read." };
    }
    const wanted = asked.get(path) ?? new Set<string>();
    asked.delete(path);
    const requested = read.issues.filter(
      (issue) =>
        wanted.has(issue.id) &&
        issue.status !== CLOSED_STATUS &&
        stateOf(workflow, issue.step).id === workflow.initial,
    );
    const batch = requested.slice(0, 10);
    if (requested.length > batch.length) {
      asked.set(path, new Set(requested.slice(batch.length).map((issue) => issue.id)));
    }
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
    const job: Job = { path, workflow, batch, done: new Set() };
    jobs.set(title, job);
    running.add(path);
    const settle = () => {
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
          batch,
          workflow.sizeGuide ?? "",
          workflow.sizes.map((size) => size.id),
        ),
      });
      workerId = worker.id;
    } catch (cause) {
      // A failed request is visible; only another explicit request retries it.
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


  return { forget, request, isWorker, report };
}
