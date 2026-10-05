// app/setup.tsx — getting a folder ready for Airbender.
//
// What: the setup steps worked out from the backend's status, the hook that
// loads the status and remembers skipped steps, the card in the middle of the
// tab, the "more" menu in the toolbar, and the confirmation dialog.
//
// Why: when something the tab needs is missing (the beads program, beads in
// the folder, beads' agent setup, Airbender's rules) the tab offers to set it
// up instead of leaving the user at a dead end (bead-bb-80e).
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
import type {
  IssuesResult,
  SetupStatus,
  rpcContract,
} from "../server/contract.ts";
import { CHANGED_CHANNEL, SETUP_AGENTS } from "../shared/constants.ts";
import { MenuPanel, useMenu } from "./menus.tsx";
import type { Scope } from "./use-issues.ts";

/**
 * One thing that can be set up for a folder (bead-bb-80e), worked out from
 * the server's SetupStatus for both the setup card and the "more" menu.
 */
export interface SetupStep {
  /** Unique per step; also what "Skip" remembers. E.g. "agent:claude". */
  key: string;
  action: "install" | "init" | "agent" | "rules";
  /** The agent id for an "agent" step; null otherwise. */
  option: string | null;
  /** The button and menu label. */
  label: string;
  /** One line on what it is for, shown on the card. */
  why: string;
  /** Not yet in place, and possible right now: offered on the card. */
  needed: boolean;
  /**
   * Why it cannot be started, in a word or two ("done", "install beads
   * first"); null when it can. The menu greys the item and shows this.
   */
  blocked: string | null;
}

/** The setup steps for a folder, in the order they make sense. */
function setupSteps(status: SetupStatus): SetupStep[] {
  const running = status.running === null ? null : "running…";
  const steps: SetupStep[] = [
    {
      key: "install",
      action: "install",
      option: null,
      label: "Install beads",
      why: "The beads program is not on this computer. The tab needs it to read and change issues.",
      needed: !status.bdInstalled,
      blocked: status.bdInstalled
        ? "installed"
        : status.installMethods.length === 0
          ? "no installer found"
          : running,
    },
    {
      key: "init",
      action: "init",
      option: null,
      label: "Set up beads in this folder",
      why: "This folder has no issue database yet. Setting it up lets you track issues here.",
      needed: status.bdInstalled && !status.folderReady,
      blocked: status.folderReady
        ? "done"
        : !status.bdInstalled
          ? "install beads first"
          : running,
    },
    // Before the folder is set up the server reports no agents; the two BB
    // runs are listed anyway so the menu always shows the whole set.
    ...(status.agents.length > 0
      ? status.agents
      : SETUP_AGENTS.map((agent) => ({ ...agent, configured: false }))
    ).map((agent) => ({
      key: `agent:${agent.id}`,
      action: "agent" as const,
      option: agent.id,
      label: `Configure beads for ${agent.label}`,
      why: `Beads' own setup for ${agent.label} is not in this folder. It gives the agent beads' instructions when it starts.`,
      needed: status.folderReady && !agent.configured,
      blocked: agent.configured
        ? "done"
        : !status.folderReady
          ? "set up the folder first"
          : running,
    })),
    {
      key: "rules",
      action: "rules",
      option: null,
      label: "Add Airbender's rules for agents",
      why: "The rules this tab's buttons rely on: agents take an issue one step at a time, leave closing to you, and commit when you accept it.",
      needed: status.folderReady && !status.rulesPresent,
      blocked: status.rulesPresent
        ? "done"
        : !status.folderReady
          ? "set up the folder first"
          : running,
    },
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
          Get this folder ready for Airbender
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
 */
export function SetupMenu({
  status,
  onOpen,
  onStart,
}: {
  status: SetupStatus | null;
  /** Called when the menu opens, to fetch a fresh status. */
  onOpen: () => void;
  onStart: (step: SetupStep) => void;
}) {
  const { open, setOpen, root } = useMenu();
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        tip="Set up beads and Airbender for this folder"
        aria-label="Setup menu"
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
 *   agent's id, or null.
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
            {step?.action === "rules"
              ? "Adds a section to this folder's AGENTS.md, at the end, and, if this folder has a CLAUDE.md, makes it point at AGENTS.md so Claude Code reads the same rules. A CLAUDE.md that holds only beads' generated text is replaced by that pointer; one with your own text is kept, with one line added at the top. No CLAUDE.md is created."
              : "Runs in a BB terminal, so you can watch it and answer anything it asks."}
          </DialogDescription>
        </DialogHeader>
        {step?.action === "install" ? (
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
        ) : step?.action === "init" ? (
          <div className="space-y-2 text-sm">
            <p>
              Runs <span className="font-mono">bd init</span> in{" "}
              <span className="break-all font-mono">{status?.path}</span>. It
              changes the repository:
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>
                adds a <span className="font-mono">.beads</span> folder with
                the issue database;
              </li>
              <li>
                adds or extends <span className="font-mono">AGENTS.md</span>{" "}
                with beads' instructions for agents;
              </li>
              <li>may add small files for other coding tools;</li>
              <li>starts a git repository if the folder is not one yet.</li>
            </ul>
            <p>It may ask a few questions in the terminal.</p>
          </div>
        ) : step?.action === "agent" ? (
          <p className="text-sm">
            Runs <span className="font-mono">bd setup {step.option}</span> in{" "}
            <span className="break-all font-mono">{status?.path}</span>. It
            adds beads' own instructions and hooks for that agent to this
            folder.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The rules tell agents to give every piece of work an issue, take
            it through its workflow one step at a time, record decisions on
            the issue, leave closing to you, and commit when you accept it.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={step?.action === "install" && method === undefined}
            onClick={() => {
              if (step === null) return;
              onRun(
                step,
                step.action === "install" ? (method?.id ?? null) : step.option,
              );
            }}
          >
            {step?.action === "rules" ? "Enable" : "Run in a terminal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
