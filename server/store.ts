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
// - Issues are read and changed only by running the bend program
//   (server/bend.ts), the one agents use too, so there is one code path to
//   the tracker (bead-bb-c9l.4). No bd command is written in this file;
//   bend's beads adapter holds them all.
// - Expected problems are returned as data (a state, or a message in plain
//   words), never thrown, so the tab can show them. The tracker throws;
//   server/bend.ts turns that into data.
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
  LINK_KINDS,
} from "../shared/constants.ts";
import type { IssueType, LinkKind } from "../shared/constants.ts";
import type { Tracker, Trackers, Watched } from "./bend.ts";
import type { Issue, IssueComment, IssuesResult, RefusedChange } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Folders } from "./folder.ts";
import {
  BRANCH_KEY,
  BRANCH_PREFIX,
  RELATES_TO,
  SIZE_PREFIX,
  STEP_PREFIX,
  pickerKinds,
  toIssues,
  trackerKind,
} from "./issues.ts";
import { DEFAULT_WORKFLOW_ID } from "../shared/workflows.ts";
import { repositoryKey } from "./workflow-choice.ts";
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
  | { state: "no-bd" | "no-bend" | "no-beads" | "no-login" | "error"; message: string };

/** The sentence for an id that cannot be an issue id. */
const notAnId = (id: string) => `"${id}" is not an issue id.`;

/** The sentence for an issue that has disappeared since the tab loaded. */
const notInList = (id: string) => `Issue ${id} is no longer in the list.`;

/**
 * Builds the issue operations for this plugin instance.
 *
 * @param folders Finding folders and reading git in them (server/folder.ts).
 * @param trackers The tracker for each folder (server/bend.ts).
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
  watchFolder: (path: string, watched?: Watched) => void;
  workflowChoice: WorkflowChoice;
}) {
  const { folderFor, onOwnBranch, currentBranch, isWorkTree } = folders;
  const { trackerFor, problem } = trackers;

  /** Tells every open tab to reload. */
  const changed = (threadId: string | null) =>
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });

  // bend keeps a copy of the issues and answers from it (bead-bb-c9l.14),
  // so nothing is kept here. Two small things remain: a folder whose issues
  // were changed by something bend cannot know of is noted, so that the
  // next read has bend reread its copy; and requests for the same folder
  // that arrive together share one run of bend.
  /**
   * Repositories whose next read must have bend reread its copy. By
   * repository, not by folder: the work trees of one repository share one
   * copy and one set of issues.
   */
  const behind = new Set<string>();
  /** The read under way for a folder; see readIssues for its key. */
  const reading = new Map<string, Promise<IssuesRead>>();
  /**
   * How many times each repository's issues were changed from here. A read
   * that began before a change must not be handed to a request made after
   * it.
   */
  const changes = new Map<string, number>();

  /** Notes that a repository's issues were, or are about to be, changed. */
  function touched(path: string): void {
    const key = repositoryKey(path);
    changes.set(key, (changes.get(key) ?? 0) + 1);
  }

  /**
   * The folder's issues may have changed by something the plugin did
   * without bend (a sync, a setup step, the sync with GitHub): the next
   * read has bend reread its copy.
   */
  function stale(path: string): void {
    behind.add(repositoryKey(path));
    touched(path);
  }

  /**
   * Reads every issue of a folder. A plain read: nothing is watched or
   * published.
   *
   * Pre-condition: the folder exists (see folders.folderFor).
   * @param fresh Have bend reread its copy from the tracker first: the
   *   owner asked (refresh), or came back to the window.
   * @returns The issues, or which of the expected problems occurred.
   * Side effects: one run of bend, shared with any other request for the
   *   same folder that arrives while it runs.
   */
  function readIssues(path: string, fresh = false): Promise<IssuesRead> {
    const repository = repositoryKey(path);
    const anew = fresh || behind.has(repository);
    // Shared only between requests for the same folder, of the same kind,
    // made with no change from here in between.
    const key = `${path}\n${anew}\n${changes.get(repository) ?? 0}`;
    const under = reading.get(key);
    if (under !== undefined) return under;
    behind.delete(repository);
    const read = readFresh(path, anew)
      .then((result) => {
        // Not reread after all: the mark stands for the next read.
        if (anew && !fresh && result.state !== "ok") behind.add(repository);
        return result;
      })
      .finally(() => reading.delete(key));
    reading.set(key, read);
    return read;
  }

  /** The read itself: one read of the folder's tracker. */
  async function readFresh(path: string, anew: boolean): Promise<IssuesRead> {
    const found = await trackerFor(path);
    if ("state" in found) return found;
    try {
      // Every issue: the closed ones are shown too. Where changes are
      // queued (a hosted tracker) bend's copy is never reread for a list:
      // there a reread is a whole sync over the network, which the sync
      // service runs in its own time, and which would make the list fail
      // with the network off. The copy already holds every change made
      // through bend.
      const queued = trackers.aboutOf(path)?.queued === true;
      const issues = await found.tracker.list(anew && !queued);
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
  async function listIssues(
    input: FolderRef & { fresh?: boolean },
  ): Promise<IssuesResult> {
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
      tracker: null,
      trackerRepository: null,
      linkKinds: [],
      queued: false,
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
    const read = await readIssues(path, input.fresh === true);
    if (read.state !== "ok") {
      return { state: read.state, path, message: read.message, ...empty };
    }
    watchFolder(path, trackers.watchOf(path));
    const about = trackers.aboutOf(path);
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
      // Known once the list was read: what the folder's tracker is, for
      // the tab to say and to offer only what that tracker has.
      tracker: about?.tracker ?? null,
      trackerRepository: about?.repository ?? null,
      linkKinds: pickerKinds(about?.linkKinds ?? [], LINK_KINDS),
      queued: about?.queued ?? false,
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
      try {
        await act(found.tracker);
      } finally {
        touched(path);
      }
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
      touched(folder.path);
      changed(input.threadId);
      return { id, message: null };
    } catch (cause) {
      // Published even so: the tracker may have created the issue and then
      // failed to say which one it is, and a reload shows whether it did.
      touched(folder.path);
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
          // One text holding the description and the requirements. bend
          // writes only the half that differs, so the usual edit is one
          // write, and a text sent back unchanged is none.
          // Counted as written before it is known: bend may write the
          // description and then fail on the requirements, and a reload
          // that shows nothing new costs little.
          written = true;
          await tracker.writeBody(beadId, description);
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
      try {
        await found.tracker.edit(beadId, { addLabels, removeLabels });
      } finally {
        touched(path);
      }
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
   * Kept in the issue's metadata, and a label from the time it was kept
   * in one is removed on the way (see BRANCH_KEY in issues.ts).
   *
   * Pre-condition: the issue is known to be in the folder.
   * Side effects: one write of the metadata, and the read and possible
   *   write of the labels that removing an old label takes.
   */
  async function setBranch(
    path: string,
    threadId: string | null,
    beadId: string,
    branch: string | null,
    publish = true,
  ): Promise<Outcome> {
    const kept = await applyIn(
      path,
      threadId,
      "set branch",
      (tracker) => tracker.edit(beadId, { metadata: { [BRANCH_KEY]: branch } }),
      false,
    );
    if (kept.message !== null) return kept;
    // The old label, where there still is one: gone either way. Not
    // published by that step: once, here, for the whole change.
    const outcome = await setPrefixedLabel(
      path,
      threadId,
      beadId,
      BRANCH_PREFIX,
      null,
      "remove branch label",
      false,
    );
    if (outcome.message === null && publish) changed(threadId);
    return outcome;
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
      // The kind is named, in the tracker's word for it: a tracker may
      // hold two links between the same two issues (GitHub: a "blocked by"
      // and one kept in the text), and only the one shown is to go.
      tracker.unlink(fromId, toId, kind !== RELATES_TO, trackerKind(kind)),
    );
  }

  /**
   * Which program an agent in a folder is told to read and write issues
   * with: beads' own (`bd`) where the issues are in beads, as agents there
   * always were, and `bend` on any other tracker (bead-bb-c9l.6). A folder
   * whose tracker is not known yet counts as beads.
   */
  const commandsIn = (path: string): "bd" | "bend" => {
    const tracker = trackers.aboutOf(path)?.tracker;
    return tracker === undefined || tracker === "beads" ? "bd" : "bend";
  };

  /**
   * The changes a folder's tracker refused for good, oldest first.
   *
   * @returns An empty list where changes are written straight through
   *   (beads), and when they cannot be read: the list is an extra, and a
   *   failure to read it must not take the sync's state with it.
   * Side effects: one run of bend, which reads its own files only.
   */
  async function refusedIn(path: string): Promise<RefusedChange[]> {
    const found = await trackerFor(path);
    if ("state" in found || trackers.aboutOf(path)?.queued !== true) return [];
    try {
      return await found.tracker.refused();
    } catch {
      return [];
    }
  }

  /**
   * Takes a refused change off the list, or puts it back to be sent again.
   *
   * @param input.again True to send it once more; false to dismiss it.
   * Side effects: bend's list of refused changes, and its queue when sent
   *   again; open tabs are told to reload.
   */
  async function settleRefused(
    input: FolderRef & { seq: number; again: boolean },
  ): Promise<Outcome> {
    const folder = await folderFor(input);
    if ("message" in folder) return { message: folder.message };
    return applyIn(folder.path, input.threadId, "settling a refused change", (tracker) =>
      tracker.settleRefused(input.seq, input.again),
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

  /**
   * The texts of an issue's comments, in a folder already found; null when
   * they cannot be read. For the comment copying of the GitHub sync, which
   * only compares texts.
   *
   * Side effects: one read of the folder's tracker.
   */
  async function commentTextsIn(
    path: string,
    beadId: string,
  ): Promise<string[] | null> {
    const found = await trackerFor(path);
    if ("state" in found) return null;
    try {
      return (await found.tracker.comments(beadId)).map((comment) => comment.text);
    } catch {
      return null;
    }
  }

  /**
   * Adds a comment under another person's name, in a folder already found
   * (the tracker takes a comment's author from who acts). For the comment
   * copying of the GitHub sync.
   *
   * @returns Null when it was added; otherwise why not.
   * Side effects: writes to the tracker. No tab
   *   is told to reload: the caller does that once at its end.
   */
  async function commentAsIn(
    path: string,
    beadId: string,
    author: string,
    text: string,
  ): Promise<string | null> {
    const outcome = await applyIn(
      path,
      null,
      "comment",
      (tracker) => tracker.comment(beadId, text, author),
      false,
    );
    return outcome.message;
  }

  return {
    readIssues,
    commentTextsIn,
    commentAsIn,
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
    refusedIn,
    settleRefused,
    commandsIn,
    addComment,
    changed,
    stale,
  };
}

/** What createStore returns; handed to the modules built on top of it. */
export type Store = ReturnType<typeof createStore>;
