// app/drag.ts — which issue is being dragged right now.
//
// What: one module-level value, the id of the issue being dragged, with a
// getter and a setter.
//
// Why: the browser does not let a row read what is being dragged while it is
// only hovering (the drag's data is readable on drop, not on drag-over), and
// a row has to decide during the hover whether it is a valid place to drop.
// So the id is kept here, outside React.
//
// Gotchas:
// - There must be exactly one copy of this value: the rows (app/issue-row)
//   set it and the list's drop zone (app/panel) reads it. That is why it has
//   its own file instead of living in either of them.

let draggedBeadId: string | null = null;

/** The id of the issue being dragged, or null when no drag is under way. */
export function getDragged(): string | null {
  return draggedBeadId;
}

/** Records the issue being dragged; null when the drag ends or is dropped. */
export function setDragged(beadId: string | null): void {
  draggedBeadId = beadId;
}
