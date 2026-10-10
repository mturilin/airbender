// server/setup.ts — getting a folder ready for Airbender.
//
// What: works out what is and is not in place for a folder (the beads program,
// beads in the folder, beads' setup for each coding agent, Airbender's rules)
// and runs the action that sets one of them up.
//
// Why: when something the tab needs is missing, the tab offers to set it up
// instead of leaving the user at a dead end (bead-bb-80e).
//
// Design notes:
// - Install, folder setup and agent setup run in a BB terminal the user can
//   watch and type into: an install may ask for a password, and the user
//   should see what is done to their machine.
// - A condition found met is remembered while the plugin runs and not checked
//   again (the user's rule); what is still missing is checked on every call.
// - The rules are written straight into AGENTS.md, and an existing CLAUDE.md
//   is made to point at it (see server/prompts.ts).
//
// Gotchas:
// - Removing beads or the rules afterwards is not noticed until the plugin
//   reloads.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGED_CHANNEL, SETUP_AGENTS } from "../shared/constants.ts";
import type { SetupAction } from "../shared/constants.ts";
import { writeSetting } from "../tracker/config.ts";
import { githubRepositoryOf } from "../tracker/detect.ts";
import { findToken } from "../tracker/github-api.ts";
import { programExists, readGit, runBd, shellQuote } from "./bd.ts";
import type { SetupStatus } from "./contract.ts";
import { agentsFileWith, claudeFileFor, rulesIn } from "./prompts.ts";
import type { Trackers } from "./trackers.ts";
import type { Folders } from "./folder.ts";
import type { Store } from "./store.ts";
import type { SyncStep } from "../sync/types.ts";

/**
 * The ways of installing beads the tab can offer, each with the program it
 * needs on the machine. The script, Homebrew and npm commands are the ones
 * in beads' own README; the mise one is how beads is installed on the
 * owner's machine. Only those whose program is present are offered.
 */
const INSTALL_METHODS = [
  {
    id: "script",
    label: "Beads' install script",
    needs: "curl",
    command:
      "curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash",
  },
  {
    id: "mise",
    label: "mise",
    needs: "mise",
    command: "mise use -g github:gastownhall/beads",
  },
  {
    id: "brew",
    label: "Homebrew",
    needs: "brew",
    command: "brew install beads",
  },
  {
    id: "npm",
    label: "npm",
    needs: "npm",
    command: "npm install -g @beads/bd",
  },
] as const;

/**
 * The plugin's own copy of the `bend` launcher, or null when it is not
 * beside the plugin.
 *
 * `bend` is not a separate install: it is the `bin/bend` script of the
 * folder this plugin runs from, which starts the TypeScript beside it. The
 * plugin's server is either this source file (`server/setup.ts`) or the
 * built bundle (`dist/server.js`); in both, the plugin's folder is one
 * level up.
 */
export function bendLauncher(): string | null {
  try {
    const launcher = join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      "bin",
      "bend",
    );
    return existsSync(launcher) ? launcher : null;
  } catch {
    return null;
  }
}

/**
 * The command that puts `bend` on the PATH: a link in `~/.local/bin`, the
 * usual place for a user's own commands, pointing at the plugin's launcher.
 *
 * A link and not a copy, so that `bend` is always the version of the
 * plugin that is installed. The last part runs it once by name, so the
 * terminal shows at once whether the name is found (it is not, where
 * `~/.local/bin` is not on the PATH, and the step then ends as failed).
 */
function bendCommandFor(launcher: string): string {
  const bin = join(homedir(), ".local", "bin");
  return `mkdir -p ${shellQuote(bin)} && ln -sf ${shellQuote(launcher)} ${shellQuote(join(bin, "bend"))} && bend --help >/dev/null && echo "bend is on the PATH."`;
}

/** How often a running setup terminal is checked, and for how long at most. */
const SETUP_POLL_MS = 1500;

const SETUP_TIMEOUT_MS = 15 * 60_000;

/**
 * The file beads calls out of date, from what its check for an agent said.
 *
 * Beads' check (`bd setup <agent> --check`) fails both when nothing is set
 * up and when everything is but the instructions it wrote no longer match
 * what it would write now: "... integration installed but stale: <file>".
 * Its wording follows the repository's configuration, so giving the issues
 * a remote to sync with is enough to make it stale. Read as "not set up",
 * that brought "Configure beads for Claude Code" back on a repository that
 * had used beads for a week (bead-bb-0bz).
 *
 * @returns The file's name without its folder; null when the check failed
 *   for another reason.
 */
export function staleFile(said: string): string | null {
  const match = /installed but stale:\s*(\S+)/u.exec(said);
  return match === null ? null : (match[1]!.split("/").pop() ?? null);
}


/**
 * Builds the setup operations for this plugin instance.
 *
 * @returns `setupStatus` (what is in place for a folder) and `runSetup`
 *   (start one action).
 * Side effects: none until one of them is called.
 */
export function createSetup({
  bb,
  folders,
  store,
  syncSteps,
  trackers,
}: {
  bb: BbPluginApi;
  folders: Folders;
  store: Store;
  /** The setup steps the folder's issue sync offers now (server/sync.ts). */
  syncSteps: (
    path: string,
  ) => Promise<{ on: SyncStep | null; fetch: SyncStep | null }>;
  trackers: Trackers;
}) {
  const { resolveFolder, findBd } = folders;
  const { readIssues } = store;
  /** The setup action running in a terminal, per folder. */
  const setupRunning = new Map<
    string,
    { action: SetupAction; title: string }
  >();

  /**
   * The setup conditions already found met, per folder: the working beads
   * program, the folder set up, the agents configured, the rules present.
   * Kept only while the plugin runs; a reload checks everything once more.
   */
  const setupMet = new Map<
    string,
    {
      bd: string | null;
      folder: boolean;
      agents: string[];
      rules: boolean;
      signedIn: boolean;
    }
  >();

  /** How the last setup terminal ended, per folder. */
  const setupLastRun = new Map<string, NonNullable<SetupStatus["lastRun"]>>();

  /**
   * Works out what is in place for a folder (see SetupStatus).
   *
   * Side effects: for each condition not yet known to be met, one check (bd
   * version, bd list, one bd check per agent, a read of AGENTS.md); none for
   * conditions already met. Changes nothing on disk.
   */
  async function setupStatus(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<SetupStatus> {
    const nothing = {
      bdInstalled: false,
      installMethods: [],
      folderReady: false,
      agents: [],
      rulesPresent: false,
      tracker: null,
      githubRepository: null,
      ghInstalled: false,
      githubSignedIn: false,
      bendInstalled: false,
      bendCommand: null,
      running: null,
      lastRun: null,
      syncSteps: { on: null, fetch: null },
    };
    const folder = await resolveFolder(input);
    if ("reason" in folder) {
      return { path: null, unavailable: folder.reason, ...nothing };
    }
    const { path } = folder;
    if (!existsSync(path)) {
      return {
        path,
        unavailable: `The folder ${path} does not exist on the machine BB runs on.`,
        ...nothing,
      };
    }
    // A condition that was found met is not checked again (the user's
    // rule): setup only ever moves forward in practice, and detecting that
    // something was taken away again is not worth a check on every refresh.
    // What is still unmet is checked every time. So a folder that is fully
    // set up costs no bd runs here at all.
    const met = setupMet.get(path) ?? {
      bd: null,
      folder: false,
      agents: [],
      rules: false,
      signedIn: false,
    };
    setupMet.set(path, met);
    // Which tracker the folder has decides what there is to set up. Asked
    // of the same place the list asks, so the two agree.
    const found = await trackers.trackerFor(path);
    const tracker = "state" in found ? null : found.name;
    const github = tracker === "github";
    met.bd ??= await findBd(path);
    const bd = met.bd;
    if (github && !met.signedIn) {
      // Whether a login can be found, not whether GitHub accepts it: that
      // costs a request, and a login GitHub refuses shows as the list's
      // own "not signed in".
      met.signedIn = await findToken().then(
        () => true,
        () => false,
      );
    }
    if ((github ? met.signedIn : bd !== null) && !met.folder) {
      // "Set up" means what listing issues means by it, so the panel and
      // the list agree: the tracker gives the folder's issues.
      met.folder = (await readIssues(path)).state === "ok";
    }
    const folderReady = met.folder;
    const agents = [];
    // Beads' own setup for a coding agent; there is none for GitHub.
    if (!github && bd !== null && folderReady) {
      for (const agent of SETUP_AGENTS) {
        let stale: string | null = null;
        if (!met.agents.includes(agent.id)) {
          // bd's own check: it exits 0 when its files for that agent are
          // in place, and non-zero otherwise. Asked of the repository's
          // main folder, not of a work tree (the user's choice,
          // bead-bb-ak0): whether an agent is set up is a fact about the
          // repository, and a fresh work tree holds only what git tracks,
          // so a setup file that was never committed (Claude Code's hooks
          // in .claude/settings.json) is missing there and the tab offered
          // to set the agent up again in every new work tree.
          const check = await runBd(
            bd,
            ["setup", agent.id, "--check"],
            (await folders.mainFolder(path)) ?? path,
          );
          if (check.kind === "ok") met.agents.push(agent.id);
          else if (check.kind === "failed") stale = staleFile(check.message);
        }
        agents.push({
          ...agent,
          configured: met.agents.includes(agent.id) || stale !== null,
          stale,
        });
      }
    }
    if (!met.rules) {
      try {
        // Both halves must hold: the rules for this folder's tracker in
        // AGENTS.md (after a switch the other tracker's are there, which
        // would tell agents to use the wrong command), and a CLAUDE.md,
        // where there is one, that needs no change (see claudeFileFor).
        const claudeFile = join(path, "CLAUDE.md");
        met.rules =
          rulesIn(readFileSync(join(path, "AGENTS.md"), "utf8")) ===
            (tracker ?? "beads") &&
          claudeFileFor(
            existsSync(claudeFile) ? readFileSync(claudeFile, "utf8") : null,
          ) === null;
      } catch {
        // A file is missing (or unreadable): the step is not done.
      }
    }
    const rulesPresent = met.rules;
    // What the folder's issue sync has to offer: switching it on where
    // the issues are synced nowhere, or fetching them where the folder
    // has none and its remote holds them. Asked only where it can apply.
    const offered =
      bd === null
        ? { on: null, fetch: null }
        : await syncSteps(path).catch(() => ({ on: null, fetch: null }));
    /** A step without its command: the tab shows it, the server runs it. */
    const shown = (step: SyncStep | null) =>
      step === null
        ? null
        : { label: step.label, why: step.why, explain: step.explain };
    const launcher = bendLauncher();
    return {
      path,
      unavailable: null,
      bdInstalled: bd !== null,
      installMethods: INSTALL_METHODS.filter((method) =>
        programExists(method.needs),
      ).map(({ id, label, command }) => ({ id, label, command })),
      folderReady,
      agents,
      rulesPresent,
      tracker,
      githubRepository: githubRepositoryOf(path),
      ghInstalled: programExists("gh"),
      githubSignedIn: github && met.signedIn,
      bendInstalled: programExists("bend"),
      bendCommand: launcher === null ? null : bendCommandFor(launcher),
      running: setupRunning.get(path) ?? null,
      lastRun: setupLastRun.get(path) ?? null,
      syncSteps: { on: shown(offered.on), fetch: shown(offered.fetch) },
    };
  }

  /**
   * Runs one setup command in a BB terminal the user can watch and type
   * into, and tells the tab when it ends.
   *
   * A terminal and not a hidden child process: an install may ask for a
   * password, folder setup asks questions, and the user should see what is
   * done to their machine. A terminal that belongs to the thread is used
   * when there is one, so it shows up beside that thread; otherwise one on
   * this machine in the folder.
   *
   * @returns Once the terminal is started. The wait for its end goes on in
   *   the background: when it exits (or after SETUP_TIMEOUT_MS) the exit
   *   code and the last lines of output are kept in setupLastRun and every
   *   open tab is told to reload.
   * @throws When BB cannot open the terminal.
   */
  async function runInTerminal(input: {
    threadId: string | null;
    path: string;
    action: SetupAction;
    title: string;
    command: string;
  }): Promise<void> {
    const { threadId, path, action, title } = input;
    const { primaryHostId } = await bb.sdk.system.config();
    if (threadId === null && primaryHostId === null) {
      throw new Error("BB did not say which machine it runs on.");
    }
    const session = await bb.sdk.terminals.create({
      cols: 100,
      rows: 30,
      title,
      scope:
        threadId !== null
          ? { kind: "thread", threadId }
          : { kind: "host_path", hostId: primaryHostId!, cwd: path },
      // The command goes through a shell (checked with a test terminal),
      // so the cd and the pipe in the install script work as written.
      start: {
        mode: "command",
        command: `cd ${shellQuote(path)} && ${input.command}`,
      },
    });
    setupRunning.set(path, { action, title });
    setupLastRun.delete(path);
    bb.realtime.publish(CHANGED_CHANNEL, { path });
    const startedAt = Date.now();
    const watchTerminal = async () => {
      let exitCode: number | null = null;
      try {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_MS));
          const now = await bb.sdk.terminals.get({ terminalId: session.id });
          if (now.status === "exited" || now.status === "disconnected") {
            exitCode = now.exitCode;
            break;
          }
          if (Date.now() - startedAt > SETUP_TIMEOUT_MS) break;
        }
      } catch (cause) {
        bb.log.warn("watching setup terminal failed: " + cause);
      }
      let tail = "";
      try {
        const output = await bb.sdk.terminals.output({
          terminalId: session.id,
          tailBytes: 4000,
        });
        tail = output.chunks
          .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
          .join("")
          // Colour and cursor codes mean nothing outside a terminal.
          .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
          .replace(/\r/gu, "")
          .trim()
          .split("\n")
          .slice(-12)
          .join("\n");
      } catch {
        // The output is a convenience; the exit code is what matters.
      }
      setupRunning.delete(path);
      setupLastRun.set(path, { action, title, exitCode, tail });
      // What the terminal did may have changed what is in place (beads
      // installed, a login made), so nothing known is trusted any more.
      trackers.forget(path);
      setupMet.delete(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
    };
    void watchTerminal();
  }

  /**
   * Starts one setup action for a folder (the "setup_run" request).
   *
   * Each action is refused when it is already done or cannot be done yet;
   * the tab greys those out, and this is the same rule on the side that
   * actually runs things. Install, folder setup and agent setup run in a
   * visible terminal; the rules are written straight into the folder.
   *
   * @param option The install method's id (for "install") or the agent's id
   *   (for "agent"); null otherwise.
   * @returns `message` null when the action was started (or, for the rules,
   *   done), else the reason in plain words.
   */
  async function runSetup({
    threadId,
    projectId,
    action,
    option,
  }: {
    threadId: string | null;
    projectId: string | null;
    action: SetupAction;
    option: string | null;
  }): Promise<{ message: string | null }> {
    const status = await setupStatus({ threadId, projectId });
    if (status.path === null || status.unavailable !== null) {
      return { message: status.unavailable ?? "There is no folder to set up." };
    }
    const { path } = status;
    if (status.running !== null) {
      return { message: `"${status.running.title}" is still running.` };
    }
    // Each action is refused when it is already done or cannot be done
    // yet. The tab greys those out; this is the same rule on the side
    // that actually runs things.
    if (action === "rules") {
      if (status.rulesPresent) {
        return { message: "Airbender's rules are already in place." };
      }
      const file = join(path, "AGENTS.md");
      try {
        const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
        // Added at the end, after whatever is there. The one thing ever
        // replaced is Airbender's own block for the other tracker, after a
        // switch. Skipped when only the CLAUDE.md half was missing.
        const next = agentsFileWith(existing, status.tracker ?? "beads");
        if (next !== existing) writeFileSync(file, next);
      } catch (cause) {
        return { message: `AGENTS.md could not be written: ${cause}` };
      }
      const claudeFile = join(path, "CLAUDE.md");
      try {
        const next = claudeFileFor(
          existsSync(claudeFile) ? readFileSync(claudeFile, "utf8") : null,
        );
        if (next !== null) writeFileSync(claudeFile, next);
      } catch (cause) {
        return { message: `CLAUDE.md could not be written: ${cause}` };
      }
      setupMet.delete(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
      return { message: null };
    }
    if (action === "tracker") {
      if (option !== "beads" && option !== "github") {
        return { message: "Unknown tracker." };
      }
      if (option === status.tracker) {
        return { message: "This repository already uses that tracker." };
      }
      if (option === "github" && status.githubRepository === null) {
        return {
          message:
            "This folder's remote called origin is not on github.com, so there is no GitHub repository to take issues from.",
        };
      }
      // The setting file belongs at the root of this checkout, where it is
      // found from every folder inside it and is checked in with the rest.
      const root =
        (await readGit(path, ["rev-parse", "--show-toplevel"])) || path;
      try {
        writeSetting(root, option);
      } catch (cause) {
        return {
          message: `The setting file could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      // Everything known about the folder was about the other tracker.
      trackers.forget(path);
      setupMet.delete(path);
      setupLastRun.delete(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
      return { message: null };
    }
    let title: string;
    let command: string;
    if (action === "signin") {
      if (status.githubSignedIn) {
        return { message: "There is already a GitHub login." };
      }
      if (!status.ghInstalled) {
        return {
          message:
            "The gh program, which signs in to GitHub, is not installed. Install it (https://cli.github.com), or set GH_TOKEN where BB is started.",
        };
      }
      title = "Sign in to GitHub";
      command = "gh auth login";
      // The connection kept for the folder was made without a login.
      trackers.forget(path);
    } else if (action === "bend") {
      if (status.bendCommand === null) {
        return {
          message:
            "The bend command was not found beside this plugin, so there is nothing to put on the PATH.",
        };
      }
      title = "Put bend on the PATH";
      command = status.bendCommand;
    } else if (action === "install") {
      if (status.bdInstalled) return { message: "Beads is already installed." };
      const method = status.installMethods.find(
        (candidate) => candidate.id === option,
      );
      if (method === undefined) {
        return { message: "That way of installing is not available here." };
      }
      title = `Install beads (${method.label})`;
      command = method.command;
    } else {
      const bd = await findBd(path);
      if (bd === null) return { message: "Install beads first." };
      if (action === "init") {
        if (status.folderReady) {
          return { message: "Beads is already set up in this folder." };
        }
        title = "Set up beads in this folder";
        command = `${shellQuote(bd)} init`;
      } else if (action === "fetch" || action === "sync") {
        // The issue sync's own steps: what they are called and what they
        // run is the sync source's (sync/), asked for afresh here.
        const offered = await syncSteps(path);
        const step = action === "fetch" ? offered.fetch : offered.on;
        if (step === null) {
          return {
            message:
              action === "fetch"
                ? "There are no issues to get for this folder."
                : "This folder's issues are already synced, or there are none to sync.",
          };
        }
        title = step.label;
        command = step.command;
      } else {
        if (!status.folderReady) {
          return { message: "Set up beads in this folder first." };
        }
        const agent = status.agents.find(
          (candidate) => candidate.id === option,
        );
        if (agent === undefined) return { message: "Unknown agent." };
        if (agent.configured && agent.stale === null) {
          return { message: `Beads is already configured for ${agent.label}.` };
        }
        title =
          agent.stale === null
            ? `Configure beads for ${agent.label}`
            : `Update beads' instructions in ${agent.stale}`;
        command = `${shellQuote(bd)} setup ${agent.id}`;
      }
    }
    try {
      await runInTerminal({ threadId, path, action, title, command });
    } catch (cause) {
      return {
        message: `The terminal could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    return { message: null };
  }

  return { setupStatus, runSetup };
}
