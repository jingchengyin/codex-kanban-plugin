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
};
type State = {
  collaborationMode: Thread["collaborationMode"];
  turnUsage: TurnUsage | null;
  total: number | null;
  baseline: number | null;
  directTokens: boolean;
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

function userText(payload: any): string | null {
  const kinds =
    payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const parts = (Array.isArray(payload.content) ? payload.content : [])
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
  return text;
}

// Retain execution metadata and the requested user's original text, never tool
// outputs, assistant messages, or injected context.
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
      return { type: "mode", at, mode: mode(p.collaboration_mode?.mode) };
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
function consume(state: State, value: Event) {
  if (value.mode) state.collaborationMode = value.mode;
  if (value.type === "task_started" && value.id) {
    state.baseline = state.total;
    state.directTokens = false;
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

  async read(
    path: string,
  ): Promise<Pick<Thread, "collaborationMode" | "turnUsage">> {
    const missing = { collaborationMode: null, turnUsage: null };
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
          // Scan backwards only as far as the latest turn and its token baseline.
          let suffix = Buffer.alloc(0);
          let trailing = true;
          let foundStart = false;
          let foundBaseline = false;
          while (end > 0 && !foundBaseline) {
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
                if (value.type === "task_started" && value.id)
                  foundStart = true;
                else if (foundStart && value.total !== undefined) {
                  foundBaseline = true;
                  break;
                }
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
              turnUsage: null,
              total: end === 0 ? 0 : null,
              baseline: null,
              directTokens: false,
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
        turnUsage: cached.state.turnUsage
          ? { ...cached.state.turnUsage }
          : null,
      };
    } catch {
      this.cache.delete(path);
      return missing;
    } finally {
      await file?.close();
    }
  }
}
