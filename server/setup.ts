// server/setup.ts — getting a folder ready for Airbender.
//
// What: works out what is and is not in place for a folder (the beads program,
// beads in the folder, Airbender's instructions for agents, the saved facts)
// and runs the action that sets one of them up.
//
// Why: when something the tab needs is missing, the tab offers to set it up
// instead of leaving the user at a dead end (bead-bb-80e).
//
// Design notes:
// - Install and folder setup run in a BB terminal the user can watch and
//   type into: an install may ask for a password, and the user should see
//   what is done to their machine.
// - Beads' own instructions for agents are not set up, and are taken out
//   where they are (bead-bb-c9l.8). They tell an agent to close an issue
//   when it is done and print a "session close protocol" at the start of
//   every session, which is the opposite of the workflow. So the folder is
//   set up with `bd init --skip-agents`, and the instructions step removes
//   what an earlier setup left: beads' marked blocks from AGENTS.md and
//   CLAUDE.md here, and beads' hooks with beads' own `bd setup <agent>
//   --remove`. Text beads wrote without markers is only named.
// - Standing facts are kept in FACTS.md, which bend looks after (its
//   `facts` and `recall` commands; server/bend.ts runs them). Facts saved
//   in beads are shown once for the owner to choose from; a line at the top
//   of FACTS.md records that they were looked at, so the offer does not
//   come back on another computer.
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
import { CHANGED_CHANNEL, SETUP_AGENTS } from "../shared/constants.ts";
import type { SetupAction } from "../shared/constants.ts";
import { programExists, runBd, shellQuote } from "./bd.ts";
import type { SetupStatus } from "./contract.ts";
import type { Fact, Trackers } from "./bend.ts";
import {
  FACTS_FILE,
  agentsFileWith,
  beadsLeftovers,
  claudeFileFor,
  hasBeadsBlocks,
  rulesIn,
  withoutBeadsBlocks,
} from "./prompts.ts";
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

/** How often a running setup terminal is checked, and for how long at most. */
const SETUP_POLL_MS = 1500;

const SETUP_TIMEOUT_MS = 15 * 60_000;

/**
 * The line at the top of a facts file that says the facts saved in beads
 * were looked at, so they are not offered again. In the file, and not in
 * the plugin's own storage, so that it holds on every computer the
 * repository is used on. An HTML comment: agents and people reading the
 * file as text see through it.
 */
const FACTS_REVIEWED = "<!-- airbender: the facts saved in beads were reviewed -->";

/**
 * The facts saved in beads, from what `bd memories --json` printed: one
 * object, key to text, with the schema's version beside them. Pure.
 *
 * @returns None when the output is not that object.
 */
export function savedFactsFrom(stdout: string): { key: string; text: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  return Object.entries(parsed).flatMap(([key, text]) =>
    key !== "schema_version" && typeof text === "string" ? [{ key, text }] : [],
  );
}

/** The reason in something thrown, without the word "Error:". */
const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** A file's text; "" when there is no such file or it cannot be read. */
function textOf(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
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
  syncSteps,
}: {
  bb: BbPluginApi;
  folders: Folders;
  store: Store;
  /** How to run bend in a folder (server/bend.ts). */
  bendIn: Trackers["bendIn"];
  /** The setup steps the folder's issue sync offers now (server/sync.ts). */
  syncSteps: (
    path: string,
  ) => Promise<{ on: SyncStep | null; fetch: SyncStep | null }>;
}) {
  const { resolveFolder, findBd, findBend } = folders;
  const { readIssues } = store;
  /** The setup action running in a terminal, per folder. */
  const setupRunning = new Map<
    string,
    { action: SetupAction; title: string }
  >();

  /**
   * The setup conditions already found met, per folder: the working beads
   * program, the folder set up, the instructions in place, the saved facts
   * looked at. Kept only while the plugin runs; a reload checks everything
   * once more.
   */
  const setupMet = new Map<
    string,
    {
      bd: string | null;
      bend: boolean;
      folder: boolean;
      rules: boolean;
      facts: boolean;
    }
  >();

  /**
   * The coding agents beads' own hooks are installed for, in a repository.
   *
   * Read from the files the hooks are in, not asked of beads. Beads' own
   * check (`bd setup <agent> --check`) answers for its whole integration:
   * once its block is out of CLAUDE.md it says "not installed" while the
   * session-start hook is still there, and the step would have called
   * itself done with the hook left behind (found by the test in
   * server/setup.test.ts). The hook is the part that matters here: it is
   * what prints beads' instructions into every session.
   *
   * @param home The repository's main folder, not a work tree
   *   (bead-bb-ak0): Claude Code's hooks are in a file git does not track,
   *   so a work tree never has them.
   * Side effects: reads up to three small files.
   */
  function beadsHooksIn(home: string) {
    /**
     * Where each agent's hooks are, and the command beads puts there. The
     * same places under the owner's home folder are where beads installs
     * them for the whole computer (`bd setup <agent> --global`).
     */
    const places: Record<string, { files: string[]; sign: RegExp }> = {
      claude: {
        files: [
          join(home, ".claude", "settings.json"),
          join(home, ".claude", "settings.local.json"),
        ],
        sign: /\bbd prime\b/u,
      },
      codex: {
        files: [join(home, ".codex", "hooks.json")],
        sign: /\bbd codex-hook\b/u,
      },
    };
    return SETUP_AGENTS.filter((agent) => {
      const place = places[agent.id];
      return (
        place !== undefined &&
        place.files.some((file) => place.sign.test(textOf(file)))
      );
    });
  }

  /**
   * How bend is built on this machine: the command for a terminal, or why
   * it cannot be built here.
   *
   * The source is the `bend` folder that comes with the plugin, found from
   * where this file is (it may be run from the plugin's folder or from its
   * build output inside that folder). The program goes into the owner's own
   * commands folder, which is where the plugin looks for it next to the
   * PATH.
   *
   * Side effects: looks for the Go program and reads the file system.
   */
  function bendBuild(): SetupStatus["bendBuild"] {
    let source: string | null = null;
    for (let folder = import.meta.dirname; ; folder = dirname(folder)) {
      if (existsSync(join(folder, "bend", "go.mod"))) {
        source = join(folder, "bend");
        break;
      }
      if (dirname(folder) === folder) break;
    }
    if (source === null) {
      return {
        command: null,
        unavailable:
          "bend's source did not come with this copy of the plugin. Build bend from the Airbender repository (go build ./cmd/bend in its bend folder) and put it on the PATH.",
      };
    }
    if (!programExists("go")) {
      return {
        command: null,
        unavailable:
          "bend is built with Go, which is not on this computer. Install Go (go.dev/dl), then come back to this step.",
      };
    }
    const target = join(homedir(), ".local", "bin");
    return {
      // GOROOT is cleared for the build: Go finds its own files without
      // it, and one left pointing at a version that is no longer installed
      // (a version manager does that) makes every go command fail.
      command: `mkdir -p ${shellQuote(target)} && env -u GOROOT go build -C ${shellQuote(source)} -o ${shellQuote(join(target, "bend"))} ./cmd/bend && echo ${shellQuote(`bend is built: ${join(target, "bend")}`)}`,
      unavailable: null,
    };
  }

  /**
   * Runs bend's `facts` command in a folder; it needs no tracker there.
   *
   * @throws When bend is missing or the command fails; the message says why.
   * Side effects: may write FACTS.md and AGENTS.md in the folder.
   */
  async function lookAfterFacts(
    path: string,
    args: string[],
    input?: string,
  ): Promise<void> {
    const bend = await bendIn(path);
    if ("state" in bend) throw new Error(bend.message);
    await bend.run(["facts", ...args], input);
  }

  /** The facts the folder's facts file holds; none when they cannot be read. */
  async function factsIn(path: string): Promise<Fact[]> {
    const bend = await bendIn(path);
    if ("state" in bend) return [];
    try {
      // This folder's own file, which is the one the facts are added to.
      return (await bend.run(["facts", "--list"])) as Fact[];
    } catch {
      return [];
    }
  }

  /** How the last setup terminal ended, per folder. */
  const setupLastRun = new Map<string, NonNullable<SetupStatus["lastRun"]>>();

  /**
   * Works out what is in place for a folder (see SetupStatus).
   *
   * Side effects: for each condition not yet known to be met, one check (bd
   * version, bd list, a read of the instruction and hook files, the saved
   * facts); none for conditions already met. Changes nothing on disk.
   */
  async function setupStatus(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<SetupStatus> {
    const nothing = {
      bdInstalled: false,
      installMethods: [],
      bend: "missing" as const,
      bendBuild: { command: null, unavailable: null },
      folderReady: false,
      rulesPresent: false,
      instructions: {
        rules: "none" as const,
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
    // A condition that was found met is not checked again (the user's
    // rule): setup only ever moves forward in practice, and detecting that
    // something was taken away again is not worth a check on every refresh.
    // What is still unmet is checked every time. So a folder that is fully
    // set up costs no bd runs here at all.
    const met = setupMet.get(path) ?? {
      bd: null,
      bend: false,
      folder: false,
      rules: false,
      facts: false,
    };
    setupMet.set(path, met);
    met.bd ??= await findBd(path);
    const bd = met.bd;
    let bend: SetupStatus["bend"] = "ready";
    if (!met.bend) {
      const found = await findBend(path);
      if (found === "missing" || found === "old") bend = found;
      else met.bend = true;
    }
    // Without bend the folder cannot be asked anything.
    if (bd !== null && met.bend && !met.folder) {
      // "Set up" means what listing issues means by it, so the panel and
      // the list agree: bd finds a database from this folder upward.
      met.folder = (await readIssues(path)).state === "ok";
    }
    const folderReady = met.folder;
    // What the instructions step would find. Once it is done nothing is
    // looked at again, and the answer is "all in place".
    let instructions: SetupStatus["instructions"] = {
      rules: "current",
      beadsBlocks: [],
      beadsHooks: [],
      machineWide: [],
      leftovers: [],
    };
    if (!met.rules) {
      const agentsText = textOf(join(path, "AGENTS.md"));
      const claudeFile = join(path, "CLAUDE.md");
      const claudeText = existsSync(claudeFile) ? textOf(claudeFile) : null;
      const hooks = beadsHooksIn((await folders.mainFolder(path)) ?? path);
      instructions = {
        rules: rulesIn(agentsText),
        beadsBlocks: [
          ...(hasBeadsBlocks(agentsText) ? ["AGENTS.md"] : []),
          ...(claudeText !== null && hasBeadsBlocks(claudeText)
            ? ["CLAUDE.md"]
            : []),
        ],
        beadsHooks: hooks.map((agent) => agent.label),
        // Not the repository's, so not removed and not part of "done";
        // only named. Not asked when the repository's main folder is the
        // home folder itself, where the two are the same files.
        machineWide:
          ((await folders.mainFolder(path)) ?? path) === homedir()
            ? []
            : beadsHooksIn(homedir()).map((agent) => agent.label),
        leftovers: beadsLeftovers(withoutBeadsBlocks(agentsText)),
      };
      // Done when the rules are there (ours, or the owner's own version of
      // them), nothing of beads' that can be removed is left, and a
      // CLAUDE.md, where there is one, needs no change (see claudeFileFor).
      met.rules =
        (instructions.rules === "current" || instructions.rules === "edited") &&
        instructions.beadsBlocks.length === 0 &&
        instructions.beadsHooks.length === 0 &&
        claudeFileFor(claudeText) === null;
    }
    const rulesPresent = met.rules;
    // The facts saved in beads that the facts file does not hold, until
    // the owner has looked at them once.
    let savedFacts: SetupStatus["savedFacts"] = [];
    if (!met.facts && bd !== null && folderReady) {
      if (textOf(join(path, FACTS_FILE)).includes(FACTS_REVIEWED)) {
        met.facts = true;
      } else {
        const listed = await runBd(bd, ["--readonly", "memories", "--json"], path);
        const held = new Set((await factsIn(path)).map((fact) => fact.key));
        savedFacts =
          listed.kind === "ok"
            ? savedFactsFrom(listed.stdout).filter((fact) => !held.has(fact.key))
            : [];
      }
    }
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
    return {
      path,
      unavailable: null,
      bdInstalled: bd !== null,
      installMethods: INSTALL_METHODS.filter((method) =>
        programExists(method.needs),
      ).map(({ id, label, command }) => ({ id, label, command })),
      bend,
      bendBuild: bend === "ready" ? { command: null, unavailable: null } : bendBuild(),
      folderReady,
      rulesPresent,
      instructions,
      savedFacts,
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
      // A setup step may have made, fetched or changed the issues, and
      // may be the very thing a failed check was waiting for.
      store.stale(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
    };
    void watchTerminal();
  }

  /**
   * Starts one setup action for a folder (the "setup_run" request).
   *
   * Each action is refused when it is already done or cannot be done yet;
   * the tab greys those out, and this is the same rule on the side that
   * actually runs things. Install and folder setup run in a visible
   * terminal; the instructions and the facts are written straight into the
   * folder.
   *
   * @param option The install method's id (for "install"), or the keys of
   *   the facts to carry over as a JSON list (for "facts"); null otherwise.
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
        return { message: "Airbender's instructions are already in place." };
      }
      const file = join(path, "AGENTS.md");
      try {
        // Facts an earlier version kept in a section of AGENTS.md go to
        // the facts file first, so that the file is rewritten once more
        // below with that section already out.
        await lookAfterFacts(path, ["--move-old"]);
        const existing = textOf(file);
        // Beads' marked blocks out, then Airbender's rules in: added at
        // the end, or an earlier version of ours replaced where it stands.
        // A rules block the owner edited is left as it is.
        const next = agentsFileWith(withoutBeadsBlocks(existing));
        if (next !== existing) writeFileSync(file, next);
        // The rules, and a CLAUDE.md, point at the facts file.
        await lookAfterFacts(path, ["--ensure"]);
      } catch (cause) {
        return { message: `AGENTS.md could not be written: ${reasonOf(cause)}` };
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
      // Beads' hooks, with beads' own way of removing them. After the
      // files, so that a failure here leaves the instructions right.
      const home = (await folders.mainFolder(path)) ?? path;
      const bd = await findBd(path);
      for (const agent of beadsHooksIn(home)) {
        const removed =
          bd === null
            ? null
            : await runBd(bd, ["setup", agent.id, "--remove"], home);
        // Believed only when the hook is really gone from its file.
        if (beadsHooksIn(home).some((left) => left.id === agent.id)) {
          setupMet.delete(path);
          bb.realtime.publish(CHANGED_CHANNEL, { path });
          return {
            message: `The instructions are written, but beads' hook for ${agent.label} is still there: ${removed === null ? "the beads program, which removes it, was not found." : removed.kind === "failed" ? removed.message : "beads' own removal left it in place."}`,
          };
        }
      }
      setupMet.delete(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
      return { message: null };
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
      const chosen = status.savedFacts.filter((fact) => keys.includes(fact.key));
      const file = join(path, FACTS_FILE);
      try {
        await lookAfterFacts(
          path,
          [...(chosen.length > 0 ? ["--add-file", "-"] : []), "--ensure"],
          JSON.stringify(chosen),
        );
        // Looked at, whatever was chosen: not offered again.
        const text = readFileSync(file, "utf8");
        if (!text.includes(FACTS_REVIEWED)) {
          writeFileSync(file, `${FACTS_REVIEWED}\n${text}`);
        }
      } catch (cause) {
        return { message: `${FACTS_FILE} could not be written: ${reasonOf(cause)}` };
      }
      setupMet.delete(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
      return { message: null };
    }
    let title: string;
    let command: string;
    if (action === "install") {
      if (status.bdInstalled) return { message: "Beads is already installed." };
      const method = status.installMethods.find(
        (candidate) => candidate.id === option,
      );
      if (method === undefined) {
        return { message: "That way of installing is not available here." };
      }
      title = `Install beads (${method.label})`;
      command = method.command;
    } else if (action === "bend") {
      if (status.bend === "ready") return { message: "bend is already built." };
      if (status.bendBuild.command === null) {
        return { message: status.bendBuild.unavailable ?? "bend cannot be built here." };
      }
      title = "Build bend";
      command = status.bendBuild.command;
    } else {
      const bd = await findBd(path);
      if (bd === null) return { message: "Install beads first." };
      // Without bend the folder cannot be asked whether it has issues, so
      // "not set up" is not known: setting it up could run on a repository
      // that already has them.
      if (status.bend !== "ready") return { message: "Build bend first." };
      if (action === "init") {
        if (status.folderReady) {
          return { message: "Beads is already set up in this folder." };
        }
        title = "Set up beads in this folder";
        // Without beads' own instructions for agents; see the header.
        command = `${shellQuote(bd)} init --skip-agents`;
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
        return { message: "That setup step is not known." };
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
