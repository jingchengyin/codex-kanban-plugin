import { test } from "node:test";
import assert from "node:assert/strict";
import {
  belongsToColumn,
  type BoardColumn,
  type Thread,
} from "../shared/types";
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  compareAttention,
  isColumnVisible,
  matchesFilters,
  matchesQuery,
} from "../ui/board-filters";
import type { FilterValue } from "../ui/vendor/affectui/filter-menu";

const columns: BoardColumn[] = [
  "waiting",
  "running",
  "unread",
  "idle",
  "error",
  "unknown",
];
const base: Thread = {
  id: "running",
  title: "Running conversation",
  cwd: "/work/project",
  project: "project",
  updatedAt: "2026-10-24T00:00:00Z",
  lastUserMessageAt: null,
  kind: "user",
  model: null,
  reasoningEffort: null,
  collaborationMode: null,
  goalStatus: null,
  turnUsage: null,
  unread: false,
  runtime: { type: "active", activeFlags: [] },
  runtimeAt: null,
  fresh: true,
  error: null,
};
const threads: Thread[] = [
  {
    ...base,
    id: "waiting",
    runtime: { type: "active", activeFlags: ["waitingOnApproval"] },
  },
  base,
  { ...base, id: "idle", runtime: { type: "idle" } },
  { ...base, id: "error", runtime: { type: "systemError" } },
  { ...base, id: "unknown", runtime: null },
  { ...base, id: "unread-idle", unread: true, runtime: { type: "idle" } },
  { ...base, id: "unread-unknown", unread: true, runtime: null },
];

test("default and cleared filters keep local conversations visible before live sync or after disconnect", () => {
  assert.deepEqual(DEFAULT_FILTERS.state, [
    "waiting",
    "running",
    "idle",
    "error",
    "unknown",
  ]);
  const defaults: FilterValue[] = [{}, DEFAULT_FILTERS];
  for (const filters of defaults) {
    assert.deepEqual(
      columns.filter((column) => isColumnVisible(column, filters.state)),
      ["waiting", "running", "unread", "idle", "error", "unknown"],
    );
    assert.deepEqual(
      threads
        .filter((thread) => matchesFilters(thread, filters))
        .map((thread) => thread.id),
      threads.map((thread) => thread.id),
    );
  }
});

test("deselecting every runtime state hides all columns and conversations", () => {
  assert.deepEqual(
    columns.filter((column) => isColumnVisible(column, [])),
    [],
  );
  assert.deepEqual(
    threads.filter((thread) => matchesFilters(thread, { state: [] })),
    [],
  );
});

test("only ordinary conversations match, including after clearing filters or receiving old kind selections", () => {
  for (const kind of ["agent", "unknown"] as const) {
    const thread = { ...base, kind };
    for (const filters of [DEFAULT_FILTERS, {}, { kind: [kind] }])
      assert.equal(matchesFilters(thread, filters), false);
  }
  assert.equal(matchesFilters(base, { kind: ["agent"] }), true);
});

test("runtime filters select matching conversations and columns, including explicitly selected pending-sync", () => {
  const cases: [string, BoardColumn[], string[]][] = [
    ["waiting", ["waiting"], ["waiting"]],
    ["running", ["running"], ["running"]],
    ["idle", ["unread", "idle"], ["idle", "unread-idle"]],
    ["error", ["error"], ["error"]],
    ["unknown", ["unread", "unknown"], ["unknown", "unread-unknown"]],
  ];
  for (const [state, expectedColumns, expectedIds] of cases) {
    const visible = columns.filter((column) =>
      isColumnVisible(column, [state]),
    );
    const displayed = threads.filter((thread) =>
      matchesFilters(thread, { state: [state] }),
    );
    assert.deepEqual(visible, expectedColumns, state);
    assert.deepEqual(
      displayed.map((thread) => thread.id),
      expectedIds,
      state,
    );
    for (const thread of displayed)
      assert.equal(
        visible.filter((column) => belongsToColumn(thread, column)).length,
        1,
      );
  }
});

test("multiple runtime selections combine with project and read filters", () => {
  const values: Thread[] = [
    ...threads,
    { ...base, id: "other-project", project: "other" },
    { ...base, id: "agent", kind: "agent" },
    { ...base, id: "unknown-read", unread: null },
  ];
  assert.deepEqual(
    values
      .filter((thread) =>
        matchesFilters(thread, {
          state: ["waiting", "running"],
          project: ["project"],
          read: ["read"],
        }),
      )
      .map((thread) => thread.id),
    ["waiting", "running"],
  );
  assert.deepEqual(
    values
      .filter((thread) =>
        matchesFilters(thread, {
          state: ["running"],
          read: ["unknown"],
        }),
      )
      .map((thread) => thread.id),
    ["unknown-read"],
  );
  assert.deepEqual(
    columns.filter((column) => isColumnVisible(column, ["running", "unknown"])),
    ["running", "unread", "unknown"],
  );
});

test("stale and unloaded runtime only match pending-sync regardless of their last known status", () => {
  for (const thread of [
    { ...base, fresh: false },
    { ...base, runtime: { type: "notLoaded" as const } },
  ]) {
    assert.equal(matchesFilters(thread, {}), true);
    assert.equal(matchesFilters(thread, { state: ["running"] }), false);
    assert.equal(matchesFilters(thread, { state: ["unknown"] }), true);
  }
});

test("disconnected conversations remain visible exactly once while their old run state is not trusted", () => {
  const disconnected = threads.map((thread) => ({ ...thread, fresh: false }));
  for (const thread of disconnected) {
    assert.equal(matchesFilters(thread, DEFAULT_FILTERS), true);
    assert.equal(
      matchesFilters(thread, { state: ["waiting", "running", "error"] }),
      false,
    );
    const assigned = columns.filter((column) =>
      belongsToColumn(thread, column),
    );
    assert.deepEqual(assigned, [thread.unread ? "unread" : "unknown"]);
  }
});

test("search finds visible user input and linked work item titles alongside conversation identity", () => {
  const value: Thread = {
    ...base,
    id: "a0000000-0000-4000-8000-000000000001",
    title: "修复发布流程",
    project: "Kanban-Plugin",
    turnUsage: {
      id: "turn",
      userInput: "请检查 Origin 校验失败的原因",
      status: "completed",
      startedAt: null,
      completedAt: null,
      updatedAt: base.updatedAt,
      tokens: null,
      durationMs: null,
    },
  };
  for (const query of [
    "发布流程",
    "kanban-plugin",
    "000000000001",
    " origin 校验 ",
    "插件发布验收",
    "  ",
  ])
    assert.equal(matchesQuery(value, query, ["插件发布验收"]), true, query);
  assert.equal(matchesQuery(value, "数据库迁移", ["插件发布验收"]), false);
  assert.equal(matchesQuery({ ...value, turnUsage: null }, "Origin"), false);
  assert.equal(
    matchesQuery(
      { ...value, turnUsage: { ...value.turnUsage!, userInput: null } },
      "Origin",
    ),
    false,
  );
});

test("attention order puts waiting before errors and unread, with longer observed waits first", () => {
  const waiting: Thread = {
    ...base,
    runtime: { type: "active", activeFlags: ["waitingOnUserInput"] },
  };
  const values: Thread[] = [
    {
      ...base,
      id: "unread",
      unread: true,
      lastUserMessageAt: "2026-10-28T03:00:00Z",
    },
    { ...waiting, id: "waiting-unknown", waitingSince: null },
    { ...base, id: "running", lastUserMessageAt: "2026-10-28T04:00:00Z" },
    { ...base, id: "error", runtime: { type: "systemError" }, unread: true },
    {
      ...waiting,
      id: "waiting-recent",
      waitingSince: "2026-10-28T02:00:00Z",
      lastUserMessageAt: "2026-10-28T03:00:00Z",
    },
    {
      ...waiting,
      id: "waiting-long",
      waitingSince: "2026-10-28T01:00:00Z",
      lastUserMessageAt: "2026-10-28T01:00:00Z",
    },
  ];
  assert.deepEqual(
    values.sort(compareAttention).map((thread) => thread.id),
    [
      "waiting-long",
      "waiting-recent",
      "waiting-unknown",
      "error",
      "unread",
      "running",
    ],
  );
  const sameWait = values
    .filter((thread) => thread.id.startsWith("waiting-"))
    .map((thread) => ({ ...thread, waitingSince: "2026-10-28T01:00:00Z" }));
  assert.deepEqual(
    sameWait.sort(compareAttention).map((thread) => thread.id),
    ["waiting-recent", "waiting-long", "waiting-unknown"],
  );
});

test("attention order treats stale waits as unknown instead of demanding action on old runtime", () => {
  const stale: Thread = {
    ...base,
    id: "stale",
    fresh: false,
    runtime: { type: "active", activeFlags: ["waitingOnApproval"] },
    waitingSince: "2026-10-28T00:00:00Z",
  };
  const unread = { ...base, id: "unread", unread: true };
  const error = {
    ...base,
    id: "error",
    runtime: { type: "systemError" as const },
  };
  assert.deepEqual(
    [stale, unread, error].sort(compareAttention).map((thread) => thread.id),
    ["error", "unread", "stale"],
  );
});

test("filter badge counts only choices that change the default browsing scope", () => {
  assert.equal(activeFilterCount({}), 0);
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(
    activeFilterCount({ state: [...DEFAULT_FILTERS.state].reverse() }),
    0,
  );
  assert.equal(activeFilterCount({ state: [] }), 1);
  assert.equal(
    activeFilterCount({
      state: ["waiting"],
      project: ["kanban", "search"],
      read: ["unread"],
    }),
    4,
  );
});
