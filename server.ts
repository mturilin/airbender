// bb-plugin-airbender — backend entry.
//
// Where things are: this file reads the settings, wires the pieces together
// and holds the table of request handlers and the agent tool. The pieces are
// in server/: contract.ts (the typed contract with the frontend), folder.ts
// (finding the folder and the bd and bend programs), bend.ts (running the
// bend program, which reads and changes issues), current-bead.ts (which issue a thread is working
// on), store.ts (listing and changing issues, through that tracker),
// work.ts (moving an issue through its workflow), issues.ts (turning the
// tracker's issues into the tab's), bd.ts (running programs), watch.ts (noticing changes made
// outside the plugin) and setup.ts (getting a folder ready, as buttons over
// `bend setup`). thread-titles.ts names each conversation after its current
// issue, or has summary-title.ts write one when it has none. The workflow itself, its steps and the
// wording for each, is in shared/standard-workflow.ts. The notes below describe the backend as a whole.
//
// What: the data behind the Airbender tab. Lists the beads issues of the
// folder a thread (or project) works in, creates and changes them, remembers
// which issue each thread is working on, and gets a folder ready for beads.
// Issues are read and changed by running `bend`, the Go program in bend/
// that agents use too (bead-bb-c9l.4); for beads, bend runs the `bd`
// command-line tool.
//
// Why: beads keeps a repo's issues in a database inside the repo, and the only
// supported way to read it is the `bd` tool. The browser cannot run a program,
// so the tab asks this backend over RPC.
//
// Design notes:
// - No bd command for an issue is written in this plugin's backend: bend's
//   beads adapter (bend/internal/beads) holds them all, and the store
//   calls bend. Reading runs `bd --readonly`. The writes are creating,
//   closing and reopening an issue, changing its type, priority, title,
//   description, parent, category or labels, adding a comment, and adding
//   or removing links between issues; nothing here deletes an issue or
//   edits its design, acceptance criteria or notes. Setup additionally runs
//   `bd init` and `bd setup` in a terminal the user can see, and writes
//   Airbender's rules into the folder's AGENTS.md.
// - Every issue goes through a workflow to be closed (bead-bb-e2b). The
//   step an issue is at is kept on it as a `step:<id>` label. This backend
//   only runs the workflow: it checks a move, records the step, and starts
//   the agent on a step that is the agent's. It names no step itself.
// - The plugin speaks to the current thread's agent by sending the thread a
//   message: the instruction for a step, the request to commit after the
//   user accepts an issue, and the "Agree & continue" button's fixed reply. The
//   agent answers through two tools: `airbender_set_current` and the workflow
//   move tool. The plugin never changes git; it only reads which branch a
//   folder is on.
// - "Current bead" is BB's knowledge, not beads': which issue a given thread
//   is working on. It is stored on the thread (BB's per-plugin thread
//   metadata), set either by the user in the tab or by the thread's agent
//   through the `airbender_set_current` tool. Beads itself is not changed by it.
// - The tab's list is one `bd list --all`. "Blocked" is worked out from
//   each issue's dependency list (in the adapter, and for the owner's
//   "every open sub-issue is blocked" rule in server/issues.ts) instead of
//   a second `bd blocked` call, so the tab always shows one consistent
//   snapshot. A change reads that list once more before it writes: the
//   adapter checks there what it is asked to change.
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
  CURRENT_TOOL,
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
import { REPORT_TOOL, createSizing } from "./server/sizing.ts";
import { createStore } from "./server/store.ts";
import { createTrackers } from "./server/bend.ts";
import { createWatcher } from "./server/watch.ts";
import { createAutopilot } from "./server/autopilot.ts";
import { createGithub } from "./server/github.ts";
import { createSync } from "./server/sync.ts";
import { createWork } from "./server/work.ts";
import type { WorkEvents } from "./server/work.ts";
import { createWorkTrees } from "./server/work-trees.ts";
import { createWorkflowChoice, repositoryKey } from "./server/workflow-choice.ts";
import {
  SUMMARY_BACKENDS,
  SUMMARY_OFF,
  createThreadTitles,
} from "./server/thread-titles.ts";
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
    bendCommand: {
      type: "string",
      label: "bend command",
      description:
        "Name or full path of bend, the program Airbender reads and changes issues with. Leave as bend unless BB cannot find it.",
      default: "bend",
    },
    // Background sizing (bead-bb-zkc). On BB's own page because a tab
    // cannot open a settings screen of the plugin's; the tab's menu says
    // where these are. Read each time a worker is about to start, so a
    // change here needs no reload.
    backgroundSizing: {
      type: "boolean",
      label: "Size issues in the background",
      description:
        "A background agent gives new and changed issues a size (S, M or L) before they are started. Sizes you set yourself are never changed. Standard workflow only.",
      default: true,
    },
    sizingProvider: {
      type: "string",
      label: "Sizing provider",
      description:
        "The provider the background agent runs on, as listed by `bb provider list`. Empty uses the project's default.",
      default: "claude-code",
    },
    // The token "Sync with GitHub" hands to beads' own sync (bead-bb-rh3).
    // A secret: BB keeps it in a file of its own on this computer, never
    // in the repository and never sent to the tab. Not kept the beads way
    // (`bd config set github.token`), which writes .beads/config.yaml, a
    // file that is in git in many repositories.
    githubToken: {
      type: "string",
      secret: true,
      label: "GitHub token",
      description:
        "Optional. \"Sync with GitHub\" in the Airbender tab's menu uses the gh command's sign-in when this is empty. Set a personal access token here to use that one instead; it needs to read and write the issues of the repository. Kept on this computer only.",
      default: "",
    },
    sizingModel: {
      type: "string",
      label: "Sizing model",
      description:
        "The model for the background agent; it must belong to the provider above. Haiku is cheap and quick; claude-sonnet-5 judges code better. Empty uses the provider's default.",
      default: "claude-haiku-4-5-20251001",
    },
    // Conversation titles (bead-bb-du7). Read each time a title is about
    // to be written, so a change here needs no reload.
    issueTitles: {
      type: "boolean",
      label: "Name conversations after their issue",
      description:
        "A conversation with a current issue is titled with the issue's id and title, and gets its old title back when the issue is cleared. A conversation you rename yourself keeps your name until its issue changes.",
      default: true,
    },
    summaryBackend: {
      type: "select",
      label: "Summary titles",
      description:
        "A conversation with no current issue gets a short AI-written title after each turn. gemini: the Gemini API. openai-compatible: any /chat/completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio). command: a command on this computer that reads the prompt on stdin and prints the title.",
      options: [...SUMMARY_BACKENDS],
      default: SUMMARY_OFF,
    },
    summaryGeminiApiKey: {
      type: "string",
      secret: true,
      label: "Summary titles: Gemini API key",
      default: "",
    },
    summaryGeminiModel: {
      type: "string",
      label: "Summary titles: Gemini model",
      default: "gemini-3.5-flash-lite",
    },
    summaryOpenaiBaseUrl: {
      type: "string",
      label: "Summary titles: OpenAI-compatible base URL",
      description: "For example https://api.openai.com/v1 or http://localhost:11434/v1.",
      default: "https://api.openai.com/v1",
    },
    summaryOpenaiApiKey: {
      type: "string",
      secret: true,
      label: "Summary titles: OpenAI-compatible API key",
      description: "Leave empty for a local server that needs none.",
      default: "",
    },
    summaryOpenaiModel: {
      type: "string",
      label: "Summary titles: OpenAI-compatible model",
      default: "",
    },
    summaryCommand: {
      type: "string",
      label: "Summary titles: command",
      description:
        "Run with /bin/sh on this computer, with the prompt on stdin. The BB server's PATH may be short: set it in front if needed, e.g. PATH=/opt/homebrew/bin:$PATH gemini -p \"\".",
      default: "",
    },
  });
  const { bdCommand, bendCommand } = await settings.get();

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
  // Installing or building bend puts it in the first of the extra places.
  const bendCandidates = [
    bendCommand.trim() || "bend",
    join(homedir(), ".local", "bin", "bend"),
    join(homedir(), "go", "bin", "bend"),
    "/usr/local/bin/bend",
  ];
  const folders = createFolders({ bb, bdCandidates, bendCandidates });
  const currentBead = createCurrentBead(bb);
  const { watchFolder } = await createWatcher(bb);
  const workflowChoice = await createWorkflowChoice(bb);
  const trackers = createTrackers({
    findBd: folders.findBd,
    findBend: folders.findBend,
    notFoundMessage: folders.BD_NOT_FOUND_MESSAGE,
    bendMessages: folders.BEND_MESSAGES,
    warn: (line) => bb.log.warn(line),
  });
  const store = createStore({
    bb,
    folders,
    trackers,
    currentBead,
    watchFolder,
    workflowChoice,
  });
  const sizing = await createSizing({
    bb,
    readSettings: async () => {
      const now = await settings.get();
      return {
        enabled: now.backgroundSizing,
        providerId: now.sizingProvider,
        model: now.sizingModel,
      };
    },
    readIssues: store.readIssues,
    setSize: store.setSize,
    addComment: store.addComment,
    workflowFor: workflowChoice.workflowFor,
  });
  const workTrees = await createWorkTrees({
    bb,
    mainBranch: folders.mainBranch,
    mainFolder: folders.mainFolder,
    deleteMergedBranch: folders.deleteMergedBranch,
  });
  const workEvents: WorkEvents = {};
  const work = createWork({
    bb,
    store,
    currentBead,
    workflowChoice,
    onUserSize: sizing.forget,
    hasUncommittedChanges: folders.hasUncommittedChanges,
    currentBranch: folders.currentBranch,
    workTrees,
    events: workEvents,
  });
  // Autopilot starts issues through `work`, and `work` tells it what
  // happens: each is built first, then the two are joined.
  const autopilot = await createAutopilot({
    bb,
    store,
    currentBead,
    workflowChoice,
    begin: work.begin,
  });
  workEvents.delivered = autopilot.watch;
  workEvents.closed = autopilot.advance;
  workEvents.stuck = autopilot.stuck;
  workEvents.ownerCurrent = autopilot.ownerSteppedIn;
  const issueSync = createSync({ bb, store, trackers });
  const { setupStatus, runSetup } = createSetup({
    bb,
    folders,
    store,
    bendIn: trackers.bendIn,
    trackerChanged: trackers.forget,
  });
  const github = createGithub({
    bb,
    folders,
    store,
    readToken: async () => (await settings.get()).githubToken ?? "",
    readBeads: trackers.beadsIssues,
  });
  // Each conversation named after its current issue, or summarised when it
  // has none (bead-bb-du7). Every way of setting the current issue goes
  // through currentBead.store, so listening there catches all of them; a
  // finished turn is when an edited issue title or a summary is caught up.
  const titles = createThreadTitles({
    bb,
    store,
    currentBead,
    beforeRename: async (threadId) => {
      if (workTrees.isOurs(threadId)) await workTrees.branchOf(threadId);
    },
    readSettings: async () => {
      const now = await settings.get();
      return {
        issueTitles: now.issueTitles,
        summaryBackend: now.summaryBackend,
        summary: {
          geminiApiKey: now.summaryGeminiApiKey ?? "",
          geminiModel: now.summaryGeminiModel,
          openaiBaseUrl: now.summaryOpenaiBaseUrl,
          openaiApiKey: now.summaryOpenaiApiKey ?? "",
          openaiModel: now.summaryOpenaiModel,
          command: now.summaryCommand,
        },
      };
    },
  });
  bb.onDispose(currentBead.listen(titles.issueChanged));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    titles.turnEnded(thread.id, lastAssistantText);
  });
  // Conversations whose issue was set before this load are named too. A
  // few seconds after loading, off the load path: BB's SDK is meant for
  // after registration, and the tab's first lists come first.
  const reconcileTimer = setTimeout(() => {
    titles.reconcile().catch((cause) => {
      bb.log.warn(`conversation titles were not caught up: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }, 5_000);
  bb.onDispose(() => clearTimeout(reconcileTimer));

  // Every handler is one call into a module: what each does, and how it
  // reports a problem, is documented where it is written. All of them
  // answer with data (a state or a message in plain words) and none throws
  // for an expected problem, so the tab has one way to show a failure.
  bb.rpc.register(rpcContract, {
    issues_list: async (input) => {
      const listed = await store.listIssues(input);
      // Every list a tab asks for is also the moment to see whether an
      // issue is new or has changed and wants a size (server/sizing.ts).
      if (listed.state === "ok" && listed.path !== null) {
        sizing.consider(listed.path, listed.issues, input);
      }
      // Which issues have a conversation of their own in a work tree is
      // the plugin's knowledge, not beads': added here, for the tab.
      // And the moment for autopilot to take up what a reload cut short.
      autopilot.consider(input.threadId);
      // An issue title may have been edited: the conversation's follows.
      if (listed.state === "ok" && input.threadId !== null) {
        titles.check(input.threadId, listed.issues);
      }
      return {
        ...listed,
        autopilot: autopilot.stateFor(input.threadId),
        issues: listed.issues.map((issue) => ({
          ...issue,
          conversationId: workTrees.threadFor(issue.id),
        })),
      };
    },
    issue_comments: (input) => store.listComments(input),
    issue_create: (input) => store.createIssue(input),
    // Cancel: closing without finishing. Finishing is a workflow move. On
    // the simple workflow it is the one way to close.
    issue_close: (input) => work.close(input),
    issue_reopen: (input) => store.setIssueOpen("reopen", input),
    issue_defer: (input) => store.setIssueSomeday("defer", input),
    issue_undefer: (input) => store.setIssueSomeday("undefer", input),
    issue_update: (input) => store.updateIssue(input),
    issue_set_parent: (input) => store.setParent(input),
    issue_set_category: (input) => store.setCategory(input),
    issue_link: (input) => store.link(input),
    issue_unlink: (input) => store.unlink(input),
    workflow_run: (input) => work.run(input),
    workflow_move: async (input) => {
      const outcome = await work.move(input, "user");
      return {
        message: outcome.message,
        warning: outcome.warning === true,
        openThreadId: outcome.openThreadId ?? null,
        enterEpic: outcome.enterEpic === true,
      };
    },
    autopilot_set: (input) => autopilot.set(input),
    sync_status: async (input) => {
      const folder = await folders.folderFor(input);
      return "message" in folder
        ? {
            source: null,
            remote: null,
            running: false,
            halted: false,
            last: null,
            syncedAt: null,
            refused: [],
            trouble: null,
            helper: null,
          }
        : {
            ...(await issueSync.state(folder.path, input.passive === true)),
            // Asked the same way: every run of bend this request makes
            // must be passive, or none is.
            refused: await store.refusedIn(folder.path, input.passive === true),
          };
    },
    sync_refused_settle: (input) => store.settleRefused(input),
    sync_log: async (input) => {
      const folder = await folders.folderFor(input);
      return {
        entries:
          "message" in folder ? [] : await issueSync.log(folder.path, input.failed === true),
      };
    },
    sync_now: async (input) => {
      const folder = await folders.folderFor(input);
      return "message" in folder
        ? { message: folder.message }
        : issueSync.refresh(folder.path);
    },
    github_issues: (input) => github.issues(input),
    github_sync: (input) => github.sync(input),
    tracker_switch_preview: (input) => github.switchPreview(input, input.to),
    github_sync_progress: async (input) => github.progress(input),
    issue_set_size: (input) => work.resize(input),
    issue_request_sizing: async (input) => {
      const found = await store.issuesIn(input, input.beadId);
      if ("message" in found) return { message: found.message };
      return sizing.request(found.path, input.beadId, input);
    },
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
    name: CURRENT_TOOL,
    description:
      "Tell BB which issue this thread is working on, so the user sees it highlighted in the Airbender tab. Pass an empty id to clear it.",
    instructions: CURRENT_TOOL_INSTRUCTIONS,
    presentation: {
      label: { pending: "Setting current issue", completed: "Set current issue" },
    },
    parameters: z.object({
      id: z
        .string()
        .describe("Issue id, e.g. proj-a1b. Empty string clears it."),
    }),
    async execute({ id }, { threadId }) {
      const beadId = id.trim();
      if (beadId === "") {
        await currentBead.write(threadId, null);
        return "Cleared this thread's current issue.";
      }
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return {
          content: [{ type: "text", text: `"${beadId}" is not an issue id.` }],
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
      return `This thread's current issue is now ${beadId}. ${workflowLine(workflowFor(listed.workflow), step)}`;
    },
  });

  // The agent's way to move an issue through its workflow: report a step
  // finished, skip one with a reason, or send its own review back. What it
  // may do is the workflow's decision; a refused move comes back with the
  // reason and what is allowed instead.
  bb.agents.registerTool({
    name: MOVE_TOOL,
    description:
      "Move an issue to the next step of its workflow: report the step you were asked to do as finished, skip it with a reason, or send your own review back. The answer says what comes next.",
    instructions: moveToolInstructions(standardWorkflow.describeForAgents()),
    presentation: {
      label: { pending: "Moving the issue on", completed: "Moved the issue on" },
    },
    parameters: z.object({
      id: z.string().describe("Issue id, e.g. proj-a1b."),
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

  // How a background sizing worker hands in its sizes (server/sizing.ts).
  // A native tool because a worker's sandbox cannot write to beads; the
  // plugin writes the sizes itself, after checking each one.
  bb.agents.registerTool({
    name: REPORT_TOOL,
    description:
      "Report the sizes chosen for the issues you were given to size. Call it once, with every issue.",
    instructions:
      `You are a background sizing worker. Report every issue you were given in one call of ${REPORT_TOOL}; it writes the sizes onto the issues. Run no commands and change nothing yourself.`,
    presentation: {
      label: { pending: "Reporting sizes", completed: "Reported sizes" },
    },
    parameters: z.object({
      sizes: z
        .array(
          z.object({
            id: z.string().describe("Issue id, as given."),
            size: z.string().describe('The size: "s", "m" or "l".'),
            reason: z.string().describe("One line saying why."),
          }),
        )
        .describe("One entry per issue."),
    }),
    async execute({ sizes }, { threadId }) {
      return sizing.report(threadId, sizes);
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
  //
  // The plugin's own sizing workers are the exception: they get the one
  // tool they report with and nothing else, and nobody else gets that one.
  bb.agents.configure((context) => ({
    tools: sizing.isWorker(context.thread.title)
      ? [REPORT_TOOL]
      : [CURRENT_TOOL, MOVE_TOOL],
    skills: [],
  }));
}
