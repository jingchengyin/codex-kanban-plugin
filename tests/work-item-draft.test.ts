import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../server/work-items";
import {
  reconcileWorkItemDraft,
  workItemSaveInput,
} from "../ui/work-item-draft";
import type { WorkItem } from "../shared/work-items";

const original: WorkItem = {
  id: "a0000000-0000-4000-8000-000000000001",
  title: "发布插件",
  description: "原说明",
  status: "active",
  threadIds: ["b0000000-0000-4000-8000-000000000001"],
  checklist: [{ id: "verify", text: "验证安装", done: false }],
  links: [],
  createdAt: "2026-10-28T01:00:00.000Z",
  updatedAt: "2026-10-28T01:00:00.000Z",
};
const extraThread = "b0000000-0000-4000-8000-000000000002";
const latest: WorkItem = {
  ...original,
  threadIds: [...original.threadIds, extraThread],
  updatedAt: "2026-10-28T02:00:00.000Z",
};
const saved = JSON.stringify(workItemSaveInput(original));

test("a clean editor adopts the latest item when returning from the board", () => {
  const updated = reconcileWorkItemDraft(original, saved, latest)!;
  assert.deepEqual(updated.draft, latest);
  assert.equal(updated.saved, JSON.stringify(workItemSaveInput(latest)));
  assert.notEqual(updated.draft, latest);
  assert.equal(
    reconcileWorkItemDraft(updated.draft, updated.saved, latest),
    null,
  );
});

test("refresh preserves unsaved fields while updating association and its saved baseline", () => {
  const draft = {
    ...original,
    description: "正在编辑的新说明",
    checklist: [{ ...original.checklist[0], done: true }],
    links: [{ label: "尚未填完的链接", url: "" }],
  };
  const updated = reconcileWorkItemDraft(draft, saved, latest)!;
  assert.deepEqual(updated.draft, { ...draft, threadIds: latest.threadIds });
  assert.deepEqual(JSON.parse(updated.saved), {
    ...original,
    threadIds: latest.threadIds,
  });
  assert.notEqual(
    JSON.stringify(workItemSaveInput(updated.draft)),
    updated.saved,
  );
  assert.deepEqual(draft.threadIds, original.threadIds);
  assert.equal(
    reconcileWorkItemDraft(updated.draft, updated.saved, latest),
    null,
  );
});

test("refresh keeps local association edits and ignores unrelated items", () => {
  const removed = { ...original, threadIds: [], description: "保留我的调整" };
  assert.equal(reconcileWorkItemDraft(removed, saved, latest), null);
  assert.equal(
    reconcileWorkItemDraft(original, saved, { ...latest, id: extraThread }),
    null,
  );
  assert.equal(
    reconcileWorkItemDraft({ ...original, id: undefined }, "", latest),
    null,
  );
});

test("saving an edited description after a card association retains both conversations", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-draft-reconcile-"));
  try {
    const store = new WorkspaceStore(home);
    const initial = store.save({ ...original, id: undefined }).item;
    const baseline = JSON.stringify(workItemSaveInput(initial));
    const linked = store.addThread(initial.id, extraThread).item;
    const refreshed = reconcileWorkItemDraft(initial, baseline, linked)!;
    const updated = store.save({
      ...refreshed.draft,
      description: "返回后修改的说明",
    }).item;
    assert.equal(updated.description, "返回后修改的说明");
    assert.deepEqual(updated.threadIds, [...original.threadIds, extraThread]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
