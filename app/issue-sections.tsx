// app/issue-sections.tsx — the folded parts of an opened issue.
//
// What: Collapsible and TextSection (a heading that opens on its chevron),
// CommentList (comments fetched when their heading is opened) and
// EditIssueText (the form that replaces the title and description while
// editing).
//
// Why: the user asked for acceptance criteria, design, notes and comments to
// start collapsed, so opening an issue shows its description and a short list
// of what else exists, not a wall of text.
//
// Design notes:
// - Children of a folded part are mounted only while it is open, which is what
//   makes comments load on demand.

import { Markdown } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Issue, IssueComment } from "../server/contract.ts";
import type { IssueActions } from "./actions.ts";
import { FIELD_CLASS } from "./bits.tsx";
import { formatWhen } from "./issue-model.ts";

/**
 * One part of an opened issue (design, notes, comments and so on) that starts
 * folded to its heading and opens on its own chevron. The user asked for
 * these to start collapsed, so opening an issue shows its description plus a
 * short list of what else exists, not a wall of text.
 *
 * Children are only mounted while open, which is what makes comments load on
 * demand.
 */
export function Collapsible({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="size-3.5 shrink-0"
        />
        {label}
      </button>
      {open ? <div className="mt-1 pl-[18px]">{children}</div> : null}
    </div>
  );
}

/**
 * One titled block of an issue's free text (design, notes and so on),
 * rendered as Markdown and collapsed to start. Renders nothing when the text
 * is empty, so an issue with only a description looks as it did before.
 */
export function TextSection({ label, text }: { label: string; text: string }) {
  if (text.trim() === "") return null;
  return (
    <Collapsible label={label}>
      <Markdown content={text} className="text-sm" />
    </Collapsible>
  );
}

/**
 * The comments of an issue, oldest first, shown inside the collapsed
 * "Comments" part of an opened issue.
 *
 * Fetched when that part is opened, because beads needs one run per issue
 * for comments. Fetched again whenever the issue's comment count or
 * last-changed time moves, which is how a refresh of the list reaches
 * comments that are already on screen. Nothing is fetched or shown for an
 * issue without comments. A failure is reported in place; the rest of the
 * opened issue is unaffected.
 */
export function CommentList({
  issue,
  load,
}: {
  issue: Issue;
  load: IssueActions["loadComments"];
}) {
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { id, commentCount, updatedAt } = issue;
  useEffect(() => {
    if (commentCount === 0) return;
    // Ignore an answer that arrives after the issue changed or was closed up.
    let stale = false;
    load(id).then(
      (next) => {
        if (stale) return;
        setComments(next);
        setProblem(null);
      },
      (cause: unknown) => {
        if (stale) return;
        setProblem(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [load, id, commentCount, updatedAt]);
  if (problem !== null) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Could not load comments: {problem}
      </p>
    );
  }
  if (comments === null) {
    return <p className="text-xs text-muted-foreground">Loading comments…</p>;
  }
  return (
    <ul className="space-y-2">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className="rounded-md border border-border px-3 py-2"
        >
          <div className="text-xs text-muted-foreground">
            {comment.author === "" ? "Unknown" : comment.author}
            {comment.createdAt === ""
              ? ""
              : ` · ${formatWhen(comment.createdAt)}`}
          </div>
          <Markdown content={comment.text} className="mt-1 text-sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The form that replaces an opened issue's description while its title and
 * description are being edited.
 *
 * The description is edited as the raw Markdown beads stores. Saving an empty
 * description clears it; an empty title cannot be saved. Cancel leaves the
 * issue untouched. A failed save keeps the form open with what was typed and
 * shows the reason.
 *
 * @param save Saves both fields; resolves to null on success or to the
 *   reason on failure.
 * @param onDone Called after a successful save or a cancel, to close the form.
 */
export function EditIssueText({
  issue,
  save,
  onDone,
}: {
  issue: Issue;
  save: IssueActions["saveText"];
  onDone: () => void;
}) {
  // Started from the issue as it was when Edit was pressed, and deliberately
  // not refreshed afterwards: a list reload must not overwrite half-typed text.
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    const reason = await save(issue.id, { title: title.trim(), description });
    setPending(false);
    setProblem(reason);
    if (reason === null) onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label={`Title of ${issue.id}`}
        placeholder="Title"
      />
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        aria-label={`Description of ${issue.id}`}
        placeholder="Description (Markdown, optional)"
        rows={8}
        className={cn(FIELD_CLASS, "block w-full resize-y font-mono text-xs")}
      />
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Could not save: {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || title.trim() === ""}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
