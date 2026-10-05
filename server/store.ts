// server/store.ts — reading and changing issues for a thread or project.
//
// What: finds the folder a thread or project works in, runs bd there, and
// offers the operations the request handlers are built from: list, create,
// close and reopen, set a category, read comments, check the two ends of a
// link, and read or write the thread's current bead.
//
// Why: every request starts the same way (which folder? is bd there? is beads
// set up?), so those answers live in one place that the handlers, setup and
// Define all share.
//
// Design notes:
// - Expected problems are returned as data (a state or a message in plain
//   words), never thrown, so the tab can show them.
// - The thread's current bead is a note kept by BB on the thread, not in
//   beads; an explicit null means "none", so an older value under the plugin's
//   previous id is not picked up again.
// - The marks for issues being defined live here because the list shows them;
//   server/define.ts sets and clears them.
//
// Gotchas:
// - listIssues is not a pure read: it starts watching the folder and clears a
//   current bead that has been closed. Making it one is tracked in bead-bb-
//   dw0.4.
// - A missing folder and a missing program both look the same to the operating
//   system; the folder is always checked first.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  BEAD_ID_PATTERN,
  CHANGED_CHANNEL,
  CLOSED_STATUS,
  ISSUE_TYPES,
} from "../shared/constants.ts";
import { runBd } from "./bd.ts";
import type { BdRun } from "./bd.ts";
import type { Issue, IssueComment, IssuesResult } from "./contract.ts";
import {
  CATEGORY_PREFIX,
  bdIssueSchema,
  cleanCategory,
  toIssues,
} from "./issues.ts";
import type { BdIssue } from "./issues.ts";

/**
 * The id this plugin had before it was renamed to "airbender". BB keeps a
 * plugin's per-thread data under the plugin's id, so each thread's current
 * bead from before the rename is still stored under this one; it is read as
 * a fallback (see readCurrentBead) and never written.
 */
const LEGACY_PLUGIN_ID = "beads";

/** Key under which a thread's current bead id is stored in thread metadata. */
const CURRENT_BEAD_KEY = "currentBead";

/**
 * Builds the issue store for this plugin instance.
 *
 * @returns The operations listed in this file's header, plus `defining` and
 *   `defineKey` (which issues a Define run is working on right now).
 * Side effects: none until an operation is called.
 */
export function createStore({
  bb,
  bdCandidates,
  watchFolder,
}: {
  bb: BbPluginApi;
  /** Program names or paths to try for bd, in order. */
  bdCandidates: string[];
  /** Starts watching a folder for outside changes (server/watch.ts). */
  watchFolder: (path: string) => void;
}) {
  /**
   * Finds the folder on the BB server machine that a thread or project works
   * in.
   *
   * A thread's own checkout wins (it may be a worktree); otherwise the
   * project's default folder is used.
   *
   * @returns `{ path }`, or `{ reason }` in plain language when there is no
   *   folder on this machine to look in.
   */
  async function resolveFolder(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<{ path: string } | { reason: string }> {
    const { primaryHostId } = await bb.sdk.system.config();
    let projectId = input.projectId;
    if (input.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      projectId = thread.projectId;
      if (thread.environmentId !== null) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (environment.hostId !== primaryHostId) {
          return {
            reason:
              "This thread works on another machine. The Airbender tab can only read folders on the machine BB itself runs on.",
          };
        }
        if (environment.path !== null) return { path: environment.path };
      }
    }
    if (projectId === null) {
      return { reason: "Pick a project to see its beads issues." };
    }
    const project = await bb.sdk.projects.get({ projectId });
    const local = project.sources.filter(
      (source) => source.hostId === primaryHostId,
    );
    const source = local.find((candidate) => candidate.isDefault) ?? local[0];
    if (source === undefined) {
      return {
        reason:
          "This project has no folder on the machine BB itself runs on, so there is nowhere to look for beads issues.",
      };
    }
    return { path: source.path };
  }

  /** Running define runs: folder + issue id -> the thread doing the work. */
  const defining = new Map<string, string>();

  const defineKey = (path: string, beadId: string) => `${path}\n${beadId}`;

  const BD_NOT_FOUND_MESSAGE =
    "BB could not find the bd command. Install beads, or set its full path under this plugin's settings (bd command) and reload the plugin.";

  /**
   * Runs `bd` in a folder, trying each known install location until one
   * exists.
   *
   * @returns The first run that found a program, or "not-found" if none did.
   */
  async function runBdIn(path: string, args: string[]): Promise<BdRun> {
    let run: BdRun = { kind: "not-found" };
    for (const candidate of bdCandidates) {
      run = await runBd(candidate, args, path);
      if (run.kind !== "not-found") break;
    }
    return run;
  }

  /**
   * The beads program that works on this machine: the first of the known
   * locations that runs, or null. Used where the program's own path is
   * needed (to put it in a terminal command), not just its output.
   */
  async function findBd(cwd: string): Promise<string | null> {
    for (const candidate of bdCandidates) {
      const run = await runBd(candidate, ["--version"], cwd);
      if (run.kind !== "not-found") return candidate;
    }
    return null;
  }

  /**
   * Shared checks for adding and removing a link: both ids look like beads
   * ids, are different, and are in the folder's list.
   *
   * @returns The folder to run bd in, or `{ message }` saying in plain words
   *   why the link cannot be touched.
   */
  async function linkEnds(input: {
    threadId: string | null;
    projectId: string | null;
    fromId: string;
    toId: string;
  }): Promise<{ path: string } | { message: string }> {
    for (const id of [input.fromId, input.toId]) {
      if (!BEAD_ID_PATTERN.test(id)) {
        return { message: `"${id}" is not a beads issue id.` };
      }
    }
    if (input.fromId === input.toId) {
      return { message: "An issue cannot be linked to itself." };
    }
    const listed = await listIssues({
      threadId: input.threadId,
      projectId: input.projectId,
    });
    if (listed.state !== "ok" || listed.path === null) {
      return { message: listed.message ?? "The issues could not be read." };
    }
    for (const id of [input.fromId, input.toId]) {
      if (!listed.issues.some((issue) => issue.id === id)) {
        return { message: `Issue ${id} is no longer in the list.` };
      }
    }
    return { path: listed.path };
  }

  /**
   * Reads which issue a thread is working on.
   *
   * @returns The stored id, or null when none is stored or the stored value is
   *   not a plausible id. Thread metadata can be written by anything with
   *   access to the thread, so the value is checked, not trusted.
   */
  async function readCurrentBead(threadId: string | null): Promise<string | null> {
    if (threadId === null) return null;
    const asBeadId = (value: unknown) =>
      typeof value === "string" && BEAD_ID_PATTERN.test(value) ? value : null;
    const own = (await bb.sdk.threads.getPluginMetadata({
      threadId,
    })) as Record<string, unknown>;
    // Anything stored under this plugin's own id decides, including a
    // stored "none" (see writeCurrentBead).
    if (CURRENT_BEAD_KEY in own) return asBeadId(own[CURRENT_BEAD_KEY]);
    // Nothing under our own id: the thread may have its choice from before
    // the plugin was renamed, stored under the old id. Reading it here is
    // what keeps that data across the rename. A failure to read it is not
    // worth failing the whole list for.
    const legacy = (await bb.sdk.threads
      .getPluginMetadata({ threadId, pluginId: LEGACY_PLUGIN_ID })
      .catch(() => ({}))) as Record<string, unknown>;
    return asBeadId(legacy[CURRENT_BEAD_KEY]);
  }

  /**
   * Records (or, with null, clears) the issue a thread is working on and tells
   * every open tab to reload.
   *
   * Pre-condition: `beadId`, when given, already matches BEAD_ID_PATTERN.
   * Side effects: writes this plugin's metadata on the thread; publishes
   *   CHANGED_CHANNEL. Beads' own database is not touched.
   */
  async function writeCurrentBead(
    threadId: string,
    beadId: string | null,
  ): Promise<void> {
    // "None" is stored as an explicit null, not by removing the key: with
    // the key gone, readCurrentBead would fall back to what the thread had
    // under the plugin's old id, and a cleared choice would come back.
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [CURRENT_BEAD_KEY]: beadId },
    });
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });
  }

  /**
   * Lists every beads issue for the folder behind a thread or project.
   *
   * @returns An `IssuesResult`; see its `state` for the possible outcomes.
   *   Never throws for expected problems.
   * Side effects: runs `bd --readonly list` once (more only while searching
   *   for where bd is installed).
   */
  async function listIssues(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<IssuesResult> {
    const currentBeadId = await readCurrentBead(input.threadId);
    const folder = await resolveFolder(input);
    const empty = { issues: [], currentBeadId };
    if ("reason" in folder) {
      return {
        state: "unavailable",
        path: null,
        message: folder.reason,
        ...empty,
      };
    }
    const { path } = folder;
    // Checked first because a missing folder and a missing program produce
    // the same error from the operating system, and would otherwise be
    // reported as "bd not found".
    if (!existsSync(path)) {
      return {
        state: "unavailable",
        path,
        message: `The folder ${path} does not exist on the machine BB runs on.`,
        ...empty,
      };
    }
    // --limit 0 lifts bd's default cap of 50 rows; --all includes closed.
    const run = await runBdIn(path, [
      "--readonly",
      "list",
      "--all",
      "--json",
      "--limit",
      "0",
    ]);
    if (run.kind === "not-found") {
      return { state: "no-bd", path, message: BD_NOT_FOUND_MESSAGE, ...empty };
    }
    if (run.kind === "failed") {
      if (/no beads database found/iu.test(run.message)) {
        return {
          state: "no-beads",
          path,
          message:
            "This folder does not use beads yet. Set it up to start tracking issues here.",
          ...empty,
        };
      }
      bb.log.warn("bd list failed in " + path + ": " + run.message);
      return { state: "error", path, message: run.message, ...empty };
    }
    let rows: BdIssue[];
    try {
      rows = z.array(bdIssueSchema).parse(JSON.parse(run.stdout));
    } catch (cause) {
      bb.log.warn("bd list output not understood in " + path + ": " + cause);
      return {
        state: "error",
        path,
        message:
          "bd answered in a format this plugin does not understand. It may be a newer or older bd than the plugin was written for.",
        ...empty,
      };
    }
    watchFolder(path);
    const issues = toIssues(rows).map((issue) => ({
      ...issue,
      defineThreadId: defining.get(defineKey(path, issue.id)) ?? null,
    }));
    // A closed issue is finished, so it is no longer what the thread works
    // on. The tab's own close button clears it directly, but an issue can
    // also be closed outside the plugin (an agent or the user running
    // `bd close`), which this plugin never hears about. Catching it here, on
    // the next read, covers every route. The stored choice is removed as
    // well as hidden so it does not come back if the issue is reopened.
    // No change signal is published: the caller is already getting the
    // corrected answer, and publishing would make every tab reload again.
    const current = issues.find((issue) => issue.id === currentBeadId);
    if (
      input.threadId !== null &&
      current !== undefined &&
      current.status === CLOSED_STATUS
    ) {
      // Stored as an explicit null, for the reason given in
      // writeCurrentBead.
      await bb.sdk.threads.updatePluginMetadata({
        threadId: input.threadId,
        set: { [CURRENT_BEAD_KEY]: null },
      });
      return { state: "ok", path, message: null, issues, currentBeadId: null };
    }
    return { state: "ok", path, message: null, issues, currentBeadId };
  }

  /**
   * Sets or clears one issue's category.
   *
   * Every category label the issue has is removed first, so an issue never
   * ends up with two, even if one was added by hand with bd.
   *
   * @returns `{ message: null }` on success, else the reason in plain words.
   * Side effects: one `bd update`, which writes to the beads database;
   *   publishes CHANGED_CHANNEL on success.
   */
  async function setCategory(input: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
    category: string | null;
  }): Promise<{ message: string | null }> {
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return { message: `"${input.beadId}" is not a beads issue id.` };
    }
    const listed = await listIssues(input);
    if (listed.state !== "ok" || listed.path === null) {
      return { message: listed.message ?? "The issues could not be read." };
    }
    if (!listed.issues.some((issue) => issue.id === input.beadId)) {
      return { message: `Issue ${input.beadId} is no longer in the list.` };
    }
    let next: string | null = null;
    if (input.category !== null) {
      const cleaned = cleanCategory(input.category);
      if ("reason" in cleaned) return { message: cleaned.reason };
      next = cleaned.name;
    }
    // The list this plugin returns has the category labels taken out, so the
    // raw labels are read again here to know exactly which ones to remove.
    const raw = await runBdIn(listed.path, [
      "--readonly",
      "label",
      "list",
      input.beadId,
      "--json",
    ]);
    if (raw.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (raw.kind === "failed") return { message: raw.message };
    let present: string[];
    try {
      present = z
        .array(z.string())
        .nullable()
        .transform((labels) => labels ?? [])
        .parse(JSON.parse(raw.stdout))
        .filter((label) => label.startsWith(CATEGORY_PREFIX));
    } catch {
      return {
        message: "bd answered in a format this plugin does not understand.",
      };
    }
    const wanted = next === null ? null : CATEGORY_PREFIX + next;
    const args = ["update", input.beadId, "--json"];
    for (const label of present) {
      if (label !== wanted) args.push("--remove-label", label);
    }
    if (wanted !== null && !present.includes(wanted)) {
      args.push("--add-label", wanted);
    }
    if (args.length === 3) return { message: null }; // Nothing to change.
    const run = await runBdIn(listed.path, args);
    if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (run.kind === "failed") {
      bb.log.warn("bd update (category) failed in " + listed.path + ": " + run.message);
      return { message: run.message };
    }
    bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    return { message: null };
  }

  /**
   * Creates one issue in the folder behind a thread or project.
   *
   * @returns `{ id }` of the new issue, or `{ message }` saying in plain words
   *   why it was not created. Never throws for expected problems.
   * Side effects: runs `bd create` once, which writes to the beads database;
   *   publishes CHANGED_CHANNEL on success.
   */
  async function createIssue(input: {
    threadId: string | null;
    projectId: string | null;
    title: string;
    description: string;
    type: (typeof ISSUE_TYPES)[number] | null;
    priority: number | null;
    parentId: string | null;
    category: string | null;
  }): Promise<{ id: string | null; message: string | null }> {
    if (input.parentId !== null && !BEAD_ID_PATTERN.test(input.parentId)) {
      return {
        id: null,
        message: `"${input.parentId}" is not a beads issue id.`,
      };
    }
    const folder = await resolveFolder(input);
    if ("reason" in folder) return { id: null, message: folder.reason };
    if (!existsSync(folder.path)) {
      return {
        id: null,
        message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
      };
    }
    // Every free-text value is passed as the value of a named flag, so text
    // that starts with a dash can never be read by bd as an option.
    const args = ["create", "--json", "--title", input.title];
    if (input.description.trim() !== "") {
      args.push("--description", input.description);
    }
    if (input.type !== null) args.push("--type", input.type);
    if (input.priority !== null) args.push("--priority", `${input.priority}`);
    if (input.parentId !== null) args.push("--parent", input.parentId);
    // The category: the one chosen, else the parent's (a new sub-issue
    // inherits its parent's category; this happens once, here, and later
    // changes to the parent do not follow).
    if (input.category !== null || input.parentId !== null) {
      const listed = await listIssues(input);
      let category: string | null = null;
      if (input.category !== null) {
        const cleaned = cleanCategory(input.category);
        if ("reason" in cleaned) return { id: null, message: cleaned.reason };
        category = cleaned.name;
      } else {
        category =
          listed.issues.find((issue) => issue.id === input.parentId)
            ?.category ?? null;
      }
      // Safe as a flag value: it always starts with "category:", never a
      // dash, and cleanCategory has ruled out commas.
      if (category !== null) args.push("--labels", CATEGORY_PREFIX + category);
    }
    const run = await runBdIn(folder.path, args);
    if (run.kind === "not-found") {
      return { id: null, message: BD_NOT_FOUND_MESSAGE };
    }
    if (run.kind === "failed") {
      bb.log.warn("bd create failed in " + folder.path + ": " + run.message);
      return { id: null, message: run.message };
    }
    let id: string;
    try {
      id = z.object({ id: z.string() }).parse(JSON.parse(run.stdout)).id;
    } catch {
      // bd exited successfully, so the issue most likely exists; the tab's
      // reload will show it even though we could not read its id.
      bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
      return {
        id: null,
        message:
          "bd reported success but its answer could not be read. Refresh to check whether the issue was created.",
      };
    }
    bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    return { id, message: null };
  }

  /**
   * Closes or reopens one issue in the folder behind a thread or project.
   *
   * @param command "close" or "reopen", passed to bd as its subcommand.
   * @returns `{ message: null }` on success, else the reason in plain words.
   *   Never throws for expected problems.
   * Side effects: runs `bd close` / `bd reopen` once, which writes to the
   *   beads database; on close, clears the thread's current bead if it was
   *   this issue; publishes CHANGED_CHANNEL on success.
   */
  async function setIssueOpen(
    command: "close" | "reopen",
    input: { threadId: string | null; projectId: string | null; beadId: string },
  ): Promise<{ message: string | null }> {
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return { message: `"${input.beadId}" is not a beads issue id.` };
    }
    const folder = await resolveFolder(input);
    if ("reason" in folder) return { message: folder.reason };
    if (!existsSync(folder.path)) {
      return {
        message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
      };
    }
    const run = await runBdIn(folder.path, [command, input.beadId, "--json"]);
    if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (run.kind === "failed") {
      bb.log.warn(`bd ${command} failed in ` + folder.path + ": " + run.message);
      return { message: run.message };
    }
    if (
      command === "close" &&
      input.threadId !== null &&
      (await readCurrentBead(input.threadId)) === input.beadId
    ) {
      // Publishes CHANGED_CHANNEL itself.
      await writeCurrentBead(input.threadId, null);
    } else {
      bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    }
    return { message: null };
  }

  /**
   * Reads the comments of one issue, oldest first.
   *
   * @returns `{ comments, message: null }`, or an empty list with the reason
   *   in plain words. Never throws for expected problems.
   * Side effects: runs `bd --readonly comments` once; nothing is written.
   */
  async function listComments(input: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
  }): Promise<{ comments: IssueComment[]; message: string | null }> {
    const fail = (message: string) => ({ comments: [], message });
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return fail(`"${input.beadId}" is not a beads issue id.`);
    }
    const folder = await resolveFolder(input);
    if ("reason" in folder) return fail(folder.reason);
    if (!existsSync(folder.path)) {
      return fail(
        `The folder ${folder.path} does not exist on the machine BB runs on.`,
      );
    }
    const run = await runBdIn(folder.path, [
      "--readonly",
      "comments",
      input.beadId,
      "--json",
    ]);
    if (run.kind === "not-found") return fail(BD_NOT_FOUND_MESSAGE);
    if (run.kind === "failed") return fail(run.message);
    try {
      // bd prints `null` rather than `[]` for an issue without comments.
      const rows = z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]),
            author: z.string().optional(),
            text: z.string().optional(),
            created_at: z.string().optional(),
          }),
        )
        .nullable()
        .parse(JSON.parse(run.stdout));
      const comments = (rows ?? []).map((row) => ({
        id: `${row.id}`,
        author: row.author ?? "",
        createdAt: row.created_at ?? "",
        text: row.text ?? "",
      }));
      comments.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      return { comments, message: null };
    } catch {
      return fail("bd answered in a format this plugin does not understand.");
    }
  }

  return {
    resolveFolder,
    BD_NOT_FOUND_MESSAGE,
    runBdIn,
    findBd,
    linkEnds,
    readCurrentBead,
    writeCurrentBead,
    listIssues,
    setCategory,
    createIssue,
    setIssueOpen,
    listComments,
    defining,
    defineKey,
  };
}

/** What createStore returns; handed to the modules built on top of it. */
export type Store = ReturnType<typeof createStore>;
