import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../server/work-items.js";
import type { WorkItemInput } from "../shared/work-items.js";
import { workItemIcons } from "../shared/work-item-icons.js";

const threadId = "a0000000-0000-4000-8000-000000000001";
const input: WorkItemInput = {
  title: "发布插件新版",
  description: "实现、验证和说明放在一起。",
  status: "active",
  threadIds: [threadId, threadId],
  checklist: [{ id: "install", text: "检查安装流程", done: false }],
  links: [{ label: "变更", url: "https://example.com/pull/1" }],
};

test("work items persist independently, keep manual acceptance and preserve unavailable conversation links", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-items-"));
  try {
    const nativePath = join(home, "state_5.sqlite");
    await writeFile(nativePath, "native-data-unchanged");
    const store = new WorkspaceStore(home);
    assert.deepEqual(store.read(), { items: [] });
    assert.equal(existsSync(store.path), false);
    const creation = store.save(input);
    const created = creation.item;
    assert.deepEqual(created, creation.items[0]);
    assert.equal(created.title, input.title);
    assert.deepEqual(created.threadIds, [threadId]);
    assert.equal(created.status, "active");
    assert.deepEqual(new WorkspaceStore(home).read().items, [created]);
    const update = store.save({
      ...created,
      status: "done",
      checklist: [{ ...created.checklist[0], done: true }],
    });
    const updated = update.item;
    assert.deepEqual(updated, update.items[0]);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.status, "done");
    assert.equal(updated.checklist[0].done, true);
    assert.deepEqual(updated.threadIds, [threadId]);
    assert.deepEqual(store.delete(created.id), { items: [] });
    assert.equal(await readFile(nativePath, "utf8"), "native-data-unchanged");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("save identifies the created or updated item when several items share a title", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-item-result-"));
  try {
    const store = new WorkspaceStore(home);
    const first = store.save(input).item;
    const second = store.save(input).item;
    const third = store.save(input);
    assert.notEqual(third.item.id, first.id);
    assert.notEqual(third.item.id, second.id);
    assert.equal(third.items.length, 3);
    assert.deepEqual(
      third.item,
      third.items.find((item) => item.id === third.item.id),
    );

    const update = store.save({ ...second, description: "自动保存的最新修改" });
    assert.equal(update.item.id, second.id);
    assert.equal(update.item.description, "自动保存的最新修改");
    assert.equal(update.item.createdAt, second.createdAt);
    assert.equal(update.items.length, 3);
    assert.deepEqual(
      update.item,
      update.items.find((item) => item.id === second.id),
    );
    assert.deepEqual(
      update.items.find((item) => item.id === first.id),
      first,
    );
    assert.deepEqual(
      update.items.find((item) => item.id === third.item.id),
      third.item,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("work item icons default once, persist manual choices and survive edits from older clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-item-icons-"));
  try {
    const store = new WorkspaceStore(home);
    const created = store.save(input).item;
    assert.ok(created.icon && workItemIcons.includes(created.icon));
    assert.equal(new WorkspaceStore(home).read().items[0].icon, created.icon);
    const selected = store.save({ ...created, icon: "compass" }).item;
    assert.equal(selected.icon, "compass");
    const { icon: _icon, ...olderInput } = selected;
    const updated = store.save({ ...olderInput, title: "更新事项名称" }).item;
    assert.equal(updated.icon, "compass");
    const linked = store.addThread(
      updated.id,
      "a0000000-0000-4000-8000-000000000002",
    );
    assert.equal(linked.item.icon, "compass");
    assert.equal(new WorkspaceStore(home).read().items[0].icon, "compass");
    assert.throws(() =>
      store.save({ ...updated, icon: "unknown" } as unknown as WorkItemInput),
    );
    assert.deepEqual(store.read().items, linked.items);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy work items get a stable icon without rewriting their stored record", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "taskboard-work-item-legacy-icon-"),
  );
  try {
    const store = new WorkspaceStore(home);
    const { icon: _icon, ...legacy } = store.save(input).item;
    const database = new DatabaseSync(store.path);
    try {
      database
        .prepare("UPDATE work_items SET data = ? WHERE id = ?")
        .run(JSON.stringify(legacy), legacy.id);
      const first = store.read().items[0];
      assert.ok(first.icon && workItemIcons.includes(first.icon));
      assert.deepEqual(new WorkspaceStore(home).read().items, [first]);
      const row = database
        .prepare("SELECT data FROM work_items WHERE id = ?")
        .get(legacy.id) as { data: string };
      assert.deepEqual(JSON.parse(row.data), legacy);
      assert.equal(store.addThread(legacy.id, threadId).item.icon, first.icon);
      assert.equal(store.save(legacy).item.icon, first.icon);
    } finally {
      database.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid edits cannot overwrite an existing work item or create an unexpected item", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-item-validation-"));
  try {
    const store = new WorkspaceStore(home);
    const created = store.save(input).items[0];
    assert.throws(() => store.save({ ...created, title: "  " }));
    assert.throws(() =>
      store.save({
        ...created,
        links: [{ label: "bad", url: "javascript:alert(1)" }],
      }),
    );
    assert.throws(
      () =>
        store.save({ ...created, id: "a0000000-0000-4000-8000-000000000099" }),
      /不存在/,
    );
    assert.deepEqual(store.read().items, [created]);
    assert.throws(() => store.delete("not-an-id"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("adding a thread preserves the latest work item and repeated additions are idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-item-link-"));
  try {
    const store = new WorkspaceStore(home);
    const initial = store.save(input).item;
    const latest = store.save({
      ...initial,
      title: "已更新的事项名称",
      description: "保留另一入口刚保存的说明",
      status: "done",
      checklist: [{ ...initial.checklist[0], done: true }],
      links: [{ label: "最新成果", url: "https://example.com/pull/2" }],
    }).item;
    const extraThreadId = "a0000000-0000-4000-8000-000000000002";
    const linked = store.addThread(initial.id, extraThreadId);
    assert.deepEqual(linked.item, {
      ...latest,
      threadIds: [threadId, extraThreadId],
      updatedAt: linked.item.updatedAt,
    });
    assert.deepEqual(linked.items, [linked.item]);
    assert.deepEqual(
      new WorkspaceStore(home).addThread(initial.id, extraThreadId),
      linked,
    );
    assert.deepEqual(store.read().items, [linked.item]);
    assert.throws(() => store.addThread(initial.id, "invalid"));
    assert.throws(() => store.addThread(extraThreadId, threadId), /不存在/);
    assert.deepEqual(store.read().items, [linked.item]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("adding a thread respects the existing limit without rejecting an existing association", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-work-item-link-limit-"));
  try {
    const store = new WorkspaceStore(home);
    assert.throws(() => store.addThread(threadId, threadId), /不存在/);
    assert.equal(existsSync(store.path), false);
    const full = store.save({
      ...input,
      threadIds: Array.from(
        { length: 500 },
        (_, index) =>
          `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    }).item;
    assert.throws(() => store.addThread(full.id, threadId), /500/);
    assert.deepEqual(store.addThread(full.id, full.threadIds[0]).item, full);
    assert.deepEqual(store.read().items, [full]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
