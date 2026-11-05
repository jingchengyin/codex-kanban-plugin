import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkItem } from "../shared/work-items";
import {
  DEFAULT_WORK_ITEM_FILTERS,
  matchesWorkItemFilters,
  WORK_ITEM_STATUSES,
} from "../ui/work-item-filters";

const items: WorkItem[] = DEFAULT_WORK_ITEM_FILTERS.status.map((state) => ({
  id: state,
  title: `${state} collection`,
  description: state === "review" ? "Release checklist" : "",
  status: state as WorkItem["status"],
  threadIds: [],
  checklist: [],
  links: [],
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
}));

test("default and cleared collection filters match every status", () => {
  assert.deepEqual(Object.keys(WORK_ITEM_STATUSES), [
    "planned",
    "active",
    "review",
    "done",
  ]);
  for (const filters of [DEFAULT_WORK_ITEM_FILTERS, {}]) {
    assert.deepEqual(
      items.filter((item) => matchesWorkItemFilters(item, "", filters)),
      items,
    );
  }
});

test("collection filters match one or multiple selected statuses", () => {
  for (const states of [
    ["active"],
    ["active", "review"],
    ["planned", "done"],
  ]) {
    assert.deepEqual(
      items
        .filter((item) => matchesWorkItemFilters(item, "", { status: states }))
        .map((item) => item.id),
      states,
    );
  }
});

test("deselecting every collection status matches no collections", () => {
  assert.deepEqual(
    items.filter((item) => matchesWorkItemFilters(item, "", { status: [] })),
    [],
  );
});

test("collection search combines with selected statuses and remains case insensitive", () => {
  const filters = { status: ["active", "review"] };
  assert.deepEqual(
    items
      .filter((item) => matchesWorkItemFilters(item, " ACTIVE ", filters))
      .map((item) => item.id),
    ["active"],
  );
  assert.deepEqual(
    items
      .filter((item) => matchesWorkItemFilters(item, " RELEASE ", filters))
      .map((item) => item.id),
    ["review"],
  );
  assert.deepEqual(
    items.filter((item) => matchesWorkItemFilters(item, "done", filters)),
    [],
  );
});
