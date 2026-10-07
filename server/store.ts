// server/store.ts — reading and changing a folder's issues.
//
// What: the operations on issues that the request handlers are built from:
// list them, create one, close or reopen one, change its type, priority,
// title or description, move it under another issue, set its category, link
// it with another issue, and read its comments.
//
// Why: every one of these is the same sequence around a different `bd`
// command: check the ids, find the folder, run bd, say in plain words what
// went wrong, and tell open tabs to reload. Written once here (see `change`,
// `applyIn` and `issuesIn`), each operation is left with only what is
// particular to it.
//
// Design notes:
// - Expected problems are returned as data (a state, or a message in plain
//   words), never thrown, so the tab can show them.
// - There are two ways to read the list. `readIssues` only reads: it is what
//   the operations use to check that an issue is still there. `listIssues`
//   is the answer for the tab: it adds the thread's current issue, starts
//   watching the folder for outside changes, and forgets a current issue
//   that has been closed. Keeping the two apart means checking something
//   never changes anything.
// - Every free-text value is passed to bd as the value of a named flag, so
//   text that starts with a dash can never be read as an option. No shell is
//   involved (see server/bd.ts).
// - An issue's category and its workflow step are both kept as one label
//   with a fixed prefix; `setPrefixedLabel` is the one place that does it.
//
// Gotchas:
// - bd reports some errors on standard output as JSON and prints `null`
//   where an empty list would be expected; both are handled where they occur.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BEAD_ID_PATTERN,
  CHANGED_CHANNEL,
  CLOSED_STATUS,
} from "../shared/constants.ts";
import type { IssueType, LinkKind } from "../shared/constants.ts";
import { descendantsOf } from "../shared/tree.ts";
import type { Issue, IssueComment, IssuesResult } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Folders } from "./folder.ts";
import {
  BRANCH_PREFIX,
  CATEGORY_PREFIX,
  RELATES_TO,
  SIZE_PREFIX,
  STEP_PREFIX,
  bdIssueSchema,
  cleanCategory,
  toIssues,
} from "./issues.ts";
import type { BdIssue } from "./issues.ts";
import { DEFAULT_WORKFLOW_ID } from "../shared/workflows.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";

/** Which folder a request is about: a thread's, or a project's. */
export interface FolderRef {
  threadId: string | null;
  projectId: string | null;
}

/** The outcome of an operation that changes something. */
export interface Outcome {
  /** Null on success, else the reason in plain words. */
  message: string | null;
}

/** What a plain read of a folder's issues gives. */
type IssuesRead =
  | { state: "ok"; issues: Issue[] }
  | { state: "no-bd" | "no-beads" | "error"; message: string };

/** The sentence for an id that cannot be a beads issue id. */
const notAnId = (id: string) => `"${id}" is not a beads issue id.`;

/** The sentence for an issue that has disappeared since the tab loaded. */
const notInList = (id: string) => `Issue ${id} is no longer in the list.`;

/**
 * Builds the issue operations for this plugin instance.
 *
 * @param folders Finding folders and running bd in them (server/folder.ts).
 * @param currentBead The thread's current issue (server/current-bead.ts).
 * @param watchFolder Starts watching a folder for outside changes
 *   (server/watch.ts).
 * @returns The operations named in this file's header, plus `readIssues`,
 *   `issuesIn`, `setStep`, `setSize` and `addComment`.
 * Side effects: none until an operation is called.
 */
export function createStore({
  bb,
  folders,
  currentBead,
  watchFolder,
  workflowChoice,
}: {
  bb: BbPluginApi;
  folders: Folders;
  currentBead: CurrentBead;
  watchFolder: (path: string) => void;
  workflowChoice: WorkflowChoice;
}) {
  const {
    folderFor,
    runBdIn,
    runIn,
    onOwnBranch,
    currentBranch,
    BD_NOT_FOUND_MESSAGE,
  } = folders;

  /** Tells every open tab to reload. */
  const changed = (threadId: string | null) =>
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });

  /**
   * Reads every issue of a folder. A plain read: nothing is written,
   * watched or published.
   *
   * Pre-condition: the folder exists (see folders.folderFor).
   * @returns The issues, or which of the expected problems occurred.
   * Side effects: runs `bd --readonly list` once (more only while searching
   *   for where bd is installed).
   */
  async function readIssues(path: string): Promise<IssuesRead> {
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
      return { state: "no-bd", message: BD_NOT_FOUND_MESSAGE };
    }
    if (run.kind === "failed") {
      if (/no beads database found/iu.test(run.message)) {
        return {
          state: "no-beads",
          message:
            "This folder does not use beads yet. Set it up to start tracking issues here.",
        };
      }
      bb.log.warn("bd list failed in " + path + ": " + run.message);
      return { state: "error", message: run.message };
    }
    let rows: BdIssue[];
    try {
      rows = z.array(bdIssueSchema).parse(JSON.parse(run.stdout));
    } catch (cause) {
      bb.log.warn("bd list output not understood in " + path + ": " + cause);
      return {
        state: "error",
        message:
          "bd answered in a format this plugin does not understand. It may be a newer or older bd than the plugin was written for.",
      };
    }
    return { state: "ok", issues: toIssues(rows) };
  }

  /**
   * The tab's list: every beads issue for the folder behind a thread or
   * project, with the thread's current issue.
   *
   * @returns An `IssuesResult`; see its `state` for the possible outcomes.
   *   Never throws for expected problems.
   * Side effects: beyond the read, starts watching the folder for outside
   *   changes, and clears a current issue that has been closed.
   */
  async function listIssues(input: FolderRef): Promise<IssuesResult> {
    const currentBeadId = await currentBead.read(input.threadId);
    const folder = await folderFor(input);
    const empty = {
      issues: [],
      currentBeadId,
      ownBranch: false,
      branch: null,
      // Filled in by the server's handler, which knows autopilot.
      autopilot: null,
      workflow:
        folder.path === null
          ? DEFAULT_WORKFLOW_ID
          : workflowChoice.idFor(folder.path),
    };
    if ("message" in folder) {
      return {
        state: "unavailable",
        path: folder.path,
        message: folder.message,
        ...empty,
      };
    }
    const { path } = folder;
    const read = await readIssues(path);
    if (read.state !== "ok") {
      return { state: read.state, path, message: read.message, ...empty };
    }
    watchFolder(path);
    const { issues } = read;
    // A closed issue is finished, so it is no longer what the thread works
    // on. The tab's own close button clears it directly, but an issue can
    // also be closed outside the plugin (an agent or the user running
    // `bd close`), which this plugin never hears about. Catching it here, on
    // the tab's next read, covers every route. The stored choice is removed
    // as well as hidden so it does not come back if the issue is reopened.
    // No change signal is published: the caller is already getting the
    // corrected answer, and publishing would make every tab reload again.
    const ok = {
      state: "ok" as const,
      path,
      message: null,
      issues,
      currentBeadId,
      ownBranch: await onOwnBranch(path),
      branch: await currentBranch(path),
      autopilot: null,
      workflow: workflowChoice.idFor(path),
    };
    const current = issues.find((issue) => issue.id === currentBeadId);
    if (
      input.threadId !== null &&
      current !== undefined &&
      current.status === CLOSED_STATUS
    ) {
      await currentBead.store(input.threadId, null);
      return { ...ok, currentBeadId: null };
    }
    return ok;
  }

  /**
   * The check most operations start with: the ids look like beads ids, the
   * folder can be read, and each of those issues is still in it.
   *
   * @param ids Issue ids that must be valid and present.
   * @returns The folder and its issues, or `{ message }` saying in plain
   *   words why the operation cannot go ahead. Changes nothing.
   */
  async function issuesIn(
    input: FolderRef,
    ...ids: string[]
  ): Promise<{ path: string; issues: Issue[] } | { message: string }> {
    const bad = ids.find((id) => !BEAD_ID_PATTERN.test(id));
    if (bad !== undefined) return { message: notAnId(bad) };
    const folder = await folderFor(input);
    if ("message" in folder) return { message: folder.message };
    const read = await readIssues(folder.path);
    if (read.state !== "ok") return { message: read.message };
    const gone = ids.find(
      (id) => !read.issues.some((issue) => issue.id === id),
    );
    if (gone !== undefined) return { message: notInList(gone) };
    return { path: folder.path, issues: read.issues };
  }

  /**
   * Runs one bd command that changes something, in a folder already found,
   * and tells open tabs to reload when it worked.
   *
   * @param what Names the command in the log when it fails, e.g. "bd update".
   */
  async function applyIn(
    path: string,
    threadId: string | null,
    args: string[],
    what: string,
  ): Promise<Outcome> {
    const run = await runIn(path, args, what);
    if ("message" in run) return { message: run.message };
    changed(threadId);
    return { message: null };
  }

  /**
   * The whole sequence for a simple change: check the ids, find the folder,
   * run the command, report, publish.
   *
   * It does not check that the issues still exist: bd says so itself, in
   * words good enough to show.
   */
  async function change(
    input: FolderRef,
    ids: string[],
    args: string[],
    what: string,
  ): Promise<Outcome> {
    const bad = ids.find((id) => !BEAD_ID_PATTERN.test(id));
    if (bad !== undefined) return { message: notAnId(bad) };
    const folder = await folderFor(input);
    if ("message" in folder) return { message: folder.message };
    return applyIn(folder.path, input.threadId, args, what);
  }

  /**
   * Creates one issue in the folder behind a thread or project.
   *
   * A new sub-issue inherits its parent's category unless one is given; this
   * happens once, here, and later changes to the parent do not follow.
   *
   * @returns `{ id }` of the new issue, or `{ message }` saying in plain words
   *   why it was not created. Never throws for expected problems.
   * Side effects: runs `bd create` once, which writes to the beads database;
   *   publishes CHANGED_CHANNEL on success.
   */
  async function createIssue(
    input: FolderRef & {
      title: string;
      description: string;
      type: IssueType | null;
      priority: number | null;
      parentId: string | null;
      category: string | null;
    },
  ): Promise<{ id: string | null; message: string | null }> {
    const fail = (message: string) => ({ id: null, message });
    if (input.parentId !== null && !BEAD_ID_PATTERN.test(input.parentId)) {
      return fail(notAnId(input.parentId));
    }
    const folder = await folderFor(input);
    if ("message" in folder) return fail(folder.message);
    const args = ["create", "--json", "--title", input.title];
    if (input.description.trim() !== "") {
      args.push("--description", input.description);
    }
    if (input.type !== null) args.push("--type", input.type);
    if (input.priority !== null) args.push("--priority", `${input.priority}`);
    if (input.parentId !== null) args.push("--parent", input.parentId);
    let category: string | null = null;
    if (input.category !== null) {
      const cleaned = cleanCategory(input.category);
      if ("reason" in cleaned) return fail(cleaned.reason);
      category = cleaned.name;
    } else if (input.parentId !== null) {
      const read = await readIssues(folder.path);
      category =
        read.state === "ok"
          ? (read.issues.find((issue) => issue.id === input.parentId)
              ?.category ?? null)
          : null;
    }
    // Safe as a flag value: it always starts with "category:", never a
    // dash, and cleanCategory has ruled out commas.
    if (category !== null) args.push("--labels", CATEGORY_PREFIX + category);
    const run = await runIn(folder.path, args, "bd create");
    if ("message" in run) return fail(run.message);
    // Published whether or not the id can be read: bd exited successfully,
    // so the issue most likely exists and the tab's reload will show it.
    changed(input.threadId);
    try {
      const { id } = z.object({ id: z.string() }).parse(JSON.parse(run.stdout));
      return { id, message: null };
    } catch {
      return fail(
        "bd reported success but its answer could not be read. Refresh to check whether the issue was created.",
      );
    }
  }

  /**
   * Closes or reopens one issue in the folder behind a thread or project.
   *
   * @param command "close" or "reopen", passed to bd as its subcommand.
   * @param publish Tell open tabs to reload afterwards. False when the
   *   caller is closing several issues and will publish once at the end.
   * @returns `{ message: null }` on success, else the reason in plain words.
   * Side effects: runs `bd close` / `bd reopen` once, which writes to the
   *   beads database; on close, clears the thread's current issue if it was
   *   this one.
   */
  async function setIssueOpen(
    command: "close" | "reopen",
    input: FolderRef & { beadId: string },
    publish = true,
  ): Promise<Outcome> {
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return { message: notAnId(input.beadId) };
    }
    const folder = await folderFor(input);
    if ("message" in folder) return { message: folder.message };
    const run = await runIn(
      folder.path,
      [command, input.beadId, "--json"],
      `bd ${command}`,
    );
    if ("message" in run) return { message: run.message };
    if (
      command === "close" &&
      input.threadId !== null &&
      (await currentBead.read(input.threadId)) === input.beadId
    ) {
      await currentBead.store(input.threadId, null);
    }
    if (publish) changed(input.threadId);
    return { message: null };
  }

  /**
   * Changes any of an issue's type, priority, title and description; a null
   * field is left as is. An empty description is a value, not "leave as
   * is": it clears the description.
   *
   * Side effects: one `bd update` when there is something to change.
   */
  async function updateIssue(
    input: FolderRef & {
      beadId: string;
      type: IssueType | null;
      priority: number | null;
      title: string | null;
      description: string | null;
    },
  ): Promise<Outcome> {
    const { beadId, type, priority, title, description } = input;
    if (!BEAD_ID_PATTERN.test(beadId)) return { message: notAnId(beadId) };
    if (
      type === null &&
      priority === null &&
      title === null &&
      description === null
    ) {
      return { message: null };
    }
    // Type comes from a fixed list and priority is a checked number. Title
    // and description are free text, so each is the value of a named flag.
    const args = ["update", beadId, "--json"];
    if (type !== null) args.push("--type", type);
    if (priority !== null) args.push("--priority", `${priority}`);
    if (title !== null) args.push("--title", title);
    if (description !== null) args.push("--description", description);
    return change(input, [beadId], args, "bd update");
  }

  /**
   * Moves an issue inside another issue (parentId set) or out to the top
   * level (parentId null). Refused when it would put an issue inside itself
   * or inside one of its own sub-issues.
   */
  async function setParent(
    input: FolderRef & { beadId: string; parentId: string | null },
  ): Promise<Outcome> {
    const { beadId, parentId } = input;
    const found = await issuesIn(
      input,
      beadId,
      ...(parentId === null ? [] : [parentId]),
    );
    if ("message" in found) return found;
    // Checked here and not left to bd: an issue inside itself would
    // disappear from every view that walks the tree from the top.
    if (
      parentId !== null &&
      (parentId === beadId ||
        descendantsOf(beadId, found.issues).some(
          (issue) => issue.id === parentId,
        ))
    ) {
      return {
        message:
          "An issue cannot be moved inside itself or inside one of its own sub-issues.",
      };
    }
    // An empty --parent is how bd takes an issue out of its parent.
    return applyIn(
      found.path,
      input.threadId,
      ["update", beadId, "--json", "--parent", parentId ?? ""],
      "bd update --parent",
    );
  }

  /**
   * Sets or clears one issue's category.
   *
   * Side effects: see setPrefixedLabel.
   */
  async function setCategory(
    input: FolderRef & { beadId: string; category: string | null },
  ): Promise<Outcome> {
    const found = await issuesIn(input, input.beadId);
    if ("message" in found) return found;
    let next: string | null = null;
    if (input.category !== null) {
      const cleaned = cleanCategory(input.category);
      if ("reason" in cleaned) return { message: cleaned.reason };
      next = cleaned.name;
    }
    return setPrefixedLabel(
      found.path,
      input.threadId,
      input.beadId,
      CATEGORY_PREFIX,
      next,
      "bd update (category)",
    );
  }

  /**
   * Makes an issue carry exactly one label with a given prefix (or none):
   * the way a category and a workflow step are kept.
   *
   * Every label with the prefix is removed first, so an issue never ends up
   * with two, even if one was added by hand with bd.
   *
   * @param value What follows the prefix; null removes the label.
   * @param publish Tell open tabs to reload afterwards.
   * Side effects: one read of the issue's labels; one `bd update` when
   *   there is something to change.
   */
  async function setPrefixedLabel(
    path: string,
    threadId: string | null,
    beadId: string,
    prefix: string,
    value: string | null,
    what: string,
    publish = true,
  ): Promise<Outcome> {
    // The list this plugin returns has these labels taken out, so the raw
    // labels are read again here to know exactly which ones to remove.
    const raw = await runIn(path, [
      "--readonly",
      "label",
      "list",
      beadId,
      "--json",
    ]);
    if ("message" in raw) return { message: raw.message };
    let present: string[];
    try {
      present = z
        .array(z.string())
        .nullable()
        .transform((labels) => labels ?? [])
        .parse(JSON.parse(raw.stdout))
        .filter((label) => label.startsWith(prefix));
    } catch {
      return {
        message: "bd answered in a format this plugin does not understand.",
      };
    }
    const wanted = value === null ? null : prefix + value;
    const args = ["update", beadId, "--json"];
    for (const label of present) {
      if (label !== wanted) args.push("--remove-label", label);
    }
    if (wanted !== null && !present.includes(wanted)) {
      args.push("--add-label", wanted);
    }
    if (args.length === 3) return { message: null }; // Nothing to change.
    const run = await runIn(path, args, what);
    if ("message" in run) return { message: run.message };
    if (publish) changed(threadId);
    return { message: null };
  }

  /**
   * Records the workflow step an issue is at.
   *
   * Pre-condition: `step` is a state id of the workflow (letters, digits and
   *   dashes), and the issue is known to be in the folder.
   */
  function setStep(
    path: string,
    threadId: string | null,
    beadId: string,
    step: string,
    publish = true,
  ): Promise<Outcome> {
    return setPrefixedLabel(
      path,
      threadId,
      beadId,
      STEP_PREFIX,
      step,
      "bd update (step)",
      publish,
    );
  }

  /**
   * Records an issue's size: how much of the workflow it takes.
   *
   * Pre-condition: `size` is a size id of the workflow, and the issue is
   *   known to be in the folder.
   */
  function setSize(
    path: string,
    threadId: string | null,
    beadId: string,
    size: string,
    publish = true,
  ): Promise<Outcome> {
    return setPrefixedLabel(
      path,
      threadId,
      beadId,
      SIZE_PREFIX,
      size,
      "bd update (size)",
      publish,
    );
  }

  /**
   * Records the branch an epic's issues are worked on, or forgets it
   * (null).
   *
   * Pre-condition: the issue is known to be in the folder; `branch`, when
   *   given, has no comma in it (bd splits a label on commas; git branch
   *   names made by this plugin and by BB have none).
   */
  function setBranch(
    path: string,
    threadId: string | null,
    beadId: string,
    branch: string | null,
    publish = true,
  ): Promise<Outcome> {
    return setPrefixedLabel(
      path,
      threadId,
      beadId,
      BRANCH_PREFIX,
      branch,
      "bd update (branch)",
      publish,
    );
  }

  /**
   * Adds a comment to an issue. Used for the record of workflow moves, which
   * is where the tab already shows an issue's history.
   *
   * @param text Must not start with a dash (bd would read it as an option);
   *   callers pass text that starts with a fixed word.
   * Side effects: one `bd comment`. Nothing is published: callers publish
   *   once for the whole move.
   */
  async function addComment(
    path: string,
    beadId: string,
    text: string,
  ): Promise<Outcome> {
    const run = await runIn(path, ["comment", beadId, text], "bd comment");
    return { message: "message" in run ? run.message : null };
  }

  /**
   * Shared checks for adding and removing a link: both ids look like beads
   * ids, are different, and are in the folder's list.
   *
   * @returns The folder to run bd in, or `{ message }` saying in plain words
   *   why the link cannot be touched.
   */
  async function linkEnds(
    input: FolderRef & { fromId: string; toId: string },
  ): Promise<{ path: string } | { message: string }> {
    for (const id of [input.fromId, input.toId]) {
      if (!BEAD_ID_PATTERN.test(id)) return { message: notAnId(id) };
    }
    if (input.fromId === input.toId) {
      return { message: "An issue cannot be linked to itself." };
    }
    return issuesIn(input, input.fromId, input.toId);
  }

  /**
   * Adds a link of one of beads' kinds, stored on `fromId` and pointing at
   * `toId` ("fromId is blocked by toId").
   *
   * "related" goes through beads' own see-also command, which links both
   * issues to each other; every other kind is a one-way dependency. Cycles
   * and duplicates are left to bd, whose message is passed on.
   */
  async function link(
    input: FolderRef & { fromId: string; toId: string; kind: LinkKind },
  ): Promise<Outcome> {
    const ends = await linkEnds(input);
    if ("message" in ends) return ends;
    const { fromId, toId, kind } = input;
    return applyIn(
      ends.path,
      input.threadId,
      kind === "related"
        ? ["dep", "relate", fromId, toId, "--json"]
        : ["dep", "add", fromId, toId, "--type", kind, "--json"],
      "bd dep add",
    );
  }

  /**
   * Removes the link stored on `fromId` that points at `toId`.
   *
   * @param input.kind The link's beads type as listed. A two-way link is
   *   undone with the command that made it, so both halves go; `dep remove`
   *   would leave the other issue's half behind.
   */
  async function unlink(
    input: FolderRef & { fromId: string; toId: string; kind: string },
  ): Promise<Outcome> {
    const ends = await linkEnds(input);
    if ("message" in ends) return ends;
    const { fromId, toId, kind } = input;
    return applyIn(
      ends.path,
      input.threadId,
      kind === RELATES_TO
        ? ["dep", "unrelate", fromId, toId, "--json"]
        : ["dep", "remove", fromId, toId, "--json"],
      "bd dep remove",
    );
  }

  /**
   * Reads the comments of one issue, oldest first.
   *
   * @returns `{ comments, message: null }`, or an empty list with the reason
   *   in plain words. Never throws for expected problems.
   * Side effects: runs `bd --readonly comments` once; nothing is written.
   */
  async function listComments(
    input: FolderRef & { beadId: string },
  ): Promise<{ comments: IssueComment[]; message: string | null }> {
    const fail = (message: string) => ({ comments: [], message });
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return fail(notAnId(input.beadId));
    }
    const folder = await folderFor(input);
    if ("message" in folder) return fail(folder.message);
    const run = await runIn(folder.path, [
      "--readonly",
      "comments",
      input.beadId,
      "--json",
    ]);
    if ("message" in run) return fail(run.message);
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
    readIssues,
    listIssues,
    issuesIn,
    createIssue,
    setIssueOpen,
    updateIssue,
    setParent,
    setCategory,
    link,
    unlink,
    listComments,
    setStep,
    setSize,
    setBranch,
    addComment,
    changed,
  };
}

/** What createStore returns; handed to the modules built on top of it. */
export type Store = ReturnType<typeof createStore>;
