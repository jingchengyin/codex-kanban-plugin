import {
  columnFor,
  compareByLastUserMessage,
  type BoardColumn,
  type BoardScope,
  type Thread,
} from "../shared/types";
import type { FilterValue } from "./vendor/affectui/filter-menu";

/** 默认保留所有本地对话，断线或尚未加载时也能继续浏览。 */
export const DEFAULT_FILTERS: FilterValue = {
  state: ["waiting", "running", "idle", "error", "unknown"],
};

/** 根据实际勾选的运行状态决定可见列，空数组表示全部取消。 */
export function isColumnVisible(
  column: BoardColumn,
  states: string[] = DEFAULT_FILTERS.state,
  scope: BoardScope = "all",
): boolean {
  if (
    scope === "attention" &&
    column !== "waiting" &&
    column !== "unread" &&
    column !== "error"
  )
    return false;
  if (column === "unread")
    return (
      states.includes("idle") ||
      states.includes("unknown") ||
      (scope === "attention" && states.includes("running"))
    );
  return states.includes(column);
}

/** 搜索覆盖卡片中的输入和所属事项，避免看得见却搜不到。 */
export function matchesQuery(
  thread: Thread,
  query: string,
  itemTitles: string[] = [],
): boolean {
  return [
    thread.title,
    thread.project,
    thread.id,
    thread.turnUsage?.userInput ?? "",
    ...itemTitles,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

/** 待处理优先；同类等待按首次观察时间排序，未知起点排在最后。 */
export function compareAttention(a: Thread, b: Thread): number {
  const rank = (thread: Thread) => {
    const state = columnFor(thread);
    return state === "waiting"
      ? 0
      : state === "error"
        ? 1
        : thread.unread
          ? 2
          : 3;
  };
  const priority = rank(a) - rank(b);
  if (priority) return priority;
  if (columnFor(a) === "waiting" && columnFor(b) === "waiting") {
    const waiting = !a.waitingSince
      ? Number(!!b.waitingSince)
      : !b.waitingSince
        ? -1
        : a.waitingSince.localeCompare(b.waitingSince);
    if (waiting) return waiting;
  }
  return compareByLastUserMessage(a, b);
}

/** 默认状态不计作筛选条件，清除筛选后徽标归零。 */
export function activeFilterCount(filters: FilterValue): number {
  const states = filters.state ?? DEFAULT_FILTERS.state;
  return (
    Number(
      states.length !== DEFAULT_FILTERS.state.length ||
        DEFAULT_FILTERS.state.some((state) => !states.includes(state)),
    ) +
    (filters.project?.length ?? 0) +
    (filters.read?.length ?? 0)
  );
}

/** 看板固定只展示普通对话，再应用运行状态、项目和阅读筛选。 */
export function matchesFilters(thread: Thread, filters: FilterValue): boolean {
  if (thread.kind !== "user") return false;
  // 缺少运行状态时使用默认值，显式清空时不匹配任何状态。
  const states = filters.state ?? DEFAULT_FILTERS.state;
  if (!states.includes(columnFor(thread))) return false;
  if (filters.project?.length && !filters.project.includes(thread.project))
    return false;
  if (
    filters.read?.length &&
    !filters.read.includes(
      thread.unread === null ? "unknown" : thread.unread ? "unread" : "read",
    )
  )
    return false;
  return true;
}
