import type { Thread } from "../shared/types";

export const goalLabels = {
  active: "目标模式",
  paused: "目标 · 已暂停",
  blocked: "目标 · 已阻塞",
  usageLimited: "目标 · 用量受限",
  budgetLimited: "目标 · 预算用尽",
  complete: "目标 · 已完成",
  none: "目标未开启",
};

export function isCurrentTurn(thread: Thread): boolean {
  return (
    !!thread.turnUsage &&
    thread.turnUsage.status === "inProgress" &&
    thread.fresh &&
    thread.runtime?.type === "active"
  );
}

export function elapsedMs(thread: Thread, now = Date.now()): number | null {
  const turn = thread.turnUsage;
  if (!turn) return null;
  if (turn.durationMs !== null) return turn.durationMs;
  if (!turn.startedAt) return null;
  // A disconnected or unloaded thread cannot certify a running clock.
  const end = isCurrentTurn(thread)
    ? now
    : Date.parse(turn.completedAt ?? turn.updatedAt);
  const elapsed = end - Date.parse(turn.startedAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : null;
}

export function formatTokens(tokens: number | null): string {
  return tokens === null
    ? "Token 未知"
    : `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens)} tokens`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "耗时未知";
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}时${minutes % 60}分`
    : `${Math.floor(hours / 24)}天${hours % 24}时`;
}
