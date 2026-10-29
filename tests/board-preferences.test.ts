import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS } from "../ui/board-filters";
import {
  PREFERENCE_KEY,
  readBoardPreferences,
  type BoardPreferences,
} from "../ui/board-preferences";

const defaults: BoardPreferences = {
  view: "board",
  scope: "all",
  filters: DEFAULT_FILTERS,
  sort: "priority",
  layout: "auto",
};

/** 用内存中的存储值验证恢复行为，不触碰用户浏览器偏好。 */
function storage(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem(key) {
      assert.equal(key, PREFERENCE_KEY);
      return value;
    },
  };
}

const saved = (value: unknown) => storage(JSON.stringify(value));

test("first open and unreadable preferences fall back to a board that includes awaiting-sync conversations", () => {
  for (const value of [
    null,
    "",
    "{broken",
    "null",
    '"old-value"',
    "false",
    "42",
  ])
    assert.deepEqual(readBoardPreferences(storage(value)), defaults);
  assert.deepEqual(
    readBoardPreferences({
      getItem() {
        throw new Error("Storage is unavailable");
      },
    }),
    defaults,
  );
  assert.ok(
    readBoardPreferences(storage(null)).filters.state.includes("unknown"),
  );
});

test("reopening restores the user's work view, project scope, sorting and layout", () => {
  const previous: BoardPreferences = {
    view: "items",
    scope: "attention",
    filters: {
      state: ["waiting", "error", "unknown"],
      project: ["kanban-plugin", "search-service"],
      read: ["unread"],
    },
    sort: "recent",
    layout: "list",
  };
  assert.deepEqual(readBoardPreferences(saved(previous)), previous);
  assert.equal(
    readBoardPreferences(
      saved({ view: "review", sort: "title", layout: "board" }),
    ).view,
    "review",
  );
});

test("explicitly deselected states stay deselected instead of silently changing the user's filters", () => {
  const result = readBoardPreferences(
    saved({ filters: { state: [], project: [], read: [] } }),
  );
  assert.deepEqual(result.filters, { state: [], project: [], read: [] });
});

test("old or partially damaged preferences retain supported values and drop invalid filter options", () => {
  assert.deepEqual(
    readBoardPreferences(
      saved({
        view: "obsolete",
        scope: "everything",
        sort: "updatedAt",
        layout: "cards",
        filters: {
          state: ["waiting", "obsolete", "waiting", "unknown"],
          read: ["unread", "future-read-value", "unread"],
          project: ["kanban", "kanban", "search"],
          kind: ["agent"],
        },
        query: "private old search",
        token: "unrelated field",
      }),
    ),
    {
      ...defaults,
      filters: {
        state: ["waiting", "unknown"],
        read: ["unread"],
        project: ["kanban", "search"],
      },
    },
  );
  assert.deepEqual(
    readBoardPreferences(
      saved({ filters: { state: "running", project: [7], read: null } }),
    ),
    defaults,
  );
});

test("obsolete states alone restore a browsable default while an explicit empty selection remains empty", () => {
  assert.deepEqual(
    readBoardPreferences(
      saved({ filters: { state: ["obsolete"], project: ["kanban"] } }),
    ).filters,
    { state: DEFAULT_FILTERS.state, project: ["kanban"] },
  );
  assert.deepEqual(
    readBoardPreferences(saved({ filters: { state: [] } })).filters.state,
    [],
  );
  assert.deepEqual(
    readBoardPreferences(saved({ filters: { read: ["obsolete"] } })).filters,
    DEFAULT_FILTERS,
  );
});
