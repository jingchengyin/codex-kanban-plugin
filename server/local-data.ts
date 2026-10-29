import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Thread, ThreadLink } from "../shared/types.js";
import { TurnUsageReader } from "./turn-usage.js";

const turnUsageReader = new TurnUsageReader();
// 普通启动没有 WebSocket 地址，按客户端算法计算它的未读记录标识。
const normalLocalHost = `local:${createHash("sha256")
  .update(JSON.stringify(["local", "local", null]))
  .digest("hex")}`;
const goalStatuses: Record<string, Thread["goalStatus"]> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usage_limited: "usageLimited",
  budget_limited: "budgetLimited",
  complete: "complete",
};
function readGoals(home: string): Map<string, Thread["goalStatus"]> | null {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(home, "goals_1.sqlite"), {
      readOnly: true,
    });
    return new Map(
      (
        database
          .prepare("SELECT thread_id, status FROM thread_goals")
          .all() as any[]
      ).map((row) => [row.thread_id, goalStatuses[row.status] ?? null]),
    );
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

type ReadState = {
  ids: Set<string> | null;
  reason: string;
  options: { key: string; label: string; count: number }[];
};
export type LocalData = {
  threads: Thread[];
  metadata: boolean;
  metadataError: string | null;
  unread: boolean;
  unreadReason: string;
  unreadOptions: ReadState["options"];
};

/** 卡片和监听引用使用相同的对话类型规则，排除内部子 Agent。 */
function threadKind(row: {
  agent_role?: unknown;
  source?: unknown;
  thread_source?: unknown;
}): Thread["kind"] {
  return row.agent_role ||
    (typeof row.source === "string" && row.source.includes("subagent")) ||
    row.thread_source === "agent"
    ? "agent"
    : row.thread_source === "user" || row.source === "vscode"
      ? "user"
      : "unknown";
}

export function displayTitle(name: unknown, fallback: unknown): string {
  let value =
    typeof name === "string" && name.trim()
      ? name
      : String(fallback || "未命名对话");
  if (value.includes("## My request:"))
    value = value.split("## My request:").at(-1)!;
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.filter((line) => !/^https?:\/\/\S+$/.test(line));
  value = (useful.length ? useful : lines)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  value = value
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[已隐藏凭据]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[已隐藏凭据]")
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"']{8,}/gi,
      "$1[已隐藏凭据]",
    );
  return [...value].length > 120
    ? [...value].slice(0, 120).join("") + "…"
    : value || "未命名对话";
}

/** 读取客户端未读状态，自动模式优先复用普通启动记录。 */
export function parseUnread(
  state: unknown,
  selection: string | null = null,
  visibleThreadIds?: ReadonlySet<string>,
): ReadState {
  const missing = (reason: string): ReadState => ({
    ids: null,
    reason,
    options: [],
  });
  try {
    const accounts = (state as any)["electron-thread-read-state-v1"]
      ?.unreadByIdentity;
    if (
      !accounts ||
      typeof accounts !== "object" ||
      Object.keys(accounts).length !== 1
    )
      return missing("账号信息缺失或存在多个账号");
    const [account, hosts] = Object.entries(accounts)[0] as [
      string,
      Record<string, unknown>,
    ];
    if (!hosts || typeof hosts !== "object")
      return missing("本地主机数据不可用");
    const local = Object.entries(hosts).filter(
      ([host, ids]) =>
        host.startsWith("local:") &&
        Array.isArray(ids) &&
        ids.every((id) => typeof id === "string"),
    ) as [string, string[]][];
    const options = local.map(([host, ids]) => ({
      key: JSON.stringify([account, host]),
      label:
        host === normalLocalHost
          ? "普通启动记录"
          : `本地记录 ${host.slice(6, 14)}…`,
      count: visibleThreadIds
        ? new Set(ids.filter((id) => visibleThreadIds.has(id))).size
        : ids.length,
    }));
    // 来源由主机标识确定，不按未读数量选择，也不合并不同来源。
    const normal = local.find(([host]) => host === normalLocalHost);
    const chosen = selection
      ? local.find(([host]) => JSON.stringify([account, host]) === selection)
      : (normal ??
        (Object.keys(hosts).length === 1 && local.length === 1
          ? local[0]
          : undefined));
    if (!chosen)
      return {
        ids: null,
        reason: selection
          ? "所选记录已失效或账号已变化，请重新选择"
          : "本地主机记录不唯一，请在连接设置中明确选择；不会自动合并",
        options,
      };
    return {
      ids: new Set(chosen[1]),
      reason: selection
        ? "使用你明确选择的本地记录；当前登录身份未经独立确认"
        : chosen[0] === normalLocalHost
          ? "复用普通启动的未读记录；当前登录身份未经独立确认"
          : "本机唯一持久化账号与主机；当前登录身份未经独立确认",
      options,
    };
  } catch {
    return missing("未读信息不可用");
  }
}

export async function readLocalData(
  home: string,
  selection: string | null = null,
): Promise<LocalData> {
  let unread: ReadState = { ids: null, reason: "未读信息不可用", options: [] };
  let readState: unknown;
  try {
    readState = JSON.parse(
      await readFile(join(home, ".codex-global-state.json"), "utf8"),
    );
    unread = parseUnread(readState, selection, new Set());
  } catch {
    /* Missing data stays unknown. */
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(home, "state_5.sqlite"), {
      readOnly: true,
    });
    const columns = new Set(
      (database.prepare("PRAGMA table_info(threads)").all() as any[]).map(
        (row) => row.name,
      ),
    );
    const kind = columns.has("thread_source")
      ? "thread_source"
      : "NULL AS thread_source";
    const role = columns.has("agent_role")
      ? "agent_role"
      : "NULL AS agent_role";
    const name = columns.has("name") ? "name" : "NULL AS name";
    const model = columns.has("model") ? "model" : "NULL AS model";
    const effort = columns.has("reasoning_effort")
      ? "reasoning_effort"
      : "NULL AS reasoning_effort";
    const rollout = columns.has("rollout_path")
      ? "rollout_path"
      : "NULL AS rollout_path";
    const rows = database
      .prepare(
        `SELECT id, title, ${name}, ${model}, ${effort}, ${rollout}, cwd, updated_at, source, ${kind}, ${role} FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 500`,
      )
      .all() as any[];
    const threads: Thread[] = rows.map((row) => ({
      id: String(row.id),
      title: displayTitle(row.name, row.title),
      cwd: String(row.cwd || ""),
      project: basename(String(row.cwd || "")) || "未归属项目",
      updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(),
      lastUserMessageAt: null,
      kind: threadKind(row),
      unread: unread.ids ? unread.ids.has(row.id) : null,
      model:
        typeof row.model === "string" && row.model.trim() ? row.model : null,
      reasoningEffort:
        typeof row.reasoning_effort === "string" && row.reasoning_effort.trim()
          ? row.reasoning_effort
          : null,
      collaborationMode: null,
      goalStatus: null,
      turnUsage: null,
      monitoring: [],
      monitoredBy: [],
      runtime: null,
      runtimeAt: null,
      fresh: false,
      error: null,
    }));
    // 客户端未读集合也包含子 Agent，来源计数只统计看板中的普通对话。
    unread = parseUnread(
      readState,
      selection,
      new Set(
        threads
          .filter((thread) => thread.kind === "user")
          .map((thread) => thread.id),
      ),
    );
    const goals = readGoals(home);
    const monitoring = new Map<string, string[]>();
    for (let offset = 0; offset < threads.length; offset += 8)
      await Promise.all(
        threads.slice(offset, offset + 8).map(async (thread, index) => {
          thread.goalStatus = goals
            ? goals.has(thread.id)
              ? goals.get(thread.id)!
              : "none"
            : null;
          const path = rows[offset + index].rollout_path;
          if (typeof path === "string" && path) {
            const { monitoringThreadIds, ...metadata } =
              await turnUsageReader.read(path);
            Object.assign(thread, metadata);
            if (thread.kind === "user")
              monitoring.set(thread.id, monitoringThreadIds);
          }
        }),
      );
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const references = new Map<string, ThreadLink | null>();
    const findReference = database.prepare(
      `SELECT id, title, ${name}, source, ${kind}, ${role} FROM threads WHERE id = ?`,
    );
    for (const thread of threads) {
      for (const id of monitoring.get(thread.id) ?? []) {
        if (id === thread.id) continue;
        if (!references.has(id)) {
          const target = byId.get(id);
          // 目标不在最近 500 条中或已归档时，仍读取当前标题供回查。
          const row = target ? null : (findReference.get(id) as any);
          references.set(
            id,
            target?.kind === "user"
              ? { id, title: target.title }
              : row && threadKind(row) === "user"
                ? { id, title: displayTitle(row.name, row.title) }
                : null,
          );
        }
        const reference = references.get(id);
        if (!reference) continue;
        thread.monitoring!.push(reference);
        byId.get(id)?.monitoredBy!.push({
          id: thread.id,
          title: thread.title,
        });
      }
    }
    return {
      threads,
      metadata: true,
      metadataError: null,
      unread: unread.ids !== null,
      unreadReason: unread.reason,
      unreadOptions: unread.options,
    };
  } catch {
    return {
      threads: [],
      metadata: false,
      metadataError:
        "无法读取本机 Codex 对话索引，请检查 CODEX_HOME 或客户端版本。",
      unread: unread.ids !== null,
      unreadReason: unread.reason,
      unreadOptions: unread.options,
    };
  } finally {
    database?.close();
  }
}
