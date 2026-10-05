// app/issue-details.tsx — an opened issue.
//
// What: what shows when a row is opened: the description, the links line, the
// Define button and the row of lean buttons, assembled with the facts line
// (app/issue-facts.tsx), the folded sections and the edit form (app/issue-
// sections.tsx) and the two search boxes (app/pickers.tsx).
//
// Why: this is the spec's "An opened issue" section: the one place that
// decides what an opened issue shows and in what order.
//
// Design notes:
// - The Move to and Link boxes are drawn inside the opened issue, not
//   floating, because the list clips anything that hangs outside it.

import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
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

/**
 * Starts defining an issue with a background agent, so the thread the
 * user is in is left alone. The agent runs in a hidden worker thread that is
 * not in the sidebar; while it is busy the button turns into the one way to
 * open it, in case the user wants to look in or it is waiting on a question.
 */
export function DefineButton({
  issue,
  iconOnly = false,
}: {
  issue: Issue;
  /**
   * Draw it as a bare icon, in the same style as the row's close button.
   * Used on a collapsed row, where a labelled button would crowd the title.
   */
  iconOnly?: boolean;
}) {
  const actions = useActions();
  const navigate = useBbNavigate();
  const running = issue.defineThreadId;
  const look = iconOnly
    ? ({
        variant: "ghost",
        size: "icon",
        className: "m-1 size-7 shrink-0 text-muted-foreground",
      } as const)
    : ({ variant: "outline", size: "sm" } as const);
  if (running !== null) {
    return (
      <Button
        {...look}
        tip="A background agent is writing this issue up. Click to open it."
        aria-label={`Open the background agent that is defining ${issue.id}`}
        onClick={() => navigate.toThread(running)}
      >
        <Icon name="Loading" className="size-4 animate-spin" />
        {iconOnly ? null : "Defining… open"}
      </Button>
    );
  }
  return (
    <Button
      {...look}
      tip="Define: have a background agent write this issue up (what is wanted, what done means, and an approach)"
      aria-label={`Define ${issue.id} with a background agent`}
      onClick={() => actions.define(issue.id)}
    >
      <Icon name="MessageSquare" className="size-4" />
      {iconOnly ? null : "Define"}
    </Button>
  );
}

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
}: {
  issue: Issue;
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
  return (
    <div className="space-y-3">
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
      {/* The opened issue's buttons are deliberately quiet (the user's
          request, bead-bb-zty.1): short, small text, no border, a soft
          background, so a row of them does not pull the eye away from the
          issue's text. Styled here once, for every button in the row. */}
      <div className="flex flex-wrap gap-1.5 [&>button]:h-6 [&>button]:gap-1 [&>button]:rounded [&>button]:border-0 [&>button]:bg-foreground/[0.06] [&>button]:px-2 [&>button]:text-xs [&>button]:font-normal [&>button]:text-muted-foreground [&>button]:shadow-none [&>button:hover]:bg-foreground/[0.12] [&>button:hover]:text-foreground [&>button_[data-icon-root]]:size-3.5">
        {/* Play for a compact sub-issue row, which has no buttons of its
            own (see IssueRow). First in the row at the user's request:
            starting work is the main thing to do with an open sub-issue. */}
        {showFacts &&
        !closed &&
        actions.start !== null &&
        actions.currentBeadId === null ? (
          <Button
            variant="outline"
            size="sm"
            tip="Make this the issue the conversation is working on and start the agent on it"
            onClick={() => actions.start?.(issue.id)}
          >
            <Icon name="Play" className="size-4" />
            Start work
          </Button>
        ) : null}
        {closed ? null : (
          <DefineButton issue={issue} />
        )}
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
        {/* A compact sub-issue row has no close or reopen button of its own
            (see IssueRow); they are here instead. The current bead's own
            button follows below, so it is skipped here. */}
        {!showFacts || actions.currentBeadId === issue.id ? null : closed ? (
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
            tip="Close this issue without committing anything"
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
            Close
          </Button>
        )}
        {/* The current bead's "drop it" action lives here, out of the way,
            instead of on the row beside "Close & commit". */}
        {closed || actions.currentBeadId !== issue.id ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Close this issue without committing: use it to drop the issue"
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
            Close without commit
          </Button>
        )}
      </div>
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
