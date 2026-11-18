// server/work-trees.ts — conversations opened for one issue in a work tree.
//
// Opens a new top-level conversation in a BB-managed work tree and remembers
// which issue it belongs to. PR delivery and issue closure never archive a
// conversation, remove a work tree or delete a branch. Those destructive
// cleanup choices remain explicitly under the user's control.
//
// Design notes (what trying it showed, see the issue's comments):
// - A work tree asked for with the main branch as its base is cut from the
//   LOCAL main branch. BB names the tree's branch itself, from the
//   conversation's title and id; that name is kept.
// - Archiving a conversation can let BB remove its work tree. Neither action
//   is safe as a side effect of a workflow report: an opened or queued PR
//   may still be pending, and a merged PR may use squash/rebase rather than
//   preserve local ancestry. This module never requests either action.
// - Which conversations are the plugin's own is kept in its storage, so a
//   reload in the middle of an issue does not lose it.
//
// - A conversation can also hold an epic: its issues are worked there one
//   at a time; `branchOf` lets the caller record BB's branch on the epic.
//
// - The new conversation gets the Airbender tab among its side tabs (the
//   user: "In the new chat, I want [the Airbender] tab to be open"): BB
//   keeps each conversation's tabs and lets a plugin write them. Whether
//   BB then shows the panel open on it is up to the app; the tab also asks
//   BB to open it after the jump (app/panel.tsx).
//
// - A reload retains ownership records, including after delivery, so the
//   conversation and its source remain discoverable until user cleanup.

import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** What is remembered about one conversation the plugin opened. */
interface Opened {
  /** The issue it was opened for. */
  beadId: string;
  /** The repository's canonical main folder, retained as provenance. */
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

/** How often the newly created work tree's branch is checked. */
const BRANCH_POLL_MS = 3_000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Builds the work tree conversations for this plugin instance.
 *
 * @param mainBranch The name of a folder's main branch, or null when it
 *   cannot be told (server/folder.ts).
 * @param mainFolder The repository's main folder for any of its folders.
 * @returns `open`, `branchOf`, `threadFor` and `isOurs`; no cleanup API.
 * Side effects: one read of the plugin's storage now.
 */
export async function createWorkTrees({
  bb,
  mainBranch,
  mainFolder,
}: {
  bb: BbPluginApi;
  mainBranch: (path: string) => Promise<string | null>;
  mainFolder: (path: string) => Promise<string | null>;
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
      // Retain canonical repository provenance even if the asking folder
      // was itself a work tree.
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
      await pause(BRANCH_POLL_MS);
    }
    return null;
  }

  /**
   * The newest conversation opened for an issue. Older worktrees remain
   * in the ownership history, but reopened work must not navigate to them.
   */
  function threadFor(beadId: string): string | null {
    let latest: string | null = null;
    for (const [threadId, entry] of opened) {
      if (entry.beadId === beadId) latest = threadId;
    }
    return latest;
  }

  /** Whether a conversation is one the plugin opened in a work tree. */
  function isOurs(threadId: string | null): boolean {
    return threadId !== null && opened.has(threadId);
  }

  return { open, branchOf, threadFor, isOurs };
}

/** What the rest of the server asks of the work tree conversations. */
export type WorkTrees = Awaited<ReturnType<typeof createWorkTrees>>;
