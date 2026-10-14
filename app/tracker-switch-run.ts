// app/tracker-switch-run.ts — the order in which a switch of tracker is
// carried out.
//
// What: one function that runs "copy and switch" or "switch only" from the
// steps it is handed (copy, switch), and says how it ended.
//
// Why: the order differs by direction, and getting it wrong changes a
// repository's tracker when the owner was told it would not be
// (bead-bb-c9l.18). It is kept apart from the window so that every way
// through can be tested without one.
//
// Design notes:
// - Going to GitHub issues the copy comes first, and the switch only if
//   every issue went through: a failure leaves everything as it was. Going
//   to beads the switch comes first and the copy follows, because the
//   copying works through the folder's own tracker and that has to be
//   beads; a failure of the copy is then said as that.
// - Before each step it asks whether it is still wanted (`alive`): a
//   window closed half-way must not switch anything afterwards.
//
// Gotchas:
// - No imports from React or BB: loaded by the tests as it is.

/** How one copy ended. */
export interface CopyEnd {
  /** Why it did not run to its end; null when it did. */
  failed: string | null;
  /** What it could not do for single issues, in its own words. */
  warnings: string[];
}

/** How a run ended. */
export interface SwitchEnd {
  /** The tracker was switched. */
  switched: boolean;
  /** What went wrong, for the owner; null when nothing did. */
  problem: string | null;
}

/** The first few of a list of sentences, and how many more there are. */
function some(lines: string[]): string {
  const shown = lines.slice(0, 5).join("\n");
  return lines.length > 5 ? `${shown}\n… and ${lines.length - 5} more.` : shown;
}

/** Why a copy does not count as gone through; null when it does. */
function wrongWith(end: CopyEnd): string | null {
  if (end.failed !== null) return end.failed;
  if (end.warnings.length > 0) return some(end.warnings);
  return null;
}

/**
 * Carries a switch out.
 *
 * @param to The tracker being switched to.
 * @param copy Copies the issues, or null for "switch only".
 * @param switchTracker Makes the switch; resolves to why it could not.
 * @param alive False once the window this was started from is gone: no
 *   further step is taken.
 * @returns Whether the tracker was switched, and what went wrong if
 *   anything did. Never rejects.
 */
export async function runSwitch({
  to,
  copy,
  switchTracker,
  alive,
}: {
  to: "beads" | "github";
  copy: (() => Promise<CopyEnd>) | null;
  switchTracker: () => Promise<string | null>;
  alive: () => boolean;
}): Promise<SwitchEnd> {
  let switched = false;
  try {
    if (copy !== null && to === "github") {
      const wrong = wrongWith(await copy());
      if (wrong !== null) {
        return {
          switched,
          problem: `The issues were not all copied, so nothing was switched:\n${wrong}`,
        };
      }
      if (!alive()) return { switched, problem: null };
    }
    const refused = await switchTracker();
    if (refused !== null) return { switched, problem: refused };
    switched = true;
    if (copy !== null && to === "beads") {
      const wrong = wrongWith(await copy());
      if (wrong !== null) {
        return {
          switched,
          problem: `The project now uses beads, but the issues were not all brought in:\n${wrong}\n"Import / export GitHub issues" in the menu, under Setup, can do the rest.`,
        };
      }
    }
    return { switched, problem: null };
  } catch (cause) {
    return { switched, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}
