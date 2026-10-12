// app/setup.tsx — getting a folder ready for Airbender.
//
// What: the setup steps worked out from the backend's status, the hook that
// loads the status and remembers skipped steps, the card in the middle of the
// tab, the "more" menu in the toolbar, and the confirmation dialog.
//
// Why: when something the tab needs is missing (the beads program, beads in
// the folder, Airbender's instructions for agents) the tab offers to set it
// up instead of leaving the user at a dead end (bead-bb-80e). Beads' own
// setup for a coding agent is no longer among them: its instructions
// contradict the workflow, and the instructions step takes them out
// (bead-bb-c9l.8).
//
// Design notes:
// - One list of steps (setupSteps) drives both the card and the menu, so they
//   cannot disagree.
// - The status is asked for on every refresh; that is cheap because the
//   backend stops checking a condition once it is met.

import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type {
  IssuesResult,
  SetupStatus,
  rpcContract,
} from "../server/contract.ts";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { SetupAction } from "../shared/constants.ts";
import { MenuPanel, useMenu } from "./menus.tsx";
import type { Scope } from "./use-issues.ts";
import { WORKFLOW_CHOICES } from "../shared/workflows.ts";
import type { WorkflowId } from "../shared/workflows.ts";

/**
 * One thing that can be set up for a folder (bead-bb-80e), worked out from
 * the server's SetupStatus for both the setup card and the "more" menu.
 */
export interface SetupStep {
  /** Unique per step; also what "Skip" remembers. E.g. "rules". */
  key: string;
  action: SetupAction;
  /** Nothing today; kept for a step that carries a fixed choice. */
  option: string | null;
  /** The button and menu label. */
  label: string;
  /** One line on what it is for, shown on the card. */
  why: string;
  /** Not yet in place, and possible right now: offered on the card. */
  needed: boolean;
  /**
   * The step updates something that was set up before, where nothing is
   * missing: the card then says the folder is set up and has an update.
   */
  update?: boolean;
  /**
   * Why it cannot be started, in a word or two ("done", "install beads
   * first"); null when it can. The menu greys the item and shows this.
   */
  blocked: string | null;
  /**
   * For a step whose words come from elsewhere (the issue sync's): what
   * the confirmation says it does, an opening line and points. Text in
   * backticks is a command or a file name.
   */
  explain?: { lead: string; points: string[] };
}

/** A sentence with its `backticked` parts in the code font. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Whether the instructions step has something of beads' to take out. */
/**
 * Whether the rules for agents in the folder were changed by hand and are
 * from an earlier version than the current one: the owner then chooses
 * between the current rules and their own (bead-bb-c9l.10).
 */
const rulesBehind = (status: SetupStatus | null): boolean =>
  status?.instructions.rules === "behind";

/**
 * Whether the folder has Airbender's rules already and they are only not
 * the current ones: an earlier version of ours, or the owner's own from an
 * earlier version. The step is then an update, and is said as one: the
 * owner set the folder up before, and "get this folder ready" read as if
 * that had been lost (bead-bb-c9l.10).
 */
const rulesUpdate = (status: SetupStatus | null) =>
  status?.instructions.rules === "old" || status?.instructions.rules === "behind";

const replacesBeads = (status: SetupStatus | null) =>
  status !== null &&
  (status.instructions.beadsBlocks.length > 0 ||
    status.instructions.beadsHooks.length > 0);

/** The setup steps for a folder, in the order they make sense. */
function setupSteps(status: SetupStatus): SetupStep[] {
  const running = status.running === null ? null : "running…";
  // Without bend the folder cannot be asked whether it has issues, so the
  // steps that depend on that answer wait for it.
  const bendReady = status.bend === "ready";
  // With GitHub issues there is no database to make: the step is signing in.
  const onGitHub = status.tracker === "github";
  const steps: SetupStep[] = [
    {
      key: "tracker",
      action: "tracker",
      option: null,
      label: "Choose where the issues are kept",
      why: "Nothing says yet where this repository's issues are kept: in beads, a database inside the repository, or in GitHub issues.",
      needed: bendReady && !status.trackerChosen,
      blocked: status.trackerChosen
        ? (status.tracker ?? "chosen")
        : !bendReady
          ? "build bend first"
          : running,
    },
    {
      key: "install",
      action: "install",
      option: null,
      label: "Install beads",
      why: "The beads program is not on this computer. The tab needs it to read and change issues.",
      // It is bend that installs it, so bend comes first.
      needed: !status.bdInstalled && status.trackerChosen && bendReady,
      blocked: status.bdInstalled
        ? onGitHub
          ? "not needed"
          : "installed"
        : bendReady && !status.trackerChosen
          ? "choose the tracker first"
          : status.installMethods.length === 0 && bendReady
            ? "no installer found"
            : !bendReady
              ? "build bend first"
              : running,
    },
    {
      key: "bend",
      action: "bend",
      option: null,
      label: status.bend === "old" ? "Build bend again" : "Build bend",
      // Where it cannot be built the reason is said here, in the step's
      // own words: a step that cannot be started opens no confirmation.
      why:
        (status.bend === "old"
          ? "The bend program on this computer is older than this version of Airbender needs. The tab reads and changes issues with it."
          : "The bend program is not on this computer. The tab reads and changes issues with it.") +
        (status.bend !== "ready" && status.bendBuild.command === null
          ? ` ${status.bendBuild.unavailable ?? ""}`
          : ""),
      needed: status.bend !== "ready",
      blocked:
        status.bend === "ready"
          ? "built"
          : status.bendBuild.command === null
            ? "cannot be built here"
            : running,
      explain: {
        lead:
          status.bendBuild.command === null
            ? (status.bendBuild.unavailable ?? "bend cannot be built here.")
            : "Builds bend from the source that comes with Airbender, and puts it in your own commands folder:",
        points:
          status.bendBuild.command === null
            ? []
            : [
                `\`${status.bendBuild.command}\``,
                "Nothing in the repository changes.",
                "bend is one program with nothing beside it; you can also run it yourself in a terminal: `bend --help`.",
              ],
      },
    },
    // A folder with no issues gets one of two steps: fetch them, where
    // the folder's issue sync says its remote already holds them (a fresh
    // clone, bead-bb-0bz), or start empty. What the fetch step is called
    // and says is the sync source's, not written here: another tracker's
    // differs (bead-bb-6a9).
    status.syncSteps.fetch !== null && !status.folderReady
      ? {
          key: "fetch",
          action: "fetch" as const,
          option: null,
          label: status.syncSteps.fetch.label,
          why: status.syncSteps.fetch.why,
          needed: status.bdInstalled && bendReady,
          blocked: !status.bdInstalled
            ? "install beads first"
            : !bendReady
              ? "build bend first"
              : running,
          explain: status.syncSteps.fetch.explain,
        }
      : {
          key: "init",
          action: "init" as const,
          option: null,
          label: onGitHub ? "Sign in to GitHub" : "Set up beads in this folder",
          // Where it cannot be done, the reason is said here: a step that
          // cannot be started opens no confirmation to say it in.
          why:
            status.issuesBlocked !== null && status.bdInstalled && status.trackerChosen
              ? status.issuesBlocked
              : onGitHub
                ? "There is no GitHub login on this computer. Issues on GitHub are read and changed as you."
                : "This folder has no issue database yet. Setting it up lets you track issues here.",
          needed:
            status.bdInstalled && bendReady && status.trackerChosen && !status.folderReady,
          blocked: status.folderReady
            ? "done"
            : !bendReady
              ? "build bend first"
              : !status.trackerChosen
                ? "choose the tracker first"
                : !status.bdInstalled
                  ? "install beads first"
                  : status.issuesBlocked !== null
                    ? "not possible yet"
                    : running,
          // Signing in has words of its own; setting beads up keeps the
          // confirmation written for it.
          ...(onGitHub
            ? {
                explain: {
                  lead: "Runs `gh auth login` in a terminal.",
                  points: [
                    "GitHub's own program asks how you want to sign in and opens a browser.",
                    "Instead you can set a token yourself in the environment, as `GH_TOKEN`.",
                  ],
                },
              }
            : {}),
        },
    {
      key: "rules",
      action: "rules",
      option: null,
      // Named for what it will do here: a repository set up the old way
      // has beads' instructions to take out, a new one only gets ours.
      label: replacesBeads(status)
        ? "Replace beads' instructions with Airbender's"
        : rulesUpdate(status)
          ? "Update Airbender's instructions for agents"
          : "Add Airbender's instructions for agents",
      // An update, not a first setup: said differently on the card.
      update: !replacesBeads(status) && rulesUpdate(status),
      why: replacesBeads(status)
        ? "Beads wrote instructions of its own into this folder. They tell agents to close issues themselves, which is the opposite of how this tab works. This takes them out and leaves Airbender's."
        : rulesBehind(status)
          ? `The rules for agents in AGENTS.md were changed by hand here, and Airbender's own rules have changed since (${status.instructions.rulesVersion > 0 ? `yours are from version ${status.instructions.rulesVersion}` : "yours name no version"}, the current ones are version ${status.instructions.currentVersion}). Agents here work by the earlier rules until you choose.`
          : status.instructions.rules === "old"
            ? `Airbender's rules for agents have changed since this folder was set up: it has ${status.instructions.rulesVersion > 0 ? `version ${status.instructions.rulesVersion}` : "an earlier version"}, the current ones are version ${status.instructions.currentVersion}. Nothing is wrong here; this brings them up to date.`
            : "The rules this tab's buttons rely on: agents take an issue one step at a time, leave closing to you, and commit when you accept it.",
      needed: status.folderReady && !status.rulesPresent,
      blocked: status.rulesPresent
        ? "done"
        : !status.folderReady
          ? "set up the folder first"
          : running,
    },
    // Facts saved in beads, which agents no longer see at the start of a
    // session: offered once, for the owner to choose which go to the facts
    // file. Listed only while there are any to choose from.
    ...(status.savedFacts.length === 0
      ? []
      : [
          {
            key: "facts",
            action: "facts" as const,
            option: null,
            label: "Carry saved facts over",
            why: `Beads holds ${status.savedFacts.length === 1 ? "a saved fact" : `${status.savedFacts.length} saved facts`} that agents used to be shown when a session started. Choose which go into FACTS.md, where agents read them now.`,
            needed: status.folderReady && status.rulesPresent,
            blocked: !status.rulesPresent ? "add the instructions first" : running,
          },
        ]),
    // Switching the issue sync on, while the source offers it: listed
    // only then, since what it is called is the source's to say. Once on,
    // the "Issue sync" row above the steps says how it stands.
    ...(status.syncSteps.on === null
      ? []
      : [
          {
            key: "sync",
            action: "sync" as const,
            option: null,
            label: status.syncSteps.on.label,
            why: status.syncSteps.on.why,
            needed: status.folderReady,
            blocked: !status.folderReady ? "set up the folder first" : running,
            explain: status.syncSteps.on.explain,
          },
        ]),
  ];
  return steps;
}

/**
 * Loads what is and is not set up for the tab's folder, and remembers which
 * steps the user skipped.
 *
 * Asked for again whenever the issue list is: when its state changes, on
 * every change notice, and when the user presses Refresh or opens the
 * "more" menu. That is cheap because the server stops checking a condition
 * once it is met; only what is still missing is looked at again.
 *
 * Skips are kept per folder in this browser's local storage, like the
 * filter: skipping is a view preference ("stop showing me this"), and a
 * skipped step stays available in the "more" menu.
 *
 * @returns `status` (null until the first answer), `reload`, the skipped
 *   step keys and `skip` to add one.
 */
export function useSetup(scope: Scope, state: IssuesResult["state"] | null) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const reload = useCallback(() => {
    rpc.call("setup_status", { threadId, projectId }).then(setStatus, () => {
      // Without an answer nothing is offered; the list's own message stands.
    });
  }, [rpc, threadId, projectId]);
  useEffect(() => {
    if (state !== null) reload();
  }, [reload, state]);
  useRealtime(CHANGED_CHANNEL, reload);
  useEffect(() => {
    // Like the issue list: coming back to BB is when things have changed.
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  const storageKey =
    status?.path == null ? null : `bb-plugin-airbender:setup-skipped:${status.path}`;
  const [skipped, setSkipped] = useState<string[]>([]);
  useEffect(() => {
    if (storageKey === null) return;
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "[]",
      );
      setSkipped(
        Array.isArray(stored)
          ? stored.filter((key): key is string => typeof key === "string")
          : [],
      );
    } catch {
      setSkipped([]);
    }
  }, [storageKey]);
  const skip = (key: string) => {
    const next = skipped.includes(key) ? skipped : [...skipped, key];
    setSkipped(next);
    if (storageKey === null) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage full or disabled: the skip lasts until the tab is reopened.
    }
  };
  return { status, reload, skipped, skip };
}

/**
 * The setup card, in the middle of the tab: the steps that are missing and
 * were not skipped, each with its button and a Skip.
 *
 * The user's rule: what is missing is offered here, in the centre, not
 * tucked into a menu; pressing Skip takes a step off the card, and from
 * then on it is only in the "more" menu. Also shown here: the terminal run
 * in progress, and a run that failed, with the last lines it printed, so a
 * failure can be read without finding the terminal.
 *
 * Draws nothing when there is nothing to say.
 */
export function SetupCard({
  status,
  skipped,
  onSkip,
  onStart,
}: {
  status: SetupStatus;
  skipped: string[];
  onSkip: (key: string) => void;
  /** Opens the confirmation for a step. */
  onStart: (step: SetupStep) => void;
}) {
  const offered = setupSteps(status).filter(
    (step) => step.needed && !skipped.includes(step.key),
  );
  const failed =
    status.lastRun !== null && status.lastRun.exitCode !== 0
      ? status.lastRun
      : null;
  if (offered.length === 0 && status.running === null && failed === null) {
    return null;
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      {offered.length === 0 ? null : (
        <div className="text-sm font-medium">
          {/* Nothing but updates to offer: the folder is ready, and is
              said to be. */}
          {offered.every((step) => step.update === true)
            ? "This folder is set up. Airbender has an update for it"
            : "Get this folder ready for Airbender"}
        </div>
      )}
      {status.running === null ? null : (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Icon name="Loading" className="size-4 animate-spin" />
          <span>
            Running in a terminal:{" "}
            <span className="font-medium">{status.running.title}</span>. Open
            BB's terminal to watch it or to answer its questions.
          </span>
        </p>
      )}
      {failed === null ? null : (
        <div role="alert" className="space-y-1 text-sm">
          <p className="text-destructive">
            "{failed.title}" did not finish
            {failed.exitCode === null ? "" : ` (exit code ${failed.exitCode})`}.
            You can try again.
          </p>
          {failed.tail === "" ? null : (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
              {failed.tail}
            </pre>
          )}
        </div>
      )}
      {offered.map((step) => (
        <div key={step.key} className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{step.why}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={step.blocked !== null}
              onClick={() => onStart(step)}
            >
              {step.label}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              tip="Take this off the card. It stays in the menu at the top right."
              onClick={() => onSkip(step.key)}
            >
              Skip
            </Button>
          </div>
          {step.blocked === null || step.blocked === "running…" ? null : (
            <p className="text-xs text-muted-foreground">
              Not possible here: {step.blocked}.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The "more" menu at the right end of the toolbar: every setup step, so any
 * of them can be started by hand, also after it was skipped on the card.
 *
 * A step that is already done, or cannot be done yet, is greyed out with
 * the reason beside it (the user's rule), so the menu doubles as a view of
 * what is in place.
 *
 * It also holds the choice of workflow for the repository (the user: "as a
 * part of the menu ... because it's not gonna be often"), above the setup
 * steps, with a tick on the one in use.
 *
 * @param workflow The workflow in use, or null when there is no folder with
 *   beads to choose one for; the choice is then not shown.
 * @param onChooseWorkflow Called with the choice the user picked.
 */
export function SetupMenu({
  status,
  onOpen,
  onStart,
  workflow,
  onChooseWorkflow,
  onSyncGithub,
  issueSync,
}: {
  status: SetupStatus | null;
  /** Called when the menu opens, to fetch a fresh status. */
  onOpen: () => void;
  onStart: (step: SetupStep) => void;
  workflow: WorkflowId | null;
  onChooseWorkflow: (id: WorkflowId) => void;
  /**
   * Opens the "Sync with GitHub" window; left out where there are no
   * issues to sync (no folder with beads).
   */
  onSyncGithub?: () => void;
  /**
   * How the issues' sync stands, for its row: the state in a word or two,
   * a longer message when there is something to read, and the way to its
   * log. Left out where there is no folder with issues.
   */
  issueSync?: { state: string; message: string | null; onLog: () => void };
}) {
  const { open, setOpen, root } = useMenu();
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        tip="Workflow and setup for this folder"
        aria-label="Workflow and setup menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen((current) => !current);
        }}
      >
        {/* Three dots, drawn here: BB's icon set has no "more" icon. */}
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="size-4"
        >
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </Button>
      {open ? (
        <MenuPanel className="w-80 max-w-[85vw]">
          {workflow === null ? null : (
            <>
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                Workflow
              </div>
              {WORKFLOW_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={choice.id === workflow}
                  onClick={() => {
                    setOpen(false);
                    if (choice.id !== workflow) onChooseWorkflow(choice.id);
                  }}
                  className="flex w-full cursor-pointer items-start gap-2 rounded px-2 py-1 text-left text-sm hover:bg-state-hover"
                >
                  {/* The tick's place is kept on the other entry, so the
                      two labels line up. */}
                  <Icon
                    name="Check"
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      choice.id !== workflow && "invisible",
                    )}
                  />
                  <span className="min-w-0">
                    {choice.label}
                    <span className="block text-xs text-muted-foreground">
                      {choice.hint}
                    </span>
                  </span>
                </button>
              ))}
              <div className="my-1 border-t border-border" />
            </>
          )}
          {/* Syncing with GitHub issues (bead-bb-rh3): an occasional task,
              so it lives here and opens a window of its own. */}
          {onSyncGithub === undefined ? null : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSyncGithub();
                }}
                className="flex w-full cursor-pointer items-start rounded px-2 py-1 text-left text-sm hover:bg-state-hover"
              >
                <span className="min-w-0">
                  Sync with GitHub…
                  <span className="block text-xs text-muted-foreground">
                    Bring GitHub issues in, or send issues to GitHub. You
                    choose which, and see a preview first.
                  </span>
                </span>
              </button>
              <div className="my-1 border-t border-border" />
            </>
          )}
          {/* The issues' own sync with the repository's remote
              (bead-bb-0bz): when it last happened, or what went wrong. Only
              said here: syncing runs by itself, and the refresh button
              asks for one (the user: "the rest is in the menu"). */}
          {issueSync === undefined ? null : (
            <>
              {/* One row, the state at the right like a setup step's
                  "done" (the user: "Similar to how setup works, install
                  beads, it says installed. The same: issue sync, it was
                  synced one minute ago"). Not a button: syncing runs by
                  itself, and refresh asks for one. */}
              <div className="flex items-baseline justify-between gap-3 px-2 py-1 text-sm">
                <span className="min-w-0">Issue sync</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {issueSync.state}
                </span>
              </div>
              {issueSync.message === null ? null : (
                <p className="whitespace-pre-wrap px-2 pb-1 text-xs text-muted-foreground">
                  {issueSync.message}
                </p>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  issueSync.onLog();
                }}
                className="flex w-full cursor-pointer items-start rounded px-2 py-1 text-left text-sm hover:bg-state-hover"
              >
                Sync log…
              </button>
              <div className="my-1 border-t border-border" />
            </>
          )}
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            Setup
          </div>
          {status === null ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">Checking…</p>
          ) : status.unavailable !== null ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">
              {status.unavailable}
            </p>
          ) : (
            setupSteps(status).map((step) => (
              <button
                key={step.key}
                type="button"
                role="menuitem"
                disabled={step.blocked !== null}
                onClick={() => {
                  setOpen(false);
                  onStart(step);
                }}
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded px-2 py-1 text-left text-sm hover:bg-state-hover disabled:cursor-default disabled:text-muted-foreground/60 disabled:hover:bg-transparent"
              >
                <span className="min-w-0">{step.label}</span>
                {step.blocked === null ? null : (
                  <span className="shrink-0 text-xs">{step.blocked}</span>
                )}
              </button>
            ))
          )}
          {/* Where the plugin's settings are. In words, because a tab has
              no way to open that page (asked of BB in get-bb/bb#5014); the
              user asked to be directed there from here. */}
          <div className="my-1 border-t border-border" />
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Settings (background sizing and its model, the bd command, the
            GitHub token): in BB under Tools, then Airbender.
          </p>
        </MenuPanel>
      ) : null}
    </div>
  );
}

/**
 * The confirmation before a setup step runs: what it will do, and the exact
 * command where there is one, so nothing is done to the machine or the
 * repository unseen. For installing, the user picks the method here (their
 * choice: "let me choose each time").
 *
 * @param step The step to confirm; null keeps the dialog closed.
 * @param onRun Called with the chosen option: the install method's id, the
 *   keys of the facts to carry over (a JSON list), or null.
 */
export function SetupDialog({
  step,
  status,
  onRun,
  onClose,
}: {
  step: SetupStep | null;
  status: SetupStatus | null;
  onRun: (step: SetupStep, option: string | null) => void;
  onClose: () => void;
}) {
  const methods = status?.installMethods ?? [];
  const [methodId, setMethodId] = useState<string | null>(null);
  // The tracker step: beads unless the other is picked.
  const [trackerId, setTrackerId] = useState<"beads" | "github">("beads");
  // The instructions step, where the rules were changed by hand and fell
  // behind: nothing is chosen for the owner, since either answer changes
  // or keeps their own text.
  const [rulesChoice, setRulesChoice] = useState<"replace" | "keep" | null>(null);
  // Asked afresh every time the window opens: a choice from an earlier
  // opening, cancelled, must not be standing there already picked.
  useEffect(() => {
    setRulesChoice(null);
  }, [step]);
  // For GitHub issues, the repository when the remote does not say it.
  const [repository, setRepository] = useState("");
  // The facts step: every saved fact is carried over unless unticked, so
  // nothing is dropped by pressing the button without reading.
  const facts = status?.savedFacts ?? [];
  const [left, setLeft] = useState<string[]>([]);
  const found = status?.instructions;
  const method =
    methods.find((candidate) => candidate.id === methodId) ?? methods[0];
  return (
    <Dialog
      open={step !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{step?.label}</DialogTitle>
          <DialogDescription>
            {step?.action === "tracker"
              ? "Says which tracker this repository uses. It writes one small file; nothing is run in a terminal."
              : step?.action === "rules"
              ? !replacesBeads(status) && rulesUpdate(status)
                ? "Brings Airbender's instructions for agents in this folder up to the current version. It changes files in the repository; nothing is run in a terminal."
                : "Makes Airbender's instructions the only ones about issues in this folder. It changes files in the repository; nothing is run in a terminal."
              : step?.action === "facts"
                ? "Choose which saved facts agents should keep seeing."
                : "Runs in a BB terminal, so you can watch it and answer anything it asks."}
          </DialogDescription>
        </DialogHeader>
        {step?.action === "tracker" ? (
          <div className="space-y-2 text-sm">
            <p>Where are this repository's issues kept?</p>
            {(
              [
                ["beads", "beads", "A database inside the repository. This tab lists and changes the issues."],
                ["github", "GitHub issues", "On the repository's page on github.com. Agents work them with bend; this tab cannot list them yet."],
              ] as const
            ).map(([id, label, note]) => (
              <label
                key={id}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-state-hover"
              >
                <input
                  type="radio"
                  name="tracker"
                  className="mt-1"
                  checked={trackerId === id}
                  onChange={() => setTrackerId(id)}
                />
                <span className="min-w-0">
                  {label}
                  <span className="block text-xs text-muted-foreground">{note}</span>
                </span>
              </label>
            ))}
            {trackerId === "github" ? (
              <label className="block px-2 text-xs text-muted-foreground">
                Repository, only if this folder's remote is not on github.com:
                <input
                  type="text"
                  className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-sm text-foreground"
                  placeholder="owner/name"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                />
              </label>
            ) : null}
            <p className="text-muted-foreground">
              The choice is recorded in{" "}
              <span className="font-mono">.bend.json</span> at the
              repository's top folder, a small file to check in.
            </p>
          </div>
        ) : step?.action === "install" ? (
          <div className="space-y-2 text-sm">
            <p>Choose how to install it:</p>
            {methods.map((candidate) => (
              <label
                key={candidate.id}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-state-hover"
              >
                <input
                  type="radio"
                  name="install-method"
                  className="mt-1"
                  checked={candidate.id === method?.id}
                  onChange={() => setMethodId(candidate.id)}
                />
                <span className="min-w-0">
                  {candidate.label}
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {candidate.command}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : step?.action === "init" && step.explain === undefined ? (
          <div className="space-y-2 text-sm">
            <p>
              Runs <span className="font-mono">bd init --skip-agents</span> in{" "}
              <span className="break-all font-mono">{status?.path}</span>. It
              changes the repository:
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>
                adds a <span className="font-mono">.beads</span> folder with
                the issue database;
              </li>
              <li>starts a git repository if the folder is not one yet.</li>
              <li>
                writes no instructions for agents: Airbender's are a step
                of their own.
              </li>
            </ul>
            <p>It may ask a few questions in the terminal.</p>
          </div>
        ) : step?.explain !== undefined ? (
          // A step of the issue sync: said in the sync source's words.
          <div className="space-y-2 text-sm">
            <p>
              <Marked text={step.explain.lead} />{" "}
              <span className="break-all font-mono text-muted-foreground">
                {status?.path}
              </span>
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {step.explain.points.map((point) => (
                <li key={point}>
                  <Marked text={point} />
                </li>
              ))}
            </ul>
          </div>
        ) : step?.action === "facts" ? (
          <div className="space-y-2 text-sm">
            <p>
              These were saved in beads and shown to agents when a session
              started. That no longer happens. The ticked ones are written
              to <span className="font-mono">FACTS.md</span>; the others stay
              in beads, and this is not asked again.
            </p>
            <div className="max-h-72 space-y-1 overflow-auto">
              {facts.map((fact) => (
                <label
                  key={fact.key}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-state-hover"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!left.includes(fact.key)}
                    onChange={() =>
                      setLeft((now) =>
                        now.includes(fact.key)
                          ? now.filter((key) => key !== fact.key)
                          : [...now, fact.key],
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {fact.key}
                    </span>
                    {fact.text}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          // The instructions step: said from what the server found, so the
          // confirmation lists exactly what will change in this folder.
          <div className="space-y-2 text-sm">
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>
                {found?.rules === "behind" ? (
                  <>
                    Airbender's rules in{" "}
                    <span className="font-mono">AGENTS.md</span> were changed
                    by hand in this folder, and are from{" "}
                    {found.rulesVersion > 0
                      ? `version ${found.rulesVersion}`
                      : "before versions were written"}
                    ; the current rules are version {found.currentVersion}.
                    Choose below.
                  </>
                ) : found?.rules === "edited" ? (
                  <>
                    Airbender's rules in{" "}
                    <span className="font-mono">AGENTS.md</span> were changed
                    by hand in this folder. They are yours and are left as
                    they are.
                  </>
                ) : found?.rules === "old" ? (
                  <>
                    Replaces Airbender's rules in{" "}
                    <span className="font-mono">AGENTS.md</span> with the
                    current version, where they stand.
                  </>
                ) : found?.rules === "current" ? (
                  <>
                    Airbender's rules are in{" "}
                    <span className="font-mono">AGENTS.md</span> already.
                  </>
                ) : (
                  <>
                    Adds Airbender's rules to{" "}
                    <span className="font-mono">AGENTS.md</span>, at the end.
                  </>
                )}
              </li>
              {(found?.beadsBlocks ?? []).map((file) => (
                <li key={file}>
                  Removes the block beads generated in{" "}
                  <span className="font-mono">{file}</span>, between its own
                  markers. Nothing outside the markers changes.
                </li>
              ))}
              {(found?.beadsHooks ?? []).map((agent) => (
                <li key={agent}>
                  Removes beads' own setup for {agent}, with beads' command
                  for that. It is what prints beads' instructions at the
                  start of every session.
                </li>
              ))}
              <li>
                A <span className="font-mono">CLAUDE.md</span>, if this folder
                has one, is made to point at{" "}
                <span className="font-mono">AGENTS.md</span> and{" "}
                <span className="font-mono">FACTS.md</span>. None is created.
              </li>
              <li>
                Creates <span className="font-mono">FACTS.md</span> for
                standing facts, if there is none.
              </li>
            </ul>
            {(found?.machineWide ?? []).length === 0 ? null : (
              <p className="text-muted-foreground">
                Not touched: beads is also set up for{" "}
                {found!.machineWide.join(" and ")} on this whole computer,
                outside this folder. Its text will still appear when a
                session starts, until that is removed with{" "}
                <span className="font-mono">bd setup … --remove --global</span>.
              </p>
            )}
            {(found?.leftovers ?? []).length === 0 ? null : (
              <p className="text-muted-foreground">
                Left in place, for you to remove if you wish: beads also
                wrote {found!.leftovers.join(", ")} into{" "}
                <span className="font-mono">AGENTS.md</span> without markers,
                so it cannot be told safely from your own text.
              </p>
            )}
            {/* Rules of the owner's own that fell behind: which they want.
                Nothing is picked for them; the button waits for a choice. */}
            {found?.rules !== "behind" ? null : (
              <div className="space-y-1.5">
                {(
                  [
                    [
                      "replace",
                      "Replace with the current rules",
                      "What is there now is saved first, outside your working files: in the repository's git folder, under bend/instructions.",
                    ],
                    [
                      "keep",
                      "Keep mine",
                      `They stay as they are and are marked as compared with version ${found.currentVersion}, so this is asked again only when the rules change once more.`,
                    ],
                  ] as const
                ).map(([id, label, hint]) => (
                  <label key={id} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="rules-choice"
                      className="mt-1"
                      checked={rulesChoice === id}
                      onChange={() => setRulesChoice(id)}
                    />
                    <span className="min-w-0">
                      {label}
                      <span className="block text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-muted-foreground">
              The rules tell agents to give every piece of work an issue,
              take it through its workflow one step at a time, record
              decisions on the issue, leave closing to you, and commit when
              you accept it.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              (step?.action === "install" && method === undefined) ||
              (step?.action === "rules" && rulesBehind(status) && rulesChoice === null)
            }
            onClick={() => {
              if (step === null) return;
              onRun(
                step,
                step.action === "install"
                  ? (method?.id ?? null)
                  : step.action === "rules" && rulesBehind(status)
                    ? rulesChoice
                    : step.action === "tracker"
                    ? trackerId === "github" && repository.trim() !== ""
                      ? `github:${repository.trim()}`
                      : trackerId
                    : step.action === "facts"
                    ? JSON.stringify(
                        facts
                          .map((fact) => fact.key)
                          .filter((key) => !left.includes(key)),
                      )
                    : step.option,
              );
            }}
          >
            {step?.action === "rules"
              ? rulesBehind(status)
                ? rulesChoice === "keep"
                  ? "Keep mine"
                  : "Replace"
                : replacesBeads(status)
                  ? "Replace"
                  : rulesUpdate(status)
                    ? "Update"
                    : "Add"
              : step?.action === "facts"
                ? "Carry over"
                : step?.action === "tracker"
                  ? "Choose"
                  : "Run in a terminal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
