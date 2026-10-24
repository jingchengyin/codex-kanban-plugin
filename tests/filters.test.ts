import { test } from "node:test";
import assert from "node:assert/strict";
import {
  belongsToColumn,
  type BoardColumn,
  type Thread,
} from "../shared/types";
import { isColumnVisible, matchesFilters } from "../ui/board-filters";
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

test("default and cleared filters hide the pending-sync column and its cards, keeping unread conversations", () => {
  const defaults: FilterValue[] = [{}, { state: [] }, { kind: ["user"] }];
  for (const filters of defaults) {
    assert.deepEqual(
      columns.filter((column) => isColumnVisible(column, filters.state)),
      ["waiting", "running", "unread", "idle", "error"],
    );
    assert.deepEqual(
      threads
        .filter((thread) => matchesFilters(thread, filters))
        .map((thread) => thread.id),
      ["waiting", "running", "idle", "error", "unread-idle", "unread-unknown"],
    );
  }
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

test("multiple runtime selections combine with project, kind, and read filters", () => {
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
          kind: ["user"],
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
    assert.equal(matchesFilters(thread, {}), false);
    assert.equal(matchesFilters(thread, { state: ["running"] }), false);
    assert.equal(matchesFilters(thread, { state: ["unknown"] }), true);
  }
});
