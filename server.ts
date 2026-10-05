// bb-plugin-airbender — backend entry.
//
// Where things are: this file reads the settings, wires the pieces together
// and holds the table of request handlers and the agent tool. The pieces are
// in server/: contract.ts (the typed contract with the frontend), folder.ts
// (finding the folder and running bd in it), current-bead.ts (which issue a
// thread is working on), store.ts (listing and changing issues), work.ts
// (play, and close with a commit), issues.ts (turning beads' rows into
// issues), bd.ts (running programs), watch.ts (noticing changes made outside
// the plugin), setup.ts (getting a folder ready), define.ts (the Define
// worker) and prompts.ts (the
// wording sent to agents). The notes below describe the backend as a whole.
//
// What: the data behind the Beads tab. Lists the beads issues of the folder a
// thread (or project) works in, creates new ones, and remembers which issue
// each thread is working on — all by running the `bd` command-line tool.
//
// Why: beads keeps a repo's issues in a database inside the repo, and the only
// supported way to read it is the `bd` tool. The browser cannot run a program,
// so the tab asks this backend over RPC.
//
// Design notes:
// - Reading runs `bd --readonly`. The writes to the issue database are
//   creating (`bd create`), closing (`bd close`), reopening (`bd reopen`)
//   and changing an issue's type, priority, title, description, parent or
//   category (`bd update`); nothing here deletes an issue or edits its design,
//   acceptance criteria, notes or comments.
// - "Define" runs as a background agent: a hidden worker thread that is
//   not shown in the sidebar and is archived and stopped when it finishes,
//   so the thread the user is working in is not interrupted (bead-bb-4la).
// - The play button asks the thread's agent to clarify requirements, then
//   agree an implementation plan, then build; the agent may skip either of
//   the first two when it is obvious, and must say so (bead-bb-avf).
// - The plugin speaks to the current thread's agent in two places, both by
//   sending the thread a message: the play button ("work on this issue") and, when the user
//   picks it, closing an issue ("commit this issue's work"). The plugin never
//   runs git itself.
// - "Current bead" is BB's knowledge, not beads': which issue a given thread
//   is working on. It is stored on the thread (BB's per-plugin thread
//   metadata), set either by the user in the tab or by the thread's agent
//   through the `beads_set_current` tool. Beads itself is not changed by it.
// - One `bd list --all` per request. "Blocked" is worked out here from each
//   issue's dependency list instead of a second `bd blocked` call, so the tab
//   always shows one consistent snapshot.
// - `bd` runs on the machine the BB server runs on. A thread whose folder is
//   on another enrolled machine gets an explicit "unavailable" answer instead
//   of a wrong list (tracked as bead-bb-hl3).
// - Problems the user can act on (no beads here, bd not installed, folder on
//   another machine) are returned as data with a `state`, not thrown, so the
//   tab can explain them in plain words.
//
// - Changes made outside the plugin (an agent or a terminal running bd) reach
//   open tabs through a file watcher, not a timer: bd rewrites
//   `.beads/last-touched` on every write, and this backend watches that one
//   file in each folder a tab has listed, then signals the tabs to reload.
//   The plugin's own reads (`bd --readonly list` / `comments`) do not touch
//   that file, so a reload never triggers another reload.
//
// - Issues can sit inside other issues, to any depth. beads stores one
//   `parent` per issue; this backend passes it through as `parentId` and the
//   tab builds the tree. Play on an issue with sub-issues asks the agent to
//   work on all of them, and "Close & commit" on it closes all of them
//   (bead-bb-5qt).
//
// Gotchas:
// - `bd delete` does not rewrite `.beads/last-touched`, so an issue deleted
//   outside the plugin stays on screen until the next refresh.
// - `bd show` also rewrites `.beads/last-touched`, so an agent merely reading
//   an issue causes one harmless reload of open tabs.
// - The BB server may have a shorter PATH than your shell. If `bd` is not
//   found by name, a few common install locations are tried; the "bd command"
//   setting overrides all of that.
// - Settings are read once per load: reload the plugin after changing one.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { rpcContract } from "./server/contract.ts";
import { createCurrentBead } from "./server/current-bead.ts";
import { createDefine } from "./server/define.ts";
import { createFolders } from "./server/folder.ts";
import { createSetup } from "./server/setup.ts";
import { createStore } from "./server/store.ts";
import { createWatcher } from "./server/watch.ts";
import { createWork } from "./server/work.ts";
import {
  BEAD_ID_PATTERN,
  CLOSED_STATUS,
  QUICK_REPLIES,
} from "./shared/constants.ts";

/**
 * The plugin's backend entry point: reads the settings, builds the pieces
 * (watcher, store, setup, Define) and registers the request handlers, the
 * agent tool and the standing instructions for agents.
 *
 * Side effects: registers with BB; restores file watches from before the
 * last reload.
 */
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    bdCommand: {
      type: "string",
      label: "bd command",
      description:
        "Name or full path of the beads command-line tool. Leave as bd unless BB cannot find it.",
      default: "bd",
    },
    defineModel: {
      type: "string",
      label: "Define model",
      description:
        "Model the background agent uses when you press Define, as a model id such as claude-fable-5-1. Leave empty to use the project's default model.",
      default: "claude-fable-5-1",
    },
  });
  const { bdCommand, defineModel } = await settings.get();

  // Tried in order until one exists. The extra locations cover installs that
  // are on a login shell's PATH but not on the BB server's.
  const bdCandidates = [
    bdCommand.trim() || "bd",
    join(homedir(), ".local", "share", "mise", "shims", "bd"),
    join(homedir(), ".local", "bin", "bd"),
    join(homedir(), "go", "bin", "bd"),
    "/usr/local/bin/bd",
    "/opt/homebrew/bin/bd",
  ];

  // The pieces, built in dependency order: folders and the thread's current
  // issue first, the watcher, the store of issue operations on top of those,
  // then work (play, close and commit), setup and Define on top of the store.
  const folders = createFolders({ bb, bdCandidates });
  const currentBead = createCurrentBead(bb);
  const { watchFolder } = await createWatcher(bb);
  const store = createStore({ bb, folders, currentBead, watchFolder });
  const work = createWork({ bb, store, currentBead });
  const { setupStatus, runSetup } = createSetup({ bb, folders, store });
  const { startDefine } = createDefine({ bb, store, defineModel });

  // Every handler is one call into a module: what each does, and how it
  // reports a problem, is documented where it is written. All of them
  // answer with data (a state or a message in plain words) and none throws
  // for an expected problem, so the tab has one way to show a failure.
  bb.rpc.register(rpcContract, {
    issues_list: (input) => store.listIssues(input),
    issue_comments: (input) => store.listComments(input),
    issue_create: (input) => store.createIssue(input),
    issue_close: (input) => work.closeIssue(input),
    issue_reopen: (input) => store.setIssueOpen("reopen", input),
    issue_update: (input) => store.updateIssue(input),
    issue_set_parent: (input) => store.setParent(input),
    issue_set_category: (input) => store.setCategory(input),
    issue_link: (input) => store.link(input),
    issue_unlink: (input) => store.unlink(input),
    issue_define: (input) => startDefine(input),
    current_start: (input) => work.startWork(input),
    current_set: (input) => work.setCurrent(input),
    setup_status: (input) => setupStatus(input),
    setup_run: (input) => runSetup(input),
    // Sent from the server, like the play message, rather than through the
    // message box: that way whatever the user has typed there is left alone.
    thread_reply: async ({ threadId, kind }) => {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", mentions: [], text: QUICK_REPLIES[kind] }],
      });
      return { sent: true as const };
    },
  });

  // The agent's way to say which issue its thread is working on. A native
  // tool rather than a `bb` command because agent sandboxes on Linux can block
  // the local connection a `bb` command needs, which would turn every update
  // into a permission prompt.
  bb.agents.registerTool({
    name: "beads_set_current",
    description:
      "Tell BB which beads issue this thread is working on, so the user sees it highlighted in the Airbender tab. Pass an empty id to clear it.",
    instructions:
      "This repository tracks work in beads. When you start working on a beads issue, or switch to another one, call beads_set_current with its id so the user can see what this thread is working on. Call it with an empty id when the thread is no longer working on any issue. It does not change the issue itself: still claim issues with bd. Do not close an issue when you finish it; the user validates the work and closes it.",
    presentation: {
      label: { pending: "Setting current bead", completed: "Set current bead" },
    },
    parameters: z.object({
      id: z
        .string()
        .describe("Beads issue id, e.g. proj-a1b. Empty string clears it."),
    }),
    async execute({ id }, { threadId }) {
      const beadId = id.trim();
      if (beadId === "") {
        await currentBead.write(threadId, null);
        return "Cleared this thread's current bead.";
      }
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return {
          content: [{ type: "text", text: `"${beadId}" is not a beads issue id.` }],
          isError: true,
        };
      }
      // Reject ids that do not exist, so a typo is reported to the agent
      // instead of showing the user a highlight that points nowhere.
      const listed = await store.listIssues({ threadId, projectId: null });
      const target = listed.issues.find((issue) => issue.id === beadId);
      if (target?.status === CLOSED_STATUS) {
        return {
          content: [
            {
              type: "text",
              text: `${beadId} is closed, so it cannot be this thread's current bead. Reopen it first if work on it continues.`,
            },
          ],
          isError: true,
        };
      }
      if (listed.state === "ok" && target === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `No beads issue with id ${beadId} in ${listed.path}. Run bd list to see ids.`,
            },
          ],
          isError: true,
        };
      }
      await currentBead.write(threadId, beadId);
      return `This thread's current bead is now ${beadId}.`;
    },
  });

  // Offer the tool only to threads whose folder uses beads, so threads in
  // other repositories get no extra tool or instructions. The callback must be
  // synchronous, hence the direct look for a .beads folder; a thread on
  // another machine simply does not get the tool.
  bb.agents.configure((context) => {
    const path = context.environment.path;
    const usesBeads = path !== null && existsSync(join(path, ".beads"));
    return { tools: usesBeads ? ["beads_set_current"] : [], skills: [] };
  });
}
