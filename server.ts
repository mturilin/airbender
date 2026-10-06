// bb-plugin-airbender — backend entry.
//
// Where things are: this file reads the settings, wires the pieces together
// and holds the table of request handlers and the agent tool. The pieces are
// in server/: contract.ts (the typed contract with the frontend), folder.ts
// (finding the folder and running bd in it), current-bead.ts (which issue a
// thread is working on), store.ts (listing and changing issues), work.ts
// (moving an issue through its workflow), issues.ts (turning beads' rows
// into issues), bd.ts (running programs), watch.ts (noticing changes made
// outside the plugin), setup.ts (getting a folder ready) and prompts.ts
// (Airbender's rules for agents). The workflow itself, its steps and the
// wording for each, is in shared/standard-workflow.ts. The notes below describe the backend as a whole.
//
// What: the data behind the Airbender tab. Lists the beads issues of the
// folder a thread (or project) works in, creates and changes them, remembers
// which issue each thread is working on, and gets a folder ready for beads —
// nearly all of it by running the `bd` command-line tool.
//
// Why: beads keeps a repo's issues in a database inside the repo, and the only
// supported way to read it is the `bd` tool. The browser cannot run a program,
// so the tab asks this backend over RPC.
//
// Design notes:
// - Reading runs `bd --readonly`. The writes to the issue database are
//   creating (`bd create`), closing (`bd close`), reopening (`bd reopen`)
//   changing an issue's type, priority, title, description, parent or
//   category (`bd update`), and adding or removing links between issues
//   (`bd dep`); nothing here deletes an issue or edits its design,
//   acceptance criteria, notes or comments. Setup additionally runs
//   `bd init` and `bd setup` in a terminal the user can see, and writes
//   Airbender's rules into the folder's AGENTS.md.
// - Every issue goes through a workflow to be closed (bead-bb-e2b). The
//   step an issue is at is kept on it as a `step:<id>` label. This backend
//   only runs the workflow: it checks a move, records the step, and starts
//   the agent on a step that is the agent's. It names no step itself.
// - The plugin speaks to the current thread's agent by sending the thread a
//   message: the instruction for a step, the request to commit after the
//   user accepts an issue, and the "Agree & continue" button's fixed reply. The
//   agent answers through two tools: `beads_set_current` and the workflow
//   move tool. The plugin never changes git; it only reads which branch a
//   folder is on.
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
//   work on all of them, and finishing it closes all of them
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
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CURRENT_TOOL_INSTRUCTIONS,
  currentRefusal,
  moveToolInstructions,
  switchNote,
  workflowLine,
} from "./server/agent-tools.ts";
import { rpcContract } from "./server/contract.ts";
import { createCurrentBead } from "./server/current-bead.ts";
import { createFolders } from "./server/folder.ts";
import { createSetup } from "./server/setup.ts";
import { createStore } from "./server/store.ts";
import { createWatcher } from "./server/watch.ts";
import { createWork } from "./server/work.ts";
import { createWorkflowChoice } from "./server/workflow-choice.ts";
import {
  BEAD_ID_PATTERN,
  QUICK_REPLIES,
} from "./shared/constants.ts";
import { MOVE_TOOL, standardWorkflow } from "./shared/standard-workflow.ts";
import { workflowFor } from "./shared/workflows.ts";

/**
 * The plugin's backend entry point: reads the settings, builds the pieces
 * (watcher, store, workflow runner, setup) and registers the request handlers, the
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
  });
  const { bdCommand } = await settings.get();

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
  // then work (moving issues through their workflow) and setup on top of the
  // store.
  const folders = createFolders({ bb, bdCandidates });
  const currentBead = createCurrentBead(bb);
  const { watchFolder } = await createWatcher(bb);
  const workflowChoice = await createWorkflowChoice(bb);
  const store = createStore({
    bb,
    folders,
    currentBead,
    watchFolder,
    workflowChoice,
  });
  const work = createWork({ bb, store, currentBead, workflowChoice });
  const { setupStatus, runSetup } = createSetup({ bb, folders, store });

  // Every handler is one call into a module: what each does, and how it
  // reports a problem, is documented where it is written. All of them
  // answer with data (a state or a message in plain words) and none throws
  // for an expected problem, so the tab has one way to show a failure.
  bb.rpc.register(rpcContract, {
    issues_list: (input) => store.listIssues(input),
    issue_comments: (input) => store.listComments(input),
    issue_create: (input) => store.createIssue(input),
    // Cancel: closing without finishing. Finishing is a workflow move. On
    // the simple workflow it is the one way to close.
    issue_close: (input) => work.close(input),
    issue_reopen: (input) => store.setIssueOpen("reopen", input),
    issue_update: (input) => store.updateIssue(input),
    issue_set_parent: (input) => store.setParent(input),
    issue_set_category: (input) => store.setCategory(input),
    issue_link: (input) => store.link(input),
    issue_unlink: (input) => store.unlink(input),
    workflow_run: (input) => work.run(input),
    workflow_move: async (input) => ({
      message: (await work.move(input, "user")).message,
    }),
    workflow_set: async (input) => {
      const folder = await folders.folderFor(input);
      if ("message" in folder) return { message: folder.message };
      const before = workflowChoice.idFor(folder.path);
      try {
        await workflowChoice.set(folder.path, input.workflow);
      } catch (cause) {
        return {
          message: `The workflow could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      // Every tab on this repository draws its rows from the choice.
      store.changed(input.threadId);
      // The thread this tab belongs to is told, so an agent in the middle
      // of work does not go on by the old rules. Other threads on the same
      // repository learn it when they next set their current issue. Sent
      // like the other notes: it starts a short turn when the agent is
      // idle and queues behind a running one.
      if (input.threadId !== null && before !== input.workflow) {
        try {
          await bb.sdk.threads.send({
            threadId: input.threadId,
            mode: "auto",
            input: [
              { type: "text", mentions: [], text: switchNote(input.workflow) },
            ],
          });
        } catch (cause) {
          return {
            message: `The workflow was changed, but the agent could not be told: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
      }
      return { message: null };
    },
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
    instructions: CURRENT_TOOL_INSTRUCTIONS,
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
      // Reject ids that point at nothing (a typo, a closed issue, a folder
      // without beads), so the agent is told instead of the user being
      // shown a highlight that points nowhere.
      const listed = await store.listIssues({ threadId, projectId: null });
      const refusal = currentRefusal(listed, beadId);
      if (refusal !== null) {
        return { content: [{ type: "text", text: refusal }], isError: true };
      }
      await currentBead.write(threadId, beadId);
      // The agent is starting on this issue: the moment to tell it which
      // workflow applies and where the issue stands (see agent-tools.ts).
      const step =
        listed.issues.find((issue) => issue.id === beadId)?.step ?? null;
      return `This thread's current bead is now ${beadId}. ${workflowLine(workflowFor(listed.workflow), step)}`;
    },
  });

  // The agent's way to move an issue through its workflow: report a step
  // finished, skip one with a reason, or send its own review back. What it
  // may do is the workflow's decision; a refused move comes back with the
  // reason and what is allowed instead.
  bb.agents.registerTool({
    name: MOVE_TOOL,
    description:
      "Move a beads issue to the next step of its workflow: report the step you were asked to do as finished, skip it with a reason, or send your own review back. The answer says what comes next.",
    instructions: moveToolInstructions(standardWorkflow.describeForAgents()),
    presentation: {
      label: { pending: "Moving the issue on", completed: "Moved the issue on" },
    },
    parameters: z.object({
      id: z.string().describe("Beads issue id, e.g. proj-a1b."),
      move: z
        .string()
        .describe(
          "The move to make, as named in the instruction for the step, e.g. done, skip, pass, send-back.",
        ),
      note: z
        .string()
        .describe(
          "One line on what was done, or why it is skipped or sent back. Recorded on the issue.",
        ),
    }),
    async execute({ id, move, note }, { threadId }) {
      const outcome = await work.move(
        { threadId, projectId: null, beadId: id.trim(), moveId: move.trim(), note },
        "agent",
      );
      if (outcome.message !== null) {
        return {
          content: [{ type: "text", text: outcome.message }],
          isError: true,
        };
      }
      return outcome.state === null
        ? `${id} is closed.`
        : outcome.instruction !== null
          ? `${id} is now at "${outcome.state.label}", which is yours. Carry on:\n\n${outcome.instruction}`
          : `${id} is now at "${outcome.state.label}", which waits for the user. Tell them it is ready, and stop there. When they reply: if they ask for changes, move it back with \`send-back\` giving their words, and redo it; if they approve, record it with \`approved\`, quoting them, and carry on; if they only ask a question, answer it and leave the issue where it is.`;
    },
  });

  // Offer both tools to every thread, whatever its folder holds and
  // whichever workflow its repository is on (bead-bb-8fm). BB settles a
  // thread's tools when its session starts and adds none to a running one,
  // so offering them only where the folder already used beads, and the step
  // tool only on the standard workflow, left agents without them: a thread
  // started before beads was set up, or running across a switch of
  // workflow. Where a tool does not apply it refuses in plain words, and
  // its instructions begin with when it applies (server/agent-tools.ts).
  bb.agents.configure(() => ({
    tools: ["beads_set_current", MOVE_TOOL],
    skills: [],
  }));
}
