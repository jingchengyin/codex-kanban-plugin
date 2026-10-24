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
  userInput: string | null;
  status: "inProgress" | "completed" | "interrupted";
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  tokens: number | null;
  durationMs: number | null;
};
export type Thread = {
  id: string;
  title: string;
  cwd: string;
  project: string;
  updatedAt: string;
  kind: "user" | "agent" | "unknown";
  model: string | null;
  reasoningEffort: string | null;
  collaborationMode: "plan" | "default" | null;
  goalStatus: GoalStatus | "none" | null;
  turnUsage: TurnUsage | null;
  unread: boolean | null;
  runtime: RuntimeStatus | null;
  runtimeAt: string | null;
  fresh: boolean;
  error: { message: string; at: string } | null;
};
export type Snapshot = {
  schemaVersion: 1;
  generatedAt: string;
  threads: Thread[];
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

export function belongsToColumn(thread: Thread, column: BoardColumn): boolean {
  const runtimeColumn = columnFor(thread);
  const assignedColumn =
    thread.unread === true &&
    (runtimeColumn === "idle" || runtimeColumn === "unknown")
      ? "unread"
      : runtimeColumn;
  return assignedColumn === column;
}

export function columnFor(thread: Thread): Column {
  if (!thread.fresh || !thread.runtime) return "unknown";
  if (thread.runtime.type === "systemError" || thread.error) return "error";
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
