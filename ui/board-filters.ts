import {
  belongsToColumn,
  columnFor,
  type BoardColumn,
  type Thread,
} from "../shared/types";
import type { FilterValue } from "./vendor/affectui/filter-menu";

export function isColumnVisible(
  column: BoardColumn,
  states: string[] = [],
): boolean {
  if (!states.length) return column !== "unknown";
  if (column === "unread")
    return states.includes("idle") || states.includes("unknown");
  return states.includes(column);
}

export function matchesFilters(thread: Thread, filters: FilterValue): boolean {
  if (!filters.state?.length && belongsToColumn(thread, "unknown"))
    return false;
  if (filters.state?.length && !filters.state.includes(columnFor(thread)))
    return false;
  if (filters.project?.length && !filters.project.includes(thread.project))
    return false;
  if (filters.kind?.length && !filters.kind.includes(thread.kind)) return false;
  if (
    filters.read?.length &&
    !filters.read.includes(
      thread.unread === null ? "unknown" : thread.unread ? "unread" : "read",
    )
  )
    return false;
  return true;
}
