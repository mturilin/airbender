// bb-plugin-airbender — backend entry.
//
// Where things are: this file reads the settings, wires the pieces together
// and holds the table of request handlers and the agent tool. The pieces are
// in server/: contract.ts (the typed contract with the frontend), store.ts
// (finding the folder, running bd, listing and changing issues, the thread's
// current bead), issues.ts (turning beads' rows into issues), bd.ts (running
// programs), watch.ts (noticing changes made outside the plugin), setup.ts
// (getting a folder ready), define.ts (the Define worker) and prompts.ts (the
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
import type { Issue } from "./server/contract.ts";
import { createDefine } from "./server/define.ts";
import { RELATES_TO, descendantsOf } from "./server/issues.ts";
import { workRequest } from "./server/prompts.ts";
import { createSetup } from "./server/setup.ts";
import { createStore } from "./server/store.ts";
import { createWatcher } from "./server/watch.ts";
import {
  BEAD_ID_PATTERN,
  CHANGED_CHANNEL,
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

  // The pieces, built in dependency order: the watcher, the store that runs
  // bd, then setup and Define on top of the store.
  const { watchFolder } = await createWatcher(bb);
  const store = createStore({ bb, bdCandidates, watchFolder });
  const {
    resolveFolder,
    BD_NOT_FOUND_MESSAGE,
    runBdIn,
    linkEnds,
    writeCurrentBead,
    listIssues,
    setCategory,
    createIssue,
    setIssueOpen,
    listComments,
  } = store;
  const { setupStatus, runSetup } = createSetup({ bb, store });
  const { startDefine } = createDefine({ bb, store, defineModel });

  bb.rpc.register(rpcContract, {
    issues_list: (input) => listIssues(input),
    issue_comments: (input) => listComments(input),
    issue_create: (input) => createIssue(input),
    issue_close: async ({ commit, ...input }) => {
      // Read the issue before closing: its title goes into the message to
      // the agent, and its open sub-issues have to be closed first.
      const before =
        commit && input.threadId !== null ? await listIssues(input) : null;
      const title =
        before?.issues.find((issue) => issue.id === input.beadId)?.title ??
        null;
      // "Close & commit" on an epic closes everything still open inside it
      // (the user's decision, bead-bb-5qt). Deepest first, because beads
      // refuses to close an issue that still has open sub-issues. A plain
      // close (commit false) does not do this: it is the "drop this issue"
      // action, and dropping a whole tree by one click would be too easy.
      const closedSubIssues: Issue[] = [];
      if (before !== null) {
        const open = descendantsOf(input.beadId, before.issues).filter(
          (issue) => issue.status !== CLOSED_STATUS,
        );
        for (const subIssue of open.reverse()) {
          const closedOne = await setIssueOpen("close", {
            ...input,
            beadId: subIssue.id,
          });
          if (closedOne.message !== null) {
            return {
              message: `Could not close sub-issue ${subIssue.id}, so ${input.beadId} was left open: ${closedOne.message}`,
            };
          }
          closedSubIssues.push(subIssue);
        }
      }
      const outcome = await setIssueOpen("close", input);
      // Only after bd close succeeded: a failed close (for example a blocked
      // issue) must not leave the agent committing work that is not accepted.
      if (outcome.message !== null || !commit || input.threadId === null) {
        return outcome;
      }
      try {
        // "auto" starts a turn when the agent is idle and queues behind the
        // running turn otherwise. The plugin never runs git itself; the agent
        // commits under its own rules, including any need to ask first.
        await bb.sdk.threads.send({
          threadId: input.threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              mentions: [],
              text:
                `The user closed beads issue ${input.beadId}${title === null ? "" : `: ${JSON.stringify(title)}`} from the Airbender tab and asked for its work to be committed.` +
                (closedSubIssues.length === 0
                  ? " Commit the changes that belong to this issue, following the commit rules in AGENTS.md: only this issue's files, and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit for it, say so."
                  : ` Its sub-issues were closed with it: ${closedSubIssues
                      .map((issue) => `${issue.id} (${JSON.stringify(issue.title)})`)
                      .join(
                        ", ",
                      )}. Commit the changes that belong to this issue and those sub-issues, following the commit rules in AGENTS.md: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title; only these issues' files; and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit, say so.`),
            },
          ],
        });
      } catch (cause) {
        return {
          message: `The issue was closed, but the agent could not be asked to commit: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      return outcome;
    },
    issue_reopen: (input) => setIssueOpen("reopen", input),
    issue_define: (input) => startDefine(input),
    issue_set_category: (input) => setCategory(input),
    issue_link: async ({ threadId, projectId, fromId, toId, kind }) => {
      const checked = await linkEnds({ threadId, projectId, fromId, toId });
      if ("message" in checked) return checked;
      // "related" goes through beads' own see-also command, which links both
      // issues to each other; every other kind is a one-way dependency.
      // Cycles and duplicates are left to bd, whose message is passed on.
      const run = await runBdIn(
        checked.path,
        kind === "related"
          ? ["dep", "relate", fromId, toId, "--json"]
          : ["dep", "add", fromId, toId, "--type", kind, "--json"],
      );
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd dep add failed in " + checked.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_unlink: async ({ threadId, projectId, fromId, toId, kind }) => {
      const checked = await linkEnds({ threadId, projectId, fromId, toId });
      if ("message" in checked) return checked;
      // A two-way link is undone with the command that made it, so both
      // halves go; `dep remove` would leave the other issue's half behind.
      const run = await runBdIn(
        checked.path,
        kind === RELATES_TO
          ? ["dep", "unrelate", fromId, toId, "--json"]
          : ["dep", "remove", fromId, toId, "--json"],
      );
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn(
          "bd dep remove failed in " + checked.path + ": " + run.message,
        );
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_set_parent: async ({ threadId, projectId, beadId, parentId }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return { message: `"${beadId}" is not a beads issue id.` };
      }
      if (parentId !== null && !BEAD_ID_PATTERN.test(parentId)) {
        return { message: `"${parentId}" is not a beads issue id.` };
      }
      const listed = await listIssues({ threadId, projectId });
      if (listed.state !== "ok" || listed.path === null) {
        return { message: listed.message ?? "The issues could not be read." };
      }
      if (!listed.issues.some((issue) => issue.id === beadId)) {
        return { message: `Issue ${beadId} is no longer in the list.` };
      }
      if (parentId !== null) {
        if (!listed.issues.some((issue) => issue.id === parentId)) {
          return { message: `Issue ${parentId} is no longer in the list.` };
        }
        // Checked here and not left to bd: an issue inside itself would
        // disappear from every view that walks the tree from the top.
        if (
          parentId === beadId ||
          descendantsOf(beadId, listed.issues).some(
            (issue) => issue.id === parentId,
          )
        ) {
          return {
            message:
              "An issue cannot be moved inside itself or inside one of its own sub-issues.",
          };
        }
      }
      // An empty --parent is how bd takes an issue out of its parent.
      const run = await runBdIn(listed.path, [
        "update",
        beadId,
        "--json",
        "--parent",
        parentId ?? "",
      ]);
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd update --parent failed in " + listed.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_update: async ({
      threadId,
      projectId,
      beadId,
      type,
      priority,
      title,
      description,
    }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return { message: `"${beadId}" is not a beads issue id.` };
      }
      if (
        type === null &&
        priority === null &&
        title === null &&
        description === null
      ) {
        return { message: null };
      }
      const folder = await resolveFolder({ threadId, projectId });
      if ("reason" in folder) return { message: folder.reason };
      if (!existsSync(folder.path)) {
        return {
          message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
        };
      }
      // Type comes from a fixed list and priority is a checked number. Title
      // and description are free text, so each is passed as the value of a
      // named flag: text that starts with a dash can then never be read by
      // bd as an option. No shell is involved (see runBd).
      const args = ["update", beadId, "--json"];
      if (type !== null) args.push("--type", type);
      if (priority !== null) args.push("--priority", `${priority}`);
      if (title !== null) args.push("--title", title);
      if (description !== null) args.push("--description", description);
      const run = await runBdIn(folder.path, args);
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd update failed in " + folder.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    current_start: async ({ threadId, beadId }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        throw new Error(`"${beadId}" is not a beads issue id.`);
      }
      // Look the issue up so the message can carry its title, and so a stale
      // row (issue deleted since the tab loaded) fails before anything is sent.
      const listed = await listIssues({ threadId, projectId: null });
      const issue = listed.issues.find((candidate) => candidate.id === beadId);
      if (issue?.status === CLOSED_STATUS) {
        throw new Error(`Issue ${beadId} is closed. Reopen it before starting work on it.`);
      }
      if (issue === undefined) {
        throw new Error(`Issue ${beadId} is no longer in the list. Refresh and try again.`);
      }
      await writeCurrentBead(threadId, beadId);
      // "auto" starts a turn when the agent is idle and queues behind the
      // running turn otherwise, so pressing play never interrupts work.
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            mentions: [],
            text: workRequest(
              issue.id,
              issue.title,
              descendantsOf(issue.id, listed.issues).filter(
                (candidate) => candidate.status !== CLOSED_STATUS,
              ),
            ),
          },
        ],
      });
      return { currentBeadId: beadId };
    },
    current_set: async ({ threadId, beadId }) => {
      if (beadId !== null && !BEAD_ID_PATTERN.test(beadId)) {
        throw new Error(`"${beadId}" is not a beads issue id.`);
      }
      await writeCurrentBead(threadId, beadId);
      return { currentBeadId: beadId };
    },
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
        await writeCurrentBead(threadId, null);
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
      const listed = await listIssues({ threadId, projectId: null });
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
      await writeCurrentBead(threadId, beadId);
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
