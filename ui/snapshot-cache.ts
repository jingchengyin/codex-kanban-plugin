import { columnFor, type Snapshot } from "../shared/types";

export const SNAPSHOT_CACHE_KEY = "taskboard:last-snapshot";

/** 缓存只恢复列表；所有运行状态与确认操作都要等待实时连接重新核对。 */
export function cachedSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    cached: true,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      cachedColumn: thread.cachedColumn ?? columnFor(thread),
      fresh: false,
      pendingUserInput: false,
      waitingQuestion: null,
      waitingSince: null,
    })),
    confirmations: { available: false, requests: [] },
    syncingThreads: false,
    connection: {
      ...snapshot.connection,
      state: "connecting",
      since: null,
      message: null,
    },
  };
}

/** 切回页面先沿用已知分列，单条真实状态恢复后立即替换缓存。 */
export function reconcileSnapshot(
  previous: Snapshot | null,
  next: Snapshot,
): Snapshot {
  if (!previous) return next;
  if (!next.sources.metadata && previous.threads.length)
    return cachedSnapshot({ ...next, threads: previous.threads });
  // 成功读到空目录代表对话已清空，不能让旧列表永久留在页面。
  if (!next.threads.length) return next;
  const known = new Map(previous.threads.map((thread) => [thread.id, thread]));
  const threads: Snapshot["threads"] = next.threads.map((thread) => {
    const { cachedColumn: _cached, ...current } = thread;
    if (thread.fresh || thread.runtime?.type === "notLoaded") return current;
    const old = known.get(thread.id);
    const column =
      old?.cachedColumn ?? (old?.fresh ? columnFor(old) : "unknown");
    if (!old || column === "unknown") return current;
    return {
      ...current,
      runtime: old.runtime,
      runtimeAt: old.runtimeAt,
      cachedColumn: column,
      fresh: false,
      pendingUserInput: false,
      waitingSince: null,
      waitingQuestion: null,
    };
  });
  const freshIds = new Set(
    next.threads.filter((thread) => thread.fresh).map((thread) => thread.id),
  );
  return {
    ...next,
    threads,
    cached: threads.some((thread) => thread.cachedColumn !== undefined),
    syncingThreads: false,
    confirmations: next.confirmations
      ? {
          ...next.confirmations,
          requests: next.confirmations.requests.filter((request) =>
            freshIds.has(request.threadId),
          ),
        }
      : undefined,
  };
}

/** 检查列表渲染必需的字段，损坏或旧格式数据不进入界面。 */
function validSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Snapshot | null;
  return (
    !!snapshot &&
    snapshot.schemaVersion === 1 &&
    typeof snapshot.generatedAt === "string" &&
    !!snapshot.connection &&
    typeof snapshot.connection.endpoint === "string" &&
    !!snapshot.sources &&
    snapshot.sources.metadata === true &&
    typeof snapshot.sources.unread === "boolean" &&
    typeof snapshot.sources.unreadReason === "string" &&
    Array.isArray(snapshot.sources.unreadOptions) &&
    snapshot.sources.unreadOptions.every(
      (option) =>
        !!option &&
        typeof option.key === "string" &&
        typeof option.label === "string" &&
        typeof option.count === "number",
    ) &&
    Array.isArray(snapshot.threads) &&
    snapshot.threads.length > 0 &&
    snapshot.threads.every(
      (thread) =>
        !!thread &&
        typeof thread.id === "string" &&
        typeof thread.title === "string" &&
        typeof thread.cwd === "string" &&
        typeof thread.project === "string" &&
        typeof thread.updatedAt === "string" &&
        (thread.lastUserMessageAt == null ||
          typeof thread.lastUserMessageAt === "string") &&
        (thread.cachedColumn === undefined ||
          ["waiting", "running", "idle", "error", "unknown"].includes(
            thread.cachedColumn,
          )) &&
        ["user", "agent", "unknown"].includes(thread.kind),
    )
  );
}

/** 同一未读来源恢复最近成功列表，存储受限时继续走正常请求。 */
export function readSnapshotCache(
  storage: Pick<Storage, "getItem">,
  selection: string | null,
): Snapshot | null {
  try {
    const value = JSON.parse(storage.getItem(SNAPSHOT_CACHE_KEY) ?? "null");
    if (value?.selection !== selection || !validSnapshot(value.snapshot))
      return null;
    return cachedSnapshot(value.snapshot);
  } catch {
    return null;
  }
}

/** 只保存可用且非空的列表，临时空快照不会抹掉上次成功内容。 */
export function writeSnapshotCache(
  storage: Pick<Storage, "setItem">,
  snapshot: Snapshot,
  selection: string | null,
): void {
  if (!validSnapshot(snapshot)) return;
  try {
    storage.setItem(
      SNAPSHOT_CACHE_KEY,
      JSON.stringify({
        selection,
        snapshot: cachedSnapshot(snapshot),
      }),
    );
  } catch {
    // 宿主可禁用存储或限制配额；缓存写入失败不影响实时列表。
  }
}

/** 目录已确认清空后移除旧列表，存储不可用时不阻断界面。 */
export function clearSnapshotCache(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(SNAPSHOT_CACHE_KEY);
  } catch {
    // 缓存清理失败不改变当前已确认的空列表。
  }
}
