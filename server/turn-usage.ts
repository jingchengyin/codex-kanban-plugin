import { open, stat } from "node:fs/promises";
import type { Thread, TurnUsage } from "../shared/types.js";

type Event = {
  type: string;
  at: string;
  id?: string;
  userInput?: string;
  mode?: Thread["collaborationMode"];
  total?: number;
  turnTokens?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  model?: string;
  monitoringThreadIds?: string[];
};
type State = {
  collaborationMode: Thread["collaborationMode"];
  lastUserMessageAt: string | null;
  turnUsage: TurnUsage | null;
  total: number | null;
  baseline: number | null;
  directTokens: boolean;
  monitoringThreadIds: string[];
};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): string | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value > 0 &&
  value < 1e12
    ? new Date(value * 1000).toISOString()
    : null;
const mode = (value: unknown): Thread["collaborationMode"] =>
  value === "plan" || value === "default" ? value : null;

/** 提取用户正文，排除客户端上下文和自动生成的附件包装。 */
function userText(payload: any): string | null {
  const kinds =
    payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const parts: string[] = (
    Array.isArray(payload.content) ? payload.content : []
  )
    .filter(
      (part: any, index: number) =>
        (part?.type === "input_text" || part?.type === "text") &&
        typeof part.text === "string" &&
        (!Array.isArray(kinds) || kinds[index] === "user.text"),
    )
    .map((part: any) => part.text as string);
  if (!parts.length) return null;
  const text = parts.join("\n");
  if (text.trimStart().startsWith("<send_user_message_question_reply>"))
    return null;
  // Older records lack content kinds; exclude the client's context envelopes.
  if (
    !Array.isArray(kinds) &&
    /^(?:# AGENTS\.md instructions\b|<(?:environment_context|external_codex_apps_open_page|subagent_notification)\b)/.test(
      text.trimStart(),
    )
  )
    return null;
  if (text.trimStart().startsWith("# Files mentioned by the user:")) {
    // 图片的开始和结束标签也会被标成 user.text，只移除独立的包装片段。
    const message = parts
      .filter((part) => !/^<\/?image\b[^>]*>$/.test(part.trim()))
      .join("\n");
    const request = /^## My request:[ \t]*(?:\r?\n|$)/m.exec(message);
    if (!request) return "";
    const body = message
      .slice(request.index + request[0].length)
      .replace(/^(?:[ \t]*\r?\n)*/, "");
    return body.trim() ? body : "";
  }
  return text;
}

/** 从成功的等待调用中提取本机对话 ID，不把读取快照或正文提及当成监听。 */
function monitoringTargets(item: any): string[] | null {
  if (
    item?.type !== "McpToolCall" ||
    item.server !== "codex_app" ||
    item.tool !== "wait_threads" ||
    item.status !== "completed" ||
    item.error ||
    item.result?.isError === true ||
    item.arguments?.timeoutMs === 0 ||
    !Array.isArray(item.arguments?.targets)
  )
    return null;
  // 一次等待可能有部分目标查询失败，只记录结果中实际返回的对话。
  const successful = new Set<string>();
  for (const content of item.result?.content ?? []) {
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    try {
      const result = JSON.parse(content.text);
      for (const poll of Array.isArray(result.polls) ? result.polls : [])
        if (
          typeof poll?.thread?.id === "string" &&
          (poll.thread.hostId == null || poll.thread.hostId === "local")
        )
          successful.add(poll.thread.id);
    } catch {
      // 无法确认调用结果时不建立监听关系。
    }
  }
  return item.arguments.targets
    .filter(
      (target: any) =>
        target &&
        (target.hostId == null || target.hostId === "local") &&
        typeof target.threadId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          target.threadId,
        ) &&
        successful.has(target.threadId),
    )
    .map((target: { threadId: string }) => target.threadId);
}

// 只保留运行元数据、用户输入及结构化监听 ID，不返回工具输出或助手正文。
function event(line: string): Event | null {
  if (
    !/"type"\s*:\s*"(?:event_msg|turn_context|token_usage_record|response_item)"/.test(
      line.slice(0, 200),
    )
  )
    return null;
  try {
    const record = JSON.parse(line);
    const p = record.payload;
    if (!p || !Number.isFinite(Date.parse(record.timestamp))) return null;
    const at = record.timestamp as string;
    if (record.type === "response_item") {
      if (p.type !== "message" || p.role !== "user") return null;
      const text = userText(p);
      return text === null
        ? null
        : {
            type: "user_input",
            at,
            userInput: text,
            id:
              typeof p.internal_chat_message_metadata_passthrough?.turn_id ===
              "string"
                ? p.internal_chat_message_metadata_passthrough.turn_id
                : undefined,
          };
    }
    if (record.type === "turn_context")
      return {
        type: "mode",
        at,
        mode: mode(p.collaboration_mode?.mode),
        id: typeof p.turn_id === "string" ? p.turn_id : undefined,
        model: typeof p.model === "string" ? p.model : undefined,
      };
    if (record.type === "token_usage_record") {
      const total = p.thread_token_usage?.total_tokens;
      const turnTokens = p.turn_token_usage?.total_tokens;
      return typeof p.turn_id === "string" && count(turnTokens)
        ? {
            type: "turn_tokens",
            at,
            id: p.turn_id,
            turnTokens,
            total: count(total) ? total : undefined,
          }
        : null;
    }
    if (record.type !== "event_msg") return null;
    if (p.type === "item_completed") {
      const ids = monitoringTargets(p.item);
      return ids?.length
        ? {
            type: "thread_monitoring",
            at,
            id: typeof p.turn_id === "string" ? p.turn_id : undefined,
            monitoringThreadIds: ids,
          }
        : null;
    }
    if (p.type === "user_message" && typeof p.message === "string") {
      const text = userText({ content: [{ type: "text", text: p.message }] });
      return text === null
        ? null
        : {
            type: "user_input",
            at,
            userInput: text,
            id: typeof p.turn_id === "string" ? p.turn_id : undefined,
          };
    }
    if (p.type === "thread_settings_applied")
      return {
        type: "mode",
        at,
        mode: mode(p.thread_settings?.collaboration_mode?.mode),
      };
    if (p.type === "token_count") {
      const total = p.info?.total_token_usage?.total_tokens;
      return count(total) ? { type: p.type, at, total } : null;
    }
    if (!["task_started", "task_complete", "turn_aborted"].includes(p.type))
      return null;
    return {
      type: p.type,
      at,
      id: typeof p.turn_id === "string" ? p.turn_id : undefined,
      mode: mode(p.collaboration_mode_kind),
      startedAt: timestamp(p.started_at),
      completedAt: timestamp(p.completed_at),
      durationMs: count(p.duration_ms) ? p.duration_ms : null,
    };
  } catch {
    return null;
  }
}
/** 更新回合用量，并独立保留最近用户发消息的时间。 */
function consume(state: State, value: Event) {
  if (value.mode) state.collaborationMode = value.mode;
  // 用户输入时间独立于回合生命周期，自动续跑时保留上次发消息的时间。
  if (value.userInput !== undefined)
    state.lastUserMessageAt = new Date(value.at).toISOString();
  if (value.type === "task_started" && value.id) {
    state.baseline = state.total;
    state.directTokens = false;
    state.monitoringThreadIds = [];
    state.turnUsage = {
      id: value.id,
      userInput: null,
      status: "inProgress",
      startedAt: value.startedAt ?? value.at,
      completedAt: null,
      updatedAt: value.at,
      tokens: 0,
      durationMs: null,
    };
  }
  const turn = state.turnUsage;
  // 关系按监听者的最近一轮保存，超时或回合结束后仍可回查。
  if (turn && value.monitoringThreadIds && (!value.id || value.id === turn.id))
    state.monitoringThreadIds = [
      ...new Set([...state.monitoringThreadIds, ...value.monitoringThreadIds]),
    ];
  if (
    turn &&
    value.userInput !== undefined &&
    (!value.id || value.id === turn.id)
  )
    turn.userInput = value.userInput;
  if (value.total !== undefined) {
    state.total = value.total;
    if (turn?.status === "inProgress" && !state.directTokens) {
      // `last_token_usage` covers one model request, not the whole turn.
      turn.tokens =
        state.baseline !== null && value.total >= state.baseline
          ? value.total - state.baseline
          : null;
      turn.updatedAt = value.at;
    }
  }
  if (turn && value.id === turn.id && value.turnTokens !== undefined) {
    turn.tokens = value.turnTokens;
    turn.updatedAt = value.at;
    state.directTokens = true;
  }
  if (
    turn &&
    (!value.id || value.id === turn.id) &&
    (value.type === "task_complete" || value.type === "turn_aborted")
  ) {
    turn.status = value.type === "task_complete" ? "completed" : "interrupted";
    turn.startedAt = value.startedAt ?? turn.startedAt;
    turn.completedAt = value.completedAt ?? value.at;
    turn.updatedAt = value.at;
    turn.durationMs =
      value.durationMs ??
      (turn.startedAt
        ? Math.max(
            0,
            Date.parse(turn.completedAt!) - Date.parse(turn.startedAt),
          )
        : null);
  }
}

// 历史回顾复用相同的元数据解析规则，不读取助手回复或工具输出。
export { event as parseTurnEvent };
export type { Event as TurnEvent };

/** 复用增量日志读取，同时提供回合用量、用户输入时间和监听目标。 */
export class TurnUsageReader {
  private cache = new Map<
    string,
    {
      size: number;
      mtime: number;
      ino: number;
      offset: number;
      state: State;
    }
  >();

  /** 增量读取回合用量和最近用户发消息时间，跳过未写完的记录。 */
  async read(path: string): Promise<
    Pick<Thread, "collaborationMode" | "lastUserMessageAt" | "turnUsage"> & {
      monitoringThreadIds: string[];
    }
  > {
    const missing = {
      collaborationMode: null,
      lastUserMessageAt: null,
      turnUsage: null,
      monitoringThreadIds: [],
    };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await stat(path);
      if (!info.isFile()) return missing;
      let cached = this.cache.get(path);
      if (cached)
        cached = {
          ...cached,
          state: {
            ...cached.state,
            turnUsage: cached.state.turnUsage
              ? { ...cached.state.turnUsage }
              : null,
          },
        };
      if (
        cached &&
        (cached.ino !== info.ino ||
          info.size < cached.size ||
          (info.size === cached.size && info.mtimeMs !== cached.mtime))
      )
        cached = undefined;
      if (
        !cached ||
        info.size !== cached.size ||
        info.mtimeMs !== cached.mtime
      ) {
        file = await open(path, "r");
        const events: Event[] = [];
        let offset = cached?.offset ?? 0;
        let end = info.size;
        if (cached) {
          const buffer = Buffer.alloc(end - offset);
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          const complete = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
          for (const line of buffer
            .subarray(0, complete)
            .toString("utf8")
            .split("\n")) {
            const value = event(line);
            if (value) events.push(value);
          }
          offset += complete;
        } else {
          // 同时找到最近用户输入和回合基线，避免自动续跑掩盖上次输入时间。
          let suffix = Buffer.alloc(0);
          let trailing = true;
          let foundStart = false;
          let foundBaseline = false;
          let foundUserInput = false;
          while (end > 0 && (!foundBaseline || !foundUserInput)) {
            const start = Math.max(0, end - 65536);
            const buffer = Buffer.alloc(end - start);
            const { bytesRead } = await file.read(
              buffer,
              0,
              buffer.length,
              start,
            );
            const chunk = Buffer.concat([
              buffer.subarray(0, bytesRead),
              suffix,
            ]);
            let last = chunk.length;
            if (trailing) {
              last = chunk.lastIndexOf(10);
              if (last < 0) {
                end = start;
                continue;
              }
              offset = start + last + 1;
              trailing = false;
            }
            const first = start === 0 ? 0 : chunk.indexOf(10) + 1;
            if (first > 0 || start === 0) {
              const lines = chunk
                .subarray(first, Math.max(first, last))
                .toString("utf8")
                .split("\n");
              for (let i = lines.length - 1; i >= 0; i--) {
                const value = event(lines[i]);
                if (!value) continue;
                events.push(value);
                if (value.userInput !== undefined) foundUserInput = true;
                if (value.type === "task_started" && value.id)
                  foundStart = true;
                else if (foundStart && value.total !== undefined)
                  foundBaseline = true;
                if (foundBaseline && foundUserInput) break;
              }
            }
            suffix = chunk.subarray(0, first > 0 ? first - 1 : chunk.length);
            end = start;
          }
          events.reverse();
          cached = {
            size: 0,
            mtime: 0,
            ino: info.ino,
            offset: 0,
            state: {
              collaborationMode: null,
              lastUserMessageAt: null,
              turnUsage: null,
              total: end === 0 ? 0 : null,
              baseline: null,
              directTokens: false,
              monitoringThreadIds: [],
            },
          };
        }
        for (const value of events) consume(cached.state, value);
        cached = { ...cached, size: info.size, mtime: info.mtimeMs, offset };
        this.cache.delete(path);
        this.cache.set(path, cached);
        if (this.cache.size > 500)
          this.cache.delete(this.cache.keys().next().value!);
      }
      return {
        collaborationMode: cached.state.collaborationMode,
        lastUserMessageAt: cached.state.lastUserMessageAt,
        turnUsage: cached.state.turnUsage
          ? { ...cached.state.turnUsage }
          : null,
        monitoringThreadIds: [...cached.state.monitoringThreadIds],
      };
    } catch {
      this.cache.delete(path);
      return missing;
    } finally {
      await file?.close();
    }
  }
}
