import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  WorkItem,
  WorkItemInput,
  WorkItemSaveResult,
  WorkspaceData,
} from "../shared/work-items.js";

export const workItemInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000),
  status: z.enum(["planned", "active", "review", "done"]),
  threadIds: z.array(z.string().uuid()).max(500),
  checklist: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        text: z.string().trim().min(1).max(1000),
        done: z.boolean(),
      }),
    )
    .max(200),
  links: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        url: z
          .string()
          .max(4000)
          .url()
          .refine((value) =>
            ["http:", "https:", "codex:"].includes(new URL(value).protocol),
          ),
      }),
    )
    .max(100),
});

export const workItemThreadInput = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
});

/** 在插件自己的 SQLite 中保存事项，支持多个看板连接同时读写。 */
export class WorkspaceStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "kanban", "workspace.sqlite");
  }

  /** 首次查看返回空列表，只有保存事项时才创建数据库。 */
  read(): WorkspaceData {
    if (!existsSync(this.path)) return { items: [] };
    const database = new DatabaseSync(this.path, { readOnly: true });
    try {
      const rows = database
        .prepare("SELECT data FROM work_items ORDER BY updated_at DESC, id")
        .all() as { data: string }[];
      return { items: rows.map((row) => JSON.parse(row.data) as WorkItem) };
    } finally {
      database.close();
    }
  }

  /** 以单条事务保存事项，保留创建时间并明确返回本次保存的事项。 */
  save(input: WorkItemInput): WorkItemSaveResult {
    const value = workItemInput.parse(input);
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    let item: WorkItem;
    try {
      database.exec("PRAGMA busy_timeout=3000");
      database.exec(
        "CREATE TABLE IF NOT EXISTS work_items (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      database.exec("BEGIN IMMEDIATE");
      const previous = value.id
        ? (database
            .prepare("SELECT data FROM work_items WHERE id = ?")
            .get(value.id) as { data: string } | undefined)
        : undefined;
      if (value.id && !previous)
        throw new Error("工作事项不存在，请刷新后重试。");
      const now = new Date().toISOString();
      item = {
        ...value,
        id: value.id ?? randomUUID(),
        // 对话可以关联到多个事项，同一事项内只保存一次。
        threadIds: [...new Set(value.threadIds)],
        createdAt: previous
          ? (JSON.parse(previous.data) as WorkItem).createdAt
          : now,
        updatedAt: now,
      };
      database
        .prepare(
          "INSERT INTO work_items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        )
        .run(item.id, JSON.stringify(item), now);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    return { ...this.read(), item };
  }

  /** 只向最新事项追加关联，避免卡片中的旧快照覆盖说明和验收记录。 */
  addThread(id: string, threadId: string): WorkItemSaveResult {
    workItemThreadInput.parse({ id, threadId });
    if (!existsSync(this.path))
      throw new Error("工作事项不存在，请刷新后重试。");
    const database = new DatabaseSync(this.path);
    let item: WorkItem;
    try {
      database.exec("PRAGMA busy_timeout=3000");
      database.exec("BEGIN IMMEDIATE");
      const row = database
        .prepare("SELECT data FROM work_items WHERE id = ?")
        .get(id) as { data: string } | undefined;
      if (!row) throw new Error("工作事项不存在，请刷新后重试。");
      item = JSON.parse(row.data) as WorkItem;
      // 重复加入不改更新时间；同一操作重试不会产生重复关联。
      if (!item.threadIds.includes(threadId)) {
        if (item.threadIds.length >= 500)
          throw new RangeError("每个事项最多关联 500 条对话。");
        item = {
          ...item,
          threadIds: [...item.threadIds, threadId],
          updatedAt: new Date().toISOString(),
        };
        database
          .prepare(
            "UPDATE work_items SET data = ?, updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(item), item.updatedAt, id);
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    return { ...this.read(), item };
  }

  /** 删除插件中的事项记录，关联的 Codex 对话仍由宿主管理。 */
  delete(id: string): WorkspaceData {
    z.string().uuid().parse(id);
    if (!existsSync(this.path)) return { items: [] };
    const database = new DatabaseSync(this.path);
    try {
      database.exec("PRAGMA busy_timeout=3000");
      database.prepare("DELETE FROM work_items WHERE id = ?").run(id);
    } finally {
      database.close();
    }
    return this.read();
  }
}
