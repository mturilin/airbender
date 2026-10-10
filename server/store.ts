// server/store.ts — reading and changing a folder's issues.
//
// What: the operations on issues that the request handlers are built from:
// list them, create one, close or reopen one, change its type, priority,
// title or description, move it under another issue, set its category, link
// it with another issue, and read its comments.
//
// Why: every one of these is the same sequence around a different call on
// the folder's tracker: check the ids, find the folder, ask the tracker, say
// in plain words what went wrong, and tell open tabs to reload. Written once
// here (see `change`, `applyIn` and `issuesIn`), each operation is left with
// only what is particular to it.
//
// Design notes:
// - Issues are read and changed only through the tracker core (tracker/),
//   the layer `bend` is built on, so there is one code path to beads
//   (bead-bb-c9l.2). No bd command is written in this file; the beads
//   adapter (tracker/beads.ts) holds them all.
// - Expected problems are returned as data (a state, or a message in plain
//   words), never thrown, so the tab can show them. The tracker throws;
//   server/trackers.ts turns that into data.
// - There are two ways to read the list. `readIssues` only reads: it is what
//   the operations use to check that an issue is still there. `listIssues`
//   is the answer for the tab: it adds the thread's current issue, starts
//   watching the folder for outside changes, and forgets a current issue
//   that has been closed. Keeping the two apart means checking something
//   never changes anything.
// - An issue's workflow step, its size and an epic's branch are each kept
//   as one label with a fixed prefix; `setPrefixedLabel` is the one place
//   that does it. They are the tab's, not the tracker's, which only adds
//   and removes the labels it is given.
// - Checks the tracker makes itself are not repeated here: that an issue
//   exists, that it is not moved inside itself, that it is not linked to
//   itself. Its refusals are in plain words and are passed on.

import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  BEAD_ID_PATTERN,
  CHANGED_CHANNEL,
  CLOSED_STATUS,
} from "../shared/constants.ts";
import type { IssueType, LinkKind } from "../shared/constants.ts";
import { splitRequirements } from "../tracker/parts.ts";
import type { Tracker } from "../tracker/types.ts";
import type { Issue, IssueComment, IssuesResult } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Folders } from "./folder.ts";
import {
  BRANCH_PREFIX,
  RELATES_TO,
  SIZE_PREFIX,
  STEP_PREFIX,
  toIssues,
} from "./issues.ts";
import type { Trackers } from "./trackers.ts";
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
 * @param folders Finding folders and reading git in them (server/folder.ts).
 * @param trackers The tracker for each folder (server/trackers.ts).
 * @param currentBead The thread's current issue (server/current-bead.ts).
 * @param watchFolder Starts watching a folder for outside changes
 *   (server/watch.ts).
 * @returns The operations named in this file's header, plus `readIssues`,
 *   `issuesIn`, `setStep`, `setSize`, `setBranch` and `addComment`.
 * Side effects: none until an operation is called.
 */
export function createStore({
  bb,
  folders,
  trackers,
  currentBead,
  watchFolder,
  workflowChoice,
}: {
  bb: BbPluginApi;
  folders: Folders;
  trackers: Trackers;
  currentBead: CurrentBead;
  watchFolder: (path: string) => void;
  workflowChoice: WorkflowChoice;
}) {
  const { folderFor, onOwnBranch, currentBranch, isWorkTree } = folders;
  const { trackerFor, problem } = trackers;

  /** Tells every open tab to reload. */
  const changed = (threadId: string | null) =>
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });

  /**
   * Reads every issue of a folder. A plain read: nothing is written,
   * watched or published.
   *
   * Pre-condition: the folder exists (see folders.folderFor).
   * @returns The issues, or which of the expected problems occurred.
   * Side effects: one read of the folder's tracker.
   */
  async function readIssues(path: string): Promise<IssuesRead> {
    const found = await trackerFor(path);
    if ("state" in found) return found;
    try {
      // "all" includes the closed ones, which the tab shows too.
      const issues = await found.tracker.list({ status: "all" });
      return { state: "ok", issues: toIssues(issues) };
    } catch (cause) {
      // Named, so that it is logged: a list that cannot be read is worth a
      // line. A folder that is not set up is an ordinary state and is not.
      return problem(path, cause, "Reading issues");
    }
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
      workTree: false,
      home: homedir(),
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
      workTree: await isWorkTree(path),
      home: homedir(),
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
   * Asks a folder's tracker for one change, in a folder already found, and
   * tells open tabs to reload when it worked.
   *
   * @param what Names the change in the log when it fails, e.g. "close".
   * @param publish Tell open tabs to reload afterwards. False when the
   *   caller makes several changes and publishes once at the end.
   * @returns `{ message: null }` on success, else the reason in plain words.
   *   Never throws.
   */
  async function applyIn(
    path: string,
    threadId: string | null,
    what: string,
    act: (tracker: Tracker) => Promise<void>,
    publish = true,
  ): Promise<Outcome> {
    const found = await trackerFor(path);
    if ("state" in found) return { message: found.message };
    try {
      await act(found.tracker);
    } catch (cause) {
      return { message: problem(path, cause, what).message };
    }
    if (publish) changed(threadId);
    return { message: null };
  }

  /**
   * The whole sequence for a simple change: check the ids, find the folder,
   * ask the tracker, report, publish.
   *
   * It does not check that the issues still exist: the tracker says so
   * itself, in words good enough to show.
   */
  async function change(
    input: FolderRef,
    ids: string[],
    what: string,
    act: (tracker: Tracker) => Promise<void>,
  ): Promise<Outcome> {
    const bad = ids.find((id) => !BEAD_ID_PATTERN.test(id));
    if (bad !== undefined) return { message: notAnId(bad) };
    const folder = await folderFor(input);
    if ("message" in folder) return { message: folder.message };
    return applyIn(folder.path, input.threadId, what, act);
  }

  /**
   * Creates one issue in the folder behind a thread or project.
   *
   * A new sub-issue takes its parent's category unless one is given, and
   * none of its parent's labels (so not its workflow step, its size or an
   * epic's branch: bead-bb-ty5.4); the tracker sees to both. This happens
   * once, at creation, and later changes to the parent do not follow.
   *
   * @returns `{ id }` of the new issue, or `{ message }` saying in plain words
   *   why it was not created. Never throws for expected problems.
   * Side effects: writes to the tracker; publishes CHANGED_CHANNEL on
   *   success.
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
    const found = await trackerFor(folder.path);
    if ("state" in found) return fail(found.message);
    try {
      const id = await found.tracker.create({
        title: input.title,
        description: input.description,
        type: input.type ?? undefined,
        priority: input.priority ?? undefined,
        parentId: input.parentId ?? undefined,
        category: input.category ?? undefined,
      });
      changed(input.threadId);
      return { id, message: null };
    } catch (cause) {
      // Published even so: the tracker may have created the issue and then
      // failed to say which one it is, and a reload shows whether it did.
      changed(input.threadId);
      return fail(problem(folder.path, cause, "create").message);
    }
  }

  /**
   * Closes or reopens one issue in the folder behind a thread or project.
   *
   * @param command "close" or "reopen".
   * @param publish Tell open tabs to reload afterwards. False when the
   *   caller is closing several issues and will publish once at the end.
   * @returns `{ message: null }` on success, else the reason in plain words.
   * Side effects: writes to the tracker; on close, clears the thread's
   *   current issue if it was this one.
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
    const done = await applyIn(
      folder.path,
      input.threadId,
      command,
      (tracker) =>
        command === "close"
          ? tracker.close(input.beadId)
          : tracker.reopen(input.beadId),
      false,
    );
    if (done.message !== null) return done;
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
   * The description arrives as the tab shows it: one text, which may hold
   * the requirements as a marked section (see server/issues.ts). It is
   * taken apart again here, so that each goes back where the tracker keeps
   * it and editing the text in the tab changes exactly what was edited.
   *
   * Side effects: up to three writes to the tracker, one for each of the
   *   fields, the description and the requirements that changed; publishes
   *   once. They are separate writes, so a failure may leave the earlier
   *   ones done: open tabs are then told to reload as well, so that what
   *   they show is what is there.
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
    return change(input, [beadId], "update", async (tracker) => {
      let written = false;
      try {
        if (type !== null || priority !== null || title !== null) {
          await tracker.edit(beadId, {
            type: type ?? undefined,
            priority: priority ?? undefined,
            title: title ?? undefined,
          });
          written = true;
        }
        if (description !== null) {
          const typed = splitRequirements(description);
          const held = await tracker.show(beadId);
          // Each part is written only when it differs, so the usual edit
          // is one write, and a text sent back unchanged is none.
          if (typed.description !== held.description) {
            await tracker.write(beadId, "description", typed.description);
            written = true;
          }
          if (typed.requirements !== held.requirements) {
            await tracker.write(beadId, "requirements", typed.requirements);
          }
        }
      } catch (cause) {
        if (written) changed(input.threadId);
        throw cause;
      }
    });
  }

  /**
   * Moves an issue inside another issue (parentId set) or out to the top
   * level (parentId null). The tracker refuses a move that would put an
   * issue inside itself or inside one of its own sub-issues: such an issue
   * would disappear from every view that walks the tree from the top.
   */
  async function setParent(
    input: FolderRef & { beadId: string; parentId: string | null },
  ): Promise<Outcome> {
    const { beadId, parentId } = input;
    return change(
      input,
      parentId === null ? [beadId] : [beadId, parentId],
      "move",
      (tracker) => tracker.move(beadId, parentId),
    );
  }

  /**
   * Sets or clears one issue's category. The tracker tidies the name (lower
   * case, single spaces) and refuses one it cannot keep.
   */
  async function setCategory(
    input: FolderRef & { beadId: string; category: string | null },
  ): Promise<Outcome> {
    return change(input, [input.beadId], "set category", (tracker) =>
      tracker.edit(input.beadId, { category: input.category }),
    );
  }

  /**
   * Makes an issue carry exactly one label with a given prefix (or none):
   * the way a workflow step, a size and an epic's branch are kept.
   *
   * Every label with the prefix is removed first, so an issue never ends up
   * with two, even if one was added by hand.
   *
   * @param value What follows the prefix; null removes the label.
   * @param publish Tell open tabs to reload afterwards.
   * Side effects: one read of the issue; one write when there is something
   *   to change.
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
    const found = await trackerFor(path);
    if ("state" in found) return { message: found.message };
    const wanted = value === null ? null : prefix + value;
    try {
      // The list this plugin returns has these labels taken out, so the
      // issue is read again here to know exactly which ones to remove.
      const present = (await found.tracker.show(beadId)).labels.filter(
        (label) => label.startsWith(prefix),
      );
      const removeLabels = present.filter((label) => label !== wanted);
      const addLabels =
        wanted !== null && !present.includes(wanted) ? [wanted] : [];
      // Nothing to change: nothing is written and no tab reloads.
      if (removeLabels.length === 0 && addLabels.length === 0) {
        return { message: null };
      }
      await found.tracker.edit(beadId, { addLabels, removeLabels });
    } catch (cause) {
      return { message: problem(path, cause, what).message };
    }
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
      "set step",
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
      "set size",
      publish,
    );
  }

  /**
   * Records the branch an epic's issues are worked on, or forgets it
   * (null).
   *
   * Pre-condition: the issue is known to be in the folder; `branch`, when
   *   given, has no comma in it (a label cannot hold one; git branch names
   *   made by this plugin and by BB have none).
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
      "set branch",
      publish,
    );
  }

  /**
   * Adds a comment to an issue. Used for the record of workflow moves, which
   * is where the tab already shows an issue's history.
   *
   * Side effects: one comment written. Nothing is published: callers
   *   publish once for the whole move.
   */
  function addComment(
    path: string,
    beadId: string,
    text: string,
  ): Promise<Outcome> {
    return applyIn(
      path,
      null,
      "comment",
      (tracker) => tracker.comment(beadId, text),
      false,
    );
  }

  /**
   * Adds a link of one of beads' kinds, recorded on `fromId` and pointing at
   * `toId` ("fromId is blocked by toId").
   *
   * The tab names the kinds as beads does; the one that differs from the
   * tracker's common names is "blocks", which the tracker calls
   * "blocked-by". Loops, duplicates and a link to itself are refused by the
   * tracker, whose message is passed on.
   */
  async function link(
    input: FolderRef & { fromId: string; toId: string; kind: LinkKind },
  ): Promise<Outcome> {
    const { fromId, toId, kind } = input;
    return change(input, [fromId, toId], "link", (tracker) =>
      tracker.link(fromId, toId, kind === "blocks" ? "blocked-by" : kind),
    );
  }

  /**
   * Removes the link recorded on `fromId` that points at `toId`.
   *
   * @param input.kind The link's kind as the tab lists it. A two-way link is
   *   recorded on both issues and shown once on each, so both halves go; of
   *   any other kind only the one recorded on `fromId` is removed, and a
   *   link the other way round, which the tab shows separately, stays.
   */
  async function unlink(
    input: FolderRef & { fromId: string; toId: string; kind: string },
  ): Promise<Outcome> {
    const { fromId, toId, kind } = input;
    return change(input, [fromId, toId], "unlink", (tracker) =>
      tracker.unlink(fromId, toId, kind !== RELATES_TO),
    );
  }

  /**
   * Reads the comments of one issue, oldest first.
   *
   * @returns `{ comments, message: null }`, or an empty list with the reason
   *   in plain words. Never throws for expected problems.
   * Side effects: reads the tracker; nothing is written.
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
    const found = await trackerFor(folder.path);
    if ("state" in found) return fail(found.message);
    try {
      return {
        comments: await found.tracker.comments(input.beadId),
        message: null,
      };
    } catch (cause) {
      return fail(problem(folder.path, cause).message);
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
