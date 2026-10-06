// app/issue-details.tsx — an opened issue.
//
// What: what shows when a row is opened: the description, the links line, the
// workflow moves and the row of lean buttons, assembled with the facts line
// (app/issue-facts.tsx), the folded sections and the edit form (app/issue-
// sections.tsx) and the two search boxes (app/pickers.tsx).
//
// Why: this is the spec's "An opened issue" section: the one place that
// decides what an opened issue shows and in what order.
//
// Design notes:
// - The Move to and Link boxes are drawn inside the opened issue, not
//   floating, because the list clips anything that hangs outside it.

import { Markdown } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { useActions } from "./actions.ts";
import { LinkIcon, Tag } from "./bits.tsx";
import { IssueFacts } from "./issue-facts.tsx";
import { TWO_WAY_KINDS, isLongDescription, linkWords } from "./issue-model.ts";
import {
  Collapsible,
  CommentList,
  EditIssueText,
  TextSection,
} from "./issue-sections.tsx";
import { LinkPicker, MoveToPicker } from "./pickers.tsx";
import type { WorkflowMove } from "../shared/workflow.ts";
import {
  NoteForm,
  WorkflowButton,
  WorkflowMoves,
} from "./workflow-controls.tsx";
import { CurrentToggle } from "./current-toggle.tsx";
import { ZoomInIcon } from "./epic-band.tsx";
import type { RowAsk } from "./row-menu.tsx";

/**
 * The links of an opened issue, as one line of chips (bead-bb-zty.4). It
 * replaced two separate lists, "Blocked by" and "Holds up", which showed
 * only blocking links to unfinished issues.
 *
 * Every link of every kind is here, from both ends. A link stored on this
 * issue reads "blocked by · <title>"; one stored on the other issue and
 * pointing here reads "blocks · <title>" for a blocking link and
 * "<title> · discovered from this" (and so on) for the other kinds, so the
 * direction is always in the words. A closed issue's title is struck out.
 *
 * Clicking a chip opens that issue in the details window. The x, which
 * shows on hover, removes the link without asking: it is put back with the
 * Link button. Draws nothing for an issue without links.
 */
function LinksLine({
  issue,
}: {
  issue: Issue;
}) {
  const actions = useActions();
  if (issue.links.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">Links</div>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {issue.links.map((link) => {
          const words = linkWords(link.kind);
          const title = (
            <span className={cn(link.closed && "line-through")}>
              {link.title}
            </span>
          );
          return (
            <li
              key={`${link.direction}:${link.kind}:${link.id}`}
              className="group/link flex max-w-full items-center rounded-full border border-border text-xs"
            >
              <Tip label={`Open ${link.id}`}>
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate rounded-full py-0.5 pl-2 pr-1 hover:bg-state-hover"
                  onClick={() => actions.openDetails(link.id)}
                >
                  {link.direction === "out" ||
                  TWO_WAY_KINDS.includes(link.kind) ? (
                    <>
                      <span className="text-muted-foreground">{words} · </span>
                      {title}
                    </>
                  ) : link.kind === "blocks" ? (
                    <>
                      <span className="text-muted-foreground">blocks · </span>
                      {title}
                    </>
                  ) : (
                    <>
                      {title}
                      <span className="text-muted-foreground">
                        {" "}
                        · {words} this
                      </span>
                    </>
                  )}
                </button>
              </Tip>
              <Tip label="Remove this link">
                <button
                  type="button"
                  aria-label={`Remove the link with ${link.id}`}
                  className="mr-1 shrink-0 cursor-pointer rounded-full px-1 text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover/link:opacity-100"
                  onClick={() => actions.unlink(issue.id, link)}
                >
                  ×
                </button>
              </Tip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Everything shown when an issue is opened: text, relations, actions. */
export function IssueDetails({
  issue,
  fullDescription = false,
  showFacts = false,
  asked = null,
  onAsked,
  bodyClassName,
}: {
  /**
   * Extra classes for the issue's text (description, sections, comments),
   * for a place that caps its height and lets it scroll. The buttons and
   * the Move to and Link boxes are outside it, so they stay in view however
   * long the text is (the user's request, bead-bb-l3m).
   */
  bodyClassName?: string;
  issue: Issue;
  /**
   * What the row's "more" menu wants shown here: the edit form, or the
   * Move to or Link box. Taken once and then cleared through `onAsked`, so
   * closing the issue up and opening it again does not bring it back.
   */
  asked?: RowAsk | null;
  onAsked?: () => void;
  /**
   * Show the id, priority and type line at the top. Used for compact
   * sub-issue rows, whose one-line row has no room for them.
   */
  showFacts?: boolean;
  /**
   * Show the whole description. False (the default) cuts a long one to a
   * few lines with "View more", which opens the details window; true is for
   * the issue the details window is showing, where the full text belongs.
   */
  fullDescription?: boolean;
}) {
  const actions = useActions();
  const closed = issue.status === CLOSED_STATUS;
  // Whether the title and description are being edited. Kept here, in the
  // opened issue, so it ends when the issue is closed up; it also ends if
  // the row is rebuilt because the issue moved to another group.
  const [editing, setEditing] = useState(false);
  // Whether the "Move to" picker is showing under the buttons.
  const [moving, setMoving] = useState(false);
  // Whether the "Link" box is showing under the buttons. Only one of the
  // two boxes shows at a time.
  const [linking, setLinking] = useState(false);
  // The workflow move waiting for its reason (send back, skip); null when
  // none is. Its field shows under the buttons.
  const [noting, setNoting] = useState<WorkflowMove | null>(null);
  const focusOffer = actions.focusOffer(issue.id);
  useEffect(() => {
    if (asked === null) return;
    if (!closed) {
      setEditing(asked === "edit");
      setMoving(asked === "move");
      setLinking(asked === "link");
    }
    onAsked?.();
    // `onAsked` is a new function on every render of the row; only a new
    // request should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  return (
    <div className="space-y-3">
      <div className={cn("space-y-3", bodyClassName)}>
        {showFacts ? (
          <IssueFacts
            issue={issue}
            onEdit={closed ? undefined : actions.edit}
            category={
              closed
                ? undefined
                : { choices: actions.categories, onChange: actions.setCategory }
            }
          />
        ) : null}
        {editing ? (
          <EditIssueText
            issue={issue}
            save={actions.saveText}
            onDone={() => setEditing(false)}
          />
        ) : issue.description.trim() === "" ? (
          <p className="text-xs text-muted-foreground">No description.</p>
        ) : fullDescription || !isLongDescription(issue.description) ? (
          <Markdown content={issue.description} className="text-sm" />
        ) : (
          // A long description is cut to about four lines so an opened row
          // stays short; the rest is read in the details window.
          <div>
            <div className="relative max-h-[5.5rem] overflow-hidden">
              <Markdown content={issue.description} className="text-sm" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
            </div>
            <button
              type="button"
              className="mt-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => actions.openDetails(issue.id)}
            >
              View more
            </button>
          </div>
        )}
        <TextSection label="Acceptance criteria" text={issue.acceptance} />
        <TextSection label="Design" text={issue.design} />
        <TextSection label="Notes" text={issue.notes} />
        <TextSection label="Close reason" text={issue.closeReason} />
        <LinksLine issue={issue} />
        {issue.labels.length === 0 ? null : (
          <div className="flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <Tag key={label}>{label}</Tag>
            ))}
          </div>
        )}
        {issue.status === "open" ||
        issue.status === "in_progress" ||
        closed ? null : (
          <p className="text-xs text-muted-foreground">Status: {issue.status}</p>
        )}
        {issue.commentCount === 0 ? null : (
          <Collapsible label={`Comments (${issue.commentCount})`}>
            <CommentList issue={issue} load={actions.loadComments} />
          </Collapsible>
        )}
      </div>
      {/* The opened issue's buttons are deliberately quiet (the user's
          request, bead-bb-zty.1): short, small text, no border, a soft
          background, so a row of them does not pull the eye away from the
          issue's text. Styled here once, for every button in the row. */}
      <div className="flex flex-wrap gap-1.5 [&>button]:h-6 [&>button]:gap-1 [&>button]:rounded [&>button]:border-0 [&>button]:bg-foreground/[0.06] [&>button]:px-2 [&>button]:text-xs [&>button]:font-normal [&>button]:text-muted-foreground [&>button]:shadow-none [&>button:hover]:bg-foreground/[0.12] [&>button:hover]:text-foreground [&>button_[data-icon-root]]:size-3.5">
        {/* The workflow's main button, for a compact sub-issue row, which
            has no buttons of its own (see IssueRow). First in the row at
            the user's request: getting on with it is the main thing to do
            with an open sub-issue. */}
        {showFacts ? <WorkflowButton issue={issue} /> : null}
        {/* The target, also in the row's "more" menu: make this the thread's
            current issue, or release it. */}
        <CurrentToggle issue={issue} withLabel />
        {/* The user's other moves at this step: send back, skip, mark as
            done. */}
        <WorkflowMoves issue={issue} onNeedNote={setNoting} />
        {closed || editing ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Edit the title and description"
            onClick={() => setEditing(true)}
          >
            <Icon name="EditFile" className="size-4" />
            Edit
          </Button>
        )}
        {/* Does not create anything here: it selects this issue as the
            parent in the new-issue field at the bottom and puts the cursor
            there, so there is one place to type a new issue, not two. */}
        {closed ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Create a new issue inside this one, using the new-issue field below"
            onClick={() => actions.addSubIssue(issue.id)}
          >
            <Icon name="Plus" className="size-4" />
            Add sub-issue
          </Button>
        )}
        {/* Moving without dragging: for long lists, where the place to
            drop is far off screen. It also covers moving out, so there is
            one button for both. */}
        {moving ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Move this issue inside another issue, or out to the top level"
            onClick={() => {
              setLinking(false);
              setMoving(true);
            }}
          >
            <Icon name="MoveTo" className="size-4" />
            Move to
          </Button>
        )}
        {closed ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Link this issue with another: blocked by, discovered from, related and beads' other kinds"
            onClick={() => {
              setMoving(false);
              setLinking(true);
            }}
          >
            <LinkIcon className="size-4" />
            Link
          </Button>
        )}
        {/* Epic mode, also here: a compact sub-issue row has no buttons,
            and this is how a sub-issue with sub-issues of its own is
            zoomed in on, one level at a time. Disabled with the reason
            while the current issue is not from this epic. */}
        {focusOffer === null ? null : (
          <Button
            variant="outline"
            size="sm"
            // Greyed out by hand, not `disabled`, so the tooltip with the
            // reason still shows (see the same button in IssueRow).
            className={
              focusOffer.blocked === null
                ? undefined
                : "cursor-default opacity-40"
            }
            aria-disabled={focusOffer.blocked !== null}
            tip={
              focusOffer.blocked ??
              "Epic mode: show only this issue's sub-issues in the list"
            }
            onClick={() => actions.focus(issue.id)}
          >
            <ZoomInIcon className="size-4" />
            Focus
          </Button>
        )}
        {/* A compact sub-issue row has no buttons of its own (see
            IssueRow), so the way into the details window is repeated
            here. Its play button is at the start of this row. */}
        {showFacts && actions.childrenOf(issue.id).length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            tip="Open this issue and its sub-issues in the details window"
            onClick={() => actions.openDetails(issue.id)}
          >
            <Icon name="Maximize2" className="size-4" />
            Open with sub-issues
          </Button>
        ) : null}
        {/* Close and reopen, here as well as in the row's "more" menu (the
            user: "you can access those actions through two parts"). Closing
            asks for confirmation first; reopening does not, since it only
            puts an issue back on the list. */}
        {closed ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Reopen this issue"
            onClick={() => actions.reopen(issue.id)}
          >
            <Icon name="RotateCcw" className="size-4" />
            Reopen
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Close this issue without finishing it"
            onClick={() => actions.close(issue.id)}
          >
            <Icon name="CircleX" className="size-4" />
            Close
          </Button>
        )}
      </div>
      {noting === null ? null : (
        <NoteForm
          issue={issue}
          move={noting}
          onDone={() => setNoting(null)}
        />
      )}
      {moving ? (
        <MoveToPicker
          issue={issue}
          targets={actions.moveTargets(issue.id)}
          onPick={(parentId) => {
            setMoving(false);
            actions.setParent(issue.id, parentId);
          }}
          onCancel={() => setMoving(false)}
        />
      ) : null}
      {linking ? (
        <LinkPicker
          issue={issue}
          targets={actions.linkTargets(issue.id)}
          onPick={(fromId, toId, kind) => {
            setLinking(false);
            actions.link(fromId, toId, kind);
          }}
          onCancel={() => setLinking(false)}
        />
      ) : null}
    </div>
  );
}
