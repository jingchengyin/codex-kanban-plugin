import type { BoardScope } from "../shared/types";
import type { FilterValue } from "./vendor/affectui/filter-menu";
import { DEFAULT_FILTERS } from "./board-filters";

export type BoardPreferences = {
  view: "board" | "items" | "review";
  scope: BoardScope;
  filters: FilterValue;
  sort: "priority" | "recent" | "title";
  layout: "auto" | "board" | "list";
};
export const PREFERENCE_KEY = "taskboard:board-preferences";

/** 只恢复已知视图和有效筛选；旧值或损坏数据回到可浏览的默认状态。 */
export function readBoardPreferences(
  storage: Pick<Storage, "getItem">,
): BoardPreferences {
  const defaults: BoardPreferences = {
    view: "board",
    scope: "all",
    filters: DEFAULT_FILTERS,
    sort: "priority",
    layout: "auto",
  };
  try {
    const value = JSON.parse(storage.getItem(PREFERENCE_KEY) ?? "null");
    if (!value || typeof value !== "object") return defaults;
    const filters: FilterValue = {};
    for (const key of ["state", "project", "read"] as const) {
      const options = value.filters?.[key];
      if (
        !Array.isArray(options) ||
        !options.every((item) => typeof item === "string")
      )
        continue;
      const allowed =
        key === "state"
          ? DEFAULT_FILTERS.state
          : key === "read"
            ? ["read", "unread", "unknown"]
            : null;
      const valid = [...new Set<string>(options)].filter(
        (item) => !allowed || allowed.includes(item),
      );
      // 过期枚举回到默认；用户主动取消全部状态的空数组仍保留。
      if (!options.length || valid.length) filters[key] = valid;
    }
    return {
      view: ["board", "items", "review"].includes(value.view)
        ? value.view
        : defaults.view,
      scope: value.scope === "attention" ? "attention" : "all",
      filters: { ...DEFAULT_FILTERS, ...filters },
      sort: ["priority", "recent", "title"].includes(value.sort)
        ? value.sort
        : defaults.sort,
      layout: ["auto", "board", "list"].includes(value.layout)
        ? value.layout
        : defaults.layout,
    };
  } catch {
    return defaults;
  }
}
