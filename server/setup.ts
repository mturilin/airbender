// server/setup.ts — getting a folder ready for Airbender.
//
// What: says what is and is not in place for a folder, and starts the step
// that sets one thing up. Both are `bend setup`'s: this file asks bend for
// the state, puts it into the shape the tab draws, and runs bend's steps.
// One step is this file's own: installing bend, which bend cannot do itself.
//
// Why: when something the tab needs is missing, the tab offers to set it up
// instead of leaving the user at a dead end (bead-bb-80e). Setting a
// repository up has to work from a plain terminal too, without BB, so what
// the steps are and what they do lives in bend (bead-bb-c9l.9, by the
// decision in bead-bb-c9l.7); the tab is buttons over them, and the two
// cannot disagree.
//
// Design notes:
// - Steps that run an outside program (installing beads, setting up or
//   getting the issues, publishing them, building bend) run in a BB
//   terminal the user can watch and type into: an install may ask for a
//   password, and the user should see what is done to their machine. The
//   steps that only write files (the tracker, the instructions, the facts)
//   run bend directly.
// - The tab asks its own confirmation first and hands bend the answers as
//   options, so bend never has a question left to ask.
// - Reading the state costs bend a few runs of bd, so the answer is kept
//   for a while: minutes when everything is in place, seconds otherwise,
//   and dropped whenever something is run here.
//
// Gotchas:
// - Something set up or taken away outside the tab is noticed only when
//   the kept answer has run out.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { SetupAction } from "../shared/constants.ts";
import { programExists, shellQuote } from "./bd.ts";
import type { Trackers } from "./bend.ts";
import type { SetupStatus } from "./contract.ts";
import type { Folders } from "./folder.ts";
import type { Store } from "./store.ts";
import { planBendInstall } from "./bend-install.ts";

/** How often a running setup terminal is checked, and for how long at most. */
const SETUP_POLL_MS = 1500;

const SETUP_TIMEOUT_MS = 15 * 60_000;

/** How long a state with something missing is given out without asking bend again. */
const STATE_KEPT_MS = 15_000;

/**
 * How long "everything is in place" is given out. Longer, because it is the
 * usual state and asking costs a second; not for ever, because a step can
 * be in place only for now (the remote not reached, no remote yet).
 */
const READY_KEPT_MS = 5 * 60_000;

/** One setup step as `bend setup --json` gives it (bend/internal/setup). */
interface BendStep {
  name: string;
  title: string;
  state: "done" | "missing" | "blocked" | "not-needed";
  why: string;
  command: string;
  runs: string;
  explain: string[];
}

/** What `bend setup --json` prints, limited to what is used. */
export interface BendSetup {
  root: string;
  tracker: string | null;
  ready: boolean;
  steps: BendStep[];
  installMethods: { id: string; label: string; command: string }[];
  issuesHow: string;
  instructions: SetupStatus["instructions"];
  savedFacts: { key: string; text: string }[];
}

/** The reason in something thrown, without the word "Error:". */
const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * bend's setup state in the shape the tab draws. Pure.
 *
 * A step that is "not needed" counts as in place: the tab has nothing to
 * offer for it.
 *
 * @returns The fields of SetupStatus that come from bend.
 */
export function fromBend(state: BendSetup) {
  const step = (name: string) => state.steps.find((one) => one.name === name);
  const inPlace = (name: string) => {
    const found = step(name)?.state;
    return found === "done" || found === "not-needed";
  };
  /** A missing step as the tab shows one whose words come from elsewhere. */
  const offered = (name: string) => {
    const found = step(name);
    return found === undefined || found.state !== "missing"
      ? null
      : {
          label: found.title,
          why: found.why,
          explain: {
            lead:
              found.runs === ""
                ? "What it does:"
                : `Runs \`${found.runs}\` in this folder.`,
            points: found.explain,
          },
        };
  };
  const issues = step("issues");
  return {
    tracker: state.tracker,
    trackerChosen: inPlace("tracker"),
    bdInstalled: inPlace("program"),
    installMethods: state.installMethods,
    folderReady: inPlace("issues"),
    // Why the issues cannot be prepared, when it is not for an earlier
    // step: with GitHub issues, that the repository cannot be told.
    issuesBlocked: issues?.state === "blocked" ? issues.why : null,
    rulesPresent: inPlace("instructions"),
    instructions: state.instructions,
    savedFacts: step("facts")?.state === "missing" ? state.savedFacts : [],
    syncSteps: {
      on: offered("publish"),
      fetch: state.issuesHow === "fetch" ? offered("issues") : null,
    },
  };
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
  bendIn,
  trackerChanged = () => {},
}: {
  /**
   * Told the folder when a step may have changed which tracker it has, so
   * that nothing remembered about the old one is used again.
   */
  trackerChanged?: (path: string) => void;
  bb: BbPluginApi;
  folders: Folders;
  store: Store;
  /** How to run bend in a folder (server/bend.ts). */
  bendIn: Trackers["bendIn"];
}) {
  const { resolveFolder, findBd, findBend } = folders;
  /** The setup action running in a terminal, per folder. */
  const setupRunning = new Map<
    string,
    { action: SetupAction; title: string }
  >();

  /** bend's last answer about a folder, and when it was given. */
  const kept = new Map<string, { at: number; state: BendSetup }>();

  /** Counts the times a folder's kept answer was dropped. */
  const dropped = new Map<string, number>();

  /** Drops what is kept about a folder: something may have changed it. */
  function forget(path: string): void {
    kept.delete(path);
    dropped.set(path, (dropped.get(path) ?? 0) + 1);
  }

  /**
   * What bend says is in place for a folder.
   *
   * @returns The state; or why bend could not say (it is missing, or the
   *   run failed), in plain words.
   * Side effects: one run of bend, unless the answer kept still stands.
   */
  async function stateOf(path: string): Promise<BendSetup | { message: string }> {
    const held = kept.get(path);
    if (
      held !== undefined &&
      Date.now() - held.at < (held.state.ready ? READY_KEPT_MS : STATE_KEPT_MS)
    ) {
      return held.state;
    }
    const bend = await bendIn(path);
    if ("state" in bend) return { message: bend.message };
    const asked = dropped.get(path) ?? 0;
    try {
      const state = (await bend.run(["setup"])) as BendSetup;
      // Not kept when a step ran meanwhile: this answer is from before it.
      if ((dropped.get(path) ?? 0) === asked) {
        kept.set(path, { at: Date.now(), state });
      }
      return state;
    } catch (cause) {
      bb.log.warn(`bend setup failed in ${path}: ${reasonOf(cause)}`);
      return { message: reasonOf(cause) };
    }
  }

  /**
   * How bend is installed on this machine: a verified pinned release
   * download, or the source-build fallback, shown before either is run.
   *
   * The source is the `bend` folder that comes with the plugin, found from
   * where this file is (it may be run from the plugin's folder or from its
   * build output inside that folder). The program goes into the owner's own
   * commands folder, which is where the plugin looks for it next to the
   * PATH.
   *
   * Side effects: reads package/source locations and looks for tools.
   * No download or build happens until the owner starts the setup step.
   */
  function bendBuild(): SetupStatus["bendBuild"] {
    let source: string | null = null;
    let version: string | null = null;
    for (let folder = import.meta.dirname; ; folder = dirname(folder)) {
      if (existsSync(join(folder, "bend", "go.mod"))) {
        source = join(folder, "bend");
      }
      try {
        const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === "bb-plugin-airbender") {
          version = typeof manifest.version === "string" ? manifest.version : null;
          break;
        }
      } catch {
        // Source and the dist bundle both walk up to the plugin manifest.
      }
      if (dirname(folder) === folder) break;
    }
    return planBendInstall({ platform: process.platform, arch: process.arch, version, source,
      target: join(homedir(), ".local", "bin"), hasProgram: programExists });
  }

  /** How the last setup terminal ended, per folder. */
  const setupLastRun = new Map<string, NonNullable<SetupStatus["lastRun"]>>();

  /**
   * Works out what is in place for a folder (see SetupStatus).
   *
   * Side effects: a look for bend; one run of `bend setup` unless its
   * answer is kept. Changes nothing on disk.
   */
  async function setupStatus(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<SetupStatus> {
    const nothing = {
      tracker: null,
      trackerChosen: false,
      bdInstalled: false,
      installMethods: [],
      bend: "missing" as const,
      bendBuild: { method: null, command: null, unavailable: null },
      folderReady: false,
      issuesBlocked: null,
      rulesPresent: false,
      instructions: {
        rules: "none" as const,
        rulesVersion: 0,
        currentVersion: 0,
        claudeFile: "none" as const,
        claudeRules: "none" as const,
        imports: false,
        beadsBlocks: [],
        beadsHooks: [],
        machineWide: [],
        leftovers: [],
      },
      savedFacts: [],
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
    const running = setupRunning.get(path) ?? null;
    const lastRun = setupLastRun.get(path) ?? null;
    const found = await findBend(path);
    if (found === "missing" || found === "old") {
      // Without bend nothing else can be asked. Whether beads is there is
      // still said, so that the tab does not offer to install what is.
      return {
        path,
        unavailable: null,
        ...nothing,
        bdInstalled: (await findBd(path)) !== null,
        bend: found,
        bendBuild: bendBuild(),
        running,
        lastRun,
      };
    }
    const state = await stateOf(path);
    if ("message" in state) {
      return { path, unavailable: state.message, ...nothing, bend: "ready", running, lastRun };
    }
    return {
      path,
      unavailable: null,
      bend: "ready",
      bendBuild: { method: null, command: null, unavailable: null },
      ...fromBend(state),
      running,
      lastRun,
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
      // A setup step may have made, fetched or changed the issues, and
      // may be the very thing a failed check was waiting for.
      store.stale(path);
      forget(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
    };
    void watchTerminal();
  }

  /**
   * Starts one setup action for a folder (the "setup_run" request).
   *
   * Each action is one of bend's setup steps, run with the answers the tab
   * collected, so bend asks nothing. A step that is already done, or cannot
   * be done yet, is refused by bend in its own words; those that run in a
   * terminal are checked here first, so that no terminal opens for nothing.
   *
   * @param option The install method's id (for "install"), the tracker's
   *   name (for "tracker"), the keys of the facts to carry over as a JSON
   *   list (for "facts"), or for "rules" the owner's answers as words
   *   joined by a comma: "rules:replace" or "rules:keep" for rules that
   *   were changed by hand and fell behind, "claude:link" or
   *   "claude:rules" for a CLAUDE.md of its own; null otherwise.
   * @returns `{ message: null }` once the step is done or its terminal is
   *   started; otherwise the reason in plain words.
   * Side effects: whatever the step does (see bend/internal/setup); for a
   *   terminal step, a BB terminal.
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
    if (status.path === null || (status.unavailable !== null && status.bend !== "ready")) {
      return { message: status.unavailable ?? "There is no folder to set up." };
    }
    const { path } = status;
    if (status.running !== null) {
      return { message: `"${status.running.title}" is still running.` };
    }
    if (action === "bend") {
      if (status.bend === "ready") return { message: "bend is already installed." };
      if (status.bendBuild.command === null) {
        return { message: status.bendBuild.unavailable ?? "bend cannot be installed here." };
      }
      return inTerminal(threadId, path, action, status.bendBuild.method === "download" ? "Install bend" : "Build bend", status.bendBuild.command);
    }
    if (status.bend !== "ready") return { message: "Install bend first." };

    /** Runs a step that only writes files, and tells the tabs. */
    const direct = async (args: string[]) => {
      const bend = await bendIn(path);
      if ("state" in bend) return { message: bend.message };
      try {
        await bend.run(["setup", ...args]);
      } catch (cause) {
        return { message: reasonOf(cause) };
      } finally {
        forget(path);
        trackerChanged(path);
        store.stale(path);
        bb.realtime.publish(CHANGED_CHANNEL, { path });
      }
      return { message: null };
    };
    if (action === "tracker") {
      // "github:owner/name" names the repository, for one whose remote is
      // not on github.com.
      const [use, repository] = (option ?? "").split(":", 2);
      if (use !== "beads" && use !== "github") {
        return { message: "Which tracker was not understood." };
      }
      return direct([
        "tracker",
        `--use=${use}`,
        ...(use === "github" && repository ? [`--repository=${repository}`] : []),
      ]);
    }
    if (action === "rules") {
      // Rules the owner changed by hand that fell behind the current ones:
      // the tab asked which they want, and bend is told. Anywhere else the
      // option is not needed, and bend ignores it.
      // The same for a CLAUDE.md that is a file of its own: a link, or
      // the same rules. Both answers come as words in one option,
      // "rules:keep" and "claude:link", in either order.
      const said = (option ?? "").split(",").map((word) => word.trim());
      const answer = (name: string, allowed: string[]) => {
        const value = said.find((word) => word.startsWith(`${name}:`))?.slice(name.length + 1);
        return value !== undefined && allowed.includes(value) ? [`--${name}=${value}`] : [];
      };
      return direct([
        "instructions",
        "--yes",
        ...answer("rules", ["replace", "keep"]),
        ...answer("claude", ["link", "rules"]),
      ]);
    }
    if (action === "facts") {
      let keys: unknown;
      try {
        keys = JSON.parse(option ?? "[]");
      } catch {
        keys = null;
      }
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
        return { message: "Which facts to carry over was not understood." };
      }
      return direct([
        "facts",
        ...(keys.length === 0
          ? ["--keep-none"]
          : (keys as string[]).map((key) => `--keep=${key}`)),
      ]);
    }

    // The rest run an outside program, in a terminal.
    const bend = await findBend(path);
    if (bend === "missing" || bend === "old") return { message: "Install bend first." };
    const bd = await findBd(path);
    /** bend, told which beads program the plugin found. */
    const bendCommand = `env ${bd === null ? "" : `BEND_BD=${shellQuote(bd)} `}${shellQuote(bend)} setup`;
    if (action === "install") {
      if (status.bdInstalled) return { message: "Beads is already installed." };
      const method = status.installMethods.find((candidate) => candidate.id === option);
      if (method === undefined) {
        return { message: "That way of installing is not available here." };
      }
      return inTerminal(
        threadId,
        path,
        action,
        `Install beads (${method.label})`,
        `${bendCommand} program --method ${shellQuote(method.id)} --yes`,
      );
    }
    if (action === "init" || action === "fetch") {
      if (status.folderReady) {
        return { message: "The issues are already set up in this folder." };
      }
      if (status.issuesBlocked !== null) return { message: status.issuesBlocked };
      const fetching = status.syncSteps.fetch !== null;
      if (action === "fetch" && !fetching) {
        return { message: "There are no issues to get for this folder." };
      }
      return inTerminal(
        threadId,
        path,
        action,
        fetching
          ? status.syncSteps.fetch!.label
          : status.tracker === "github"
            ? "Sign in to GitHub"
            : "Set up beads in this folder",
        `${bendCommand} issues --yes`,
      );
    }
    if (action === "sync") {
      if (status.syncSteps.on === null) {
        return {
          message: "This folder's issues are already synced, or there are none to sync.",
        };
      }
      return inTerminal(
        threadId,
        path,
        action,
        status.syncSteps.on.label,
        `${bendCommand} publish --yes`,
      );
    }
    return { message: "That setup step is not known." };
  }

  /** Opens the terminal for a step; the reason in plain words when it cannot. */
  async function inTerminal(
    threadId: string | null,
    path: string,
    action: SetupAction,
    title: string,
    command: string,
  ): Promise<{ message: string | null }> {
    try {
      await runInTerminal({ threadId, path, action, title, command });
    } catch (cause) {
      return { message: `The terminal could not be opened: ${reasonOf(cause)}` };
    }
    return { message: null };
  }

  return { setupStatus, runSetup };
}
