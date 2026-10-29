export type ConnectionState =
  "connecting" | "connected" | "disconnected" | "disabled";
export type RuntimeStatus = {
  type: "active" | "idle" | "notLoaded" | "systemError";
  activeFlags?: string[];
};
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
export type TurnUsage = {
  id: string;
  /** 用户正文；空串表示未输入文字，null 表示未获取到。 */
  userInput: string | null;
  status: "inProgress" | "completed" | "interrupted";
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  tokens: number | null;
  durationMs: number | null;
};
/** 监听关系中的对话引用，使用当前标题并按 ID 跳转。 */
export type ThreadLink = { id: string; title: string };
export type Thread = {
  id: string;
  title: string;
  cwd: string;
  project: string;
  updatedAt: string;
  /** 最近一次用户发消息的时间；不会随助手输出或自动续跑更新。 */
  lastUserMessageAt: string | null;
  kind: "user" | "agent" | "unknown";
  model: string | null;
  reasoningEffort: string | null;
  collaborationMode: "plan" | "default" | null;
  goalStatus: GoalStatus | "none" | null;
  turnUsage: TurnUsage | null;
  /** 最近一轮成功等待过的对话，回合结束后保留，新回合开始时重置。 */
  monitoring?: ThreadLink[];
  /** 其他对话最近一轮中的反向监听关系。 */
  monitoredBy?: ThreadLink[];
  unread: boolean | null;
  runtime: RuntimeStatus | null;
  pendingUserInput?: boolean;
  /** 本次连接首次观察到持续等待的时间；断线后不作为实时信息返回。 */
  waitingSince?: string | null;
  /** 当前未答异步问题的简短原文；没有可读问题时由界面使用等待类型回退。 */
  waitingQuestion?: string | null;
  runtimeAt: string | null;
  fresh: boolean;
  error: { message: string; at: string } | null;
};
export type Snapshot = {
  schemaVersion: 1;
  generatedAt: string;
  threads: Thread[];
  /** 首次打开看板时，最近对话的运行状态仍在同步。 */
  syncingThreads?: boolean;
  connection: {
    state: ConnectionState;
    endpoint: string;
    since: string | null;
    message: string | null;
  };
  sources: {
    metadata: boolean;
    unread: boolean;
    unreadReason: string;
    metadataError: string | null;
    unreadOptions: { key: string; label: string; count: number }[];
    unreadSelection: string | null;
  };
};
export type Column = "waiting" | "running" | "idle" | "error" | "unknown";
export type BoardColumn = Column | "unread";
export type BoardScope = "all" | "attention";

/** 按用户发消息时间倒序，未知时间排在最后，同时间按 ID 固定顺序。 */
export function compareByLastUserMessage(a: Thread, b: Thread): number {
  return (
    (b.lastUserMessageAt ?? "").localeCompare(a.lastUserMessageAt ?? "") ||
    a.id.localeCompare(b.id)
  );
}

export function needsAttention(thread: Thread): boolean {
  const column = columnFor(thread);
  return thread.unread === true || column === "waiting" || column === "error";
}

export function belongsToColumn(
  thread: Thread,
  column: BoardColumn,
  scope: BoardScope = "all",
): boolean {
  const runtimeColumn = columnFor(thread);
  const assignedColumn =
    thread.unread === true &&
    (runtimeColumn === "idle" ||
      runtimeColumn === "unknown" ||
      (scope === "attention" && runtimeColumn === "running"))
      ? "unread"
      : runtimeColumn;
  return assignedColumn === column;
}

export function columnFor(thread: Thread): Column {
  if (!thread.fresh || !thread.runtime) return "unknown";
  if (thread.runtime.type === "systemError" || thread.error) return "error";
  if (
    thread.pendingUserInput &&
    (thread.runtime.type === "active" || thread.runtime.type === "idle")
  )
    return "waiting";
  if (thread.runtime.type === "active") {
    return thread.runtime.activeFlags?.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    )
      ? "waiting"
      : "running";
  }
  return thread.runtime.type === "idle" ? "idle" : "unknown";
}

export function waitingLabel(thread: Thread): string {
  return thread.runtime?.activeFlags?.includes("waitingOnApproval")
    ? "等待操作确认"
    : "等待你的回复";
}
