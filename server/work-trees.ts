// server/work-trees.ts — conversations opened for one issue in a work tree.
//
// What: opens a new top-level conversation for an issue in a work tree that
// BB makes, remembers that it did, and closes everything up when the issue
// has landed: archives the conversation, has BB remove the work tree, and
// deletes the branch.
//
// Why: the user wants several issues worked at once, each in its own work
// tree and its own conversation (bead-bb-ak0). Of three ways to leave
// things after a landing they chose the one that closes everything: "I'm
// choosing option A. Let's close it. If you want to keep chatting, you
// need to open a separate chat manually."
//
// Design notes (what trying it showed, see the issue's comments):
// - A work tree asked for with the main branch as its base is cut from the
//   LOCAL main branch. BB names the tree's branch itself, from the
//   conversation's title and id; that name is kept.
// - BB refuses to remove a work tree while its conversation is in the
//   sidebar, stopped or not. It removes it once the conversation is
//   archived (which leaves it readable). So the order is fixed: wait for
//   the agent's last turn to end, archive, ask for the removal.
// - BB leaves the local branch behind, and the agent cannot delete it:
//   git will not delete a branch a work tree still holds, and the tree
//   only goes after the agent's conversation is archived. So this file
//   deletes it, once the tree is gone, and only after git confirms that
//   every commit on it is on the main branch (see deleteMergedBranch). It is the one place where
//   the plugin itself changes git; the user was told so with their choice.
// - Which conversations are the plugin's own is kept in its storage, so a
//   reload in the middle of an issue does not lose it.
//
// - A conversation can also be opened for an epic (bead-bb-ty5.2): all of
//   its issues are then worked there, one at a time. Nothing differs here
//   except that the epic's id is what is remembered, so the closing up
//   happens when the epic itself lands, not when one of its issues does;
//   `branchOf` lets the caller record the tree's branch on the epic.
//
// - The new conversation gets the Airbender tab among its side tabs (the
//   user: "In the new chat, I want [the Airbender] tab to be open"): BB
//   keeps each conversation's tabs and lets a plugin write them. Whether
//   BB then shows the panel open on it is up to the app; the tab also asks
//   BB to open it after the jump (app/panel.tsx).
//
// Gotchas:
// - Closing up happens after the answer to the agent has gone back, and
//   takes a while; a failure in it is logged and leaves things in place
//   (a conversation, a folder or a merged branch), never half-removed work.

import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** What is remembered about one conversation the plugin opened. */
interface Opened {
  /** The issue it was opened for. */
  beadId: string;
  /** The repository's main folder: where its branch is deleted from afterwards. */
  home: string;
}

/** The id of the tab's panel, as registered in app.tsx, and its label. */
const PANEL_ACTION = "issues";
const PANEL_TITLE = "Airbender";

/** The two tabs BB gives every conversation, as it stores them. */
const DEFAULT_TABS = [
  { id: "thread-info:thread-info:none", kind: "thread-info" },
  { id: "git-diff:git-diff:none", kind: "git-diff" },
] as const;

/** Storage key for the conversations opened, kept across reloads. */
const OPENED_KEY = "workTreeThreads";

/** Longest the agent's last turn is waited for before closing up anyway. */
const LAST_TURN_MS = 10 * 60_000;

/** How often, and how long, the work tree's removal is waited for. */
const REMOVAL_POLL_MS = 3_000;
const REMOVAL_TRIES = 40;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Builds the work tree conversations for this plugin instance.
 *
 * @param mainBranch The name of a folder's main branch, or null when it
 *   cannot be told (server/folder.ts).
 * @param mainFolder The repository's main folder for any of its folders.
 * @param deleteMergedBranch Deletes a fully merged local branch in a
 *   folder; resolves to why it could not, or null (server/folder.ts).
 * @returns `open`, `isOurs` and `landed`.
 * Side effects: one read of the plugin's storage now.
 */
export async function createWorkTrees({
  bb,
  mainBranch,
  mainFolder,
  deleteMergedBranch,
}: {
  bb: BbPluginApi;
  mainBranch: (path: string) => Promise<string | null>;
  mainFolder: (path: string) => Promise<string | null>;
  deleteMergedBranch: (path: string, branch: string) => Promise<string | null>;
}) {
  /** Conversation id -> what it was opened for. */
  const opened = new Map<string, Opened>();
  const saved = await bb.storage.kv.get<unknown>(OPENED_KEY).catch(() => undefined);
  if (typeof saved === "object" && saved !== null) {
    for (const [threadId, entry] of Object.entries(saved)) {
      const { beadId, home } = (entry ?? {}) as Partial<Opened>;
      if (typeof beadId === "string" && typeof home === "string") {
        opened.set(threadId, { beadId, home });
      }
    }
  }
  const save = () =>
    bb.storage.kv
      .set(OPENED_KEY, Object.fromEntries(opened))
      .catch((cause) => bb.log.warn("could not save work tree conversations: " + cause));

  /**
   * Opens a conversation for an issue in a fresh work tree and starts its
   * agent with `prompt`.
   *
   * @param from The conversation or project the request came from: which
   *   project the new conversation belongs to.
   * @param home The folder the request came from.
   * @returns The new conversation's id, or why it could not be opened; in
   *   that case nothing was created.
   */
  async function open({
    from,
    home,
    beadId,
    title,
    prompt,
  }: {
    from: { threadId: string | null; projectId: string | null };
    home: string;
    beadId: string;
    title: string;
    prompt: string;
  }): Promise<{ threadId: string } | { message: string }> {
    try {
      let projectId = from.projectId;
      // BB wants to be told which machine the work tree is made on: the
      // one the asking conversation's folder is on, or, from the
      // new-thread screen, the one the project's default folder is on.
      let hostId: string | null = null;
      if (from.threadId !== null) {
        const asking = await bb.sdk.threads.get({ threadId: from.threadId });
        projectId = asking.projectId;
        if (asking.environmentId !== null) {
          hostId = (
            await bb.sdk.environments.get({ environmentId: asking.environmentId })
          ).hostId;
        }
      }
      if (projectId === null) return { message: "Pick a project first." };
      if (hostId === null) {
        const project = await bb.sdk.projects.get({ projectId });
        hostId =
          project.sources.find((source) => source.isDefault)?.hostId ?? null;
      }
      if (hostId === null) {
        return { message: "The machine this project's folder is on could not be found." };
      }
      // Cut from the local main branch, not the remote's: commits that
      // have not been pushed yet belong in the new work tree too.
      const base = await mainBranch(home);
      if (base === null) {
        return {
          message:
            "This folder's main branch could not be found, so there is nothing to cut a work tree from.",
        };
      }
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: {
          type: "host",
          hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "named", name: base },
          },
        },
        // BB names the work tree's branch after this title.
        title: `${beadId}: ${title}`.slice(0, 120),
        prompt,
      });
      // The branch is deleted later from the repository's main folder, not
      // from the folder that asked: that one may itself be a work tree,
      // and gone by then.
      opened.set(thread.id, { beadId, home: (await mainFolder(home)) ?? home });
      void save();
      await addTab(thread.id);
      return { threadId: thread.id };
    } catch (cause) {
      return {
        message: `A conversation in a work tree could not be opened: ${reason(cause)}`,
      };
    }
  }

  /**
   * Puts the Airbender tab among a conversation's side tabs, after the
   * ones it has. A failure only costs the tab being there already: the
   * user can open it by hand, so it is logged and nothing else.
   */
  async function addTab(threadId: string): Promise<void> {
    try {
      const { revision, tabs } = await bb.sdk.threads.tabs.get({ threadId });
      const id = `plugin-panel:${encodeURIComponent(`${bb.pluginId}:${PANEL_ACTION}:`)}:none`;
      if (tabs.some((tab) => tab.id === id)) return;
      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: revision,
        tabs: [
          // A conversation nobody has opened yet has no tabs stored, and BB
          // only fills in its own two (Info and Diff) while that is so.
          // Writing ours alone would leave the conversation without them.
          ...(tabs.length === 0 ? DEFAULT_TABS : tabs),
          {
            kind: "plugin-panel",
            id,
            pluginId: bb.pluginId,
            actionId: PANEL_ACTION,
            title: PANEL_TITLE,
            paramsJson: null,
          },
        ],
      });
    } catch (cause) {
      bb.log.warn(`the Airbender tab could not be added to ${threadId}: ${reason(cause)}`);
    }
  }

  /**
   * The branch of a work tree conversation, which BB names itself. Asked
   * for right after the conversation is opened, when the tree may not be
   * there yet, so it is tried for a while.
   *
   * @returns The branch, or null when BB did not name one in time.
   * Side effects: read requests to BB, up to about a minute.
   */
  async function branchOf(threadId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const { environmentId } = await bb.sdk.threads.get({ threadId });
        if (environmentId !== null) {
          const branch =
            (await bb.sdk.environments.get({ environmentId })).branchName ?? null;
          if (branch !== null && branch !== "") return branch;
        }
      } catch (cause) {
        bb.log.warn(`work tree branch of ${threadId} not read yet: ${reason(cause)}`);
      }
      await pause(REMOVAL_POLL_MS);
    }
    return null;
  }

  /**
   * The conversation the plugin opened for an issue in a work tree, and
   * has not closed up since; null when there is none.
   */
  function threadFor(beadId: string): string | null {
    for (const [threadId, entry] of opened) {
      if (entry.beadId === beadId) return threadId;
    }
    return null;
  }

  /** Whether a conversation is one the plugin opened in a work tree. */
  function isOurs(threadId: string | null): boolean {
    return threadId !== null && opened.has(threadId);
  }

  /**
   * The issue a work tree conversation was opened for has been closed from
   * that conversation: close everything up, in the background.
   *
   * Does nothing for a conversation the plugin did not open, or one opened
   * for another issue. Returns at once; never throws.
   */
  function landed(threadId: string, beadId: string): void {
    const entry = opened.get(threadId);
    if (entry === undefined || entry.beadId !== beadId) return;
    void closeUp(threadId, entry).catch((cause) =>
      bb.log.warn(`closing up work tree conversation ${threadId} failed: ${reason(cause)}`),
    );
  }

  /** Archives the conversation, has the work tree removed, deletes the branch. */
  async function closeUp(threadId: string, entry: Opened): Promise<void> {
    // The agent is still in the turn that reported the last step: let it
    // finish what it is saying to the user.
    await bb.sdk.threads
      .wait({ threadId, status: "idle", timeoutMs: LAST_TURN_MS })
      .catch((cause) => bb.log.warn("work tree last turn wait ended: " + cause));
    const thread = await bb.sdk.threads.get({ threadId });
    const environmentId = thread.environmentId;
    let branch: string | null = null;
    if (environmentId !== null) {
      branch = (await bb.sdk.environments.get({ environmentId })).branchName ?? null;
    }
    await bb.sdk.threads.archive({ threadId });
    opened.delete(threadId);
    void save();
    if (environmentId === null) return;
    // BB may need a moment after archiving before it lets the tree go.
    let asked = false;
    for (let attempt = 0; attempt < 5 && !asked; attempt += 1) {
      try {
        await bb.sdk.environments.delete({ environmentId });
        asked = true;
      } catch (cause) {
        if (attempt === 4) {
          bb.log.warn(`work tree of ${threadId} could not be removed: ${reason(cause)}`);
          return;
        }
        await pause(REMOVAL_POLL_MS);
      }
    }
    if (branch === null) return;
    // git will not delete the branch until the work tree that holds it is
    // gone; try until it does, or give up and leave a merged branch behind.
    let problem: string | null = "the work tree was not removed in time";
    for (let attempt = 0; attempt < REMOVAL_TRIES; attempt += 1) {
      await pause(REMOVAL_POLL_MS);
      problem = await deleteMergedBranch(entry.home, branch);
      if (problem === null) return;
    }
    bb.log.warn(`branch ${branch} was left in ${entry.home}: ${problem}`);
  }

  return { open, branchOf, threadFor, isOurs, landed };
}

/** What the rest of the server asks of the work tree conversations. */
export type WorkTrees = Awaited<ReturnType<typeof createWorkTrees>>;
