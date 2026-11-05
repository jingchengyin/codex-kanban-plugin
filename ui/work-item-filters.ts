import type { WorkItem, WorkItemStatus } from "../shared/work-items";
import type { FilterValue } from "./vendor/affectui/filter-menu";

export const WORK_ITEM_STATUSES = {
  planned: "待开始",
  active: "进行中",
  review: "待验收",
  done: "已验收",
} as const satisfies Record<WorkItemStatus, string>;

/** 默认勾选全部合集状态，清除筛选后恢复同一组默认值。 */
export const DEFAULT_WORK_ITEM_FILTERS: FilterValue = {
  status: Object.keys(WORK_ITEM_STATUSES),
};

/** 状态之间按任一匹配，搜索条件与状态筛选同时生效。 */
export function matchesWorkItemFilters(
  item: WorkItem,
  query: string,
  filters: FilterValue,
): boolean {
  // 缺少状态条件时展示全部，显式取消所有勾选时不匹配任何合集。
  const states = filters.status ?? DEFAULT_WORK_ITEM_FILTERS.status;
  return (
    states.includes(item.status) &&
    `${item.title} ${item.description}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
}
