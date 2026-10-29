import { DatabaseSync } from "node:sqlite";
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TurnUsage } from "../shared/types.js";
import type {
  WorkRecord,
  WorkReview,
  WorkReviewOptions,
  WorkSummary,
} from "../shared/work-review.js";
import { displayTitle } from "./local-data.js";
import { parseTurnEvent, type TurnEvent } from "./turn-usage.js";

type HistoryTurn = TurnUsage & {
  model: string | null;
  baseline: number | null;
  directTokens: boolean;
};
type HistoryState = {
  turns: Map<string, HistoryTurn>;
  currentId: string | null;
  total: number | null;
  model: string | null;
};
type HistoryCache = {
  ino: number;
  size: number;
  mtime: number;
  offset: number;
  state: HistoryState;
};

/** 更新历史回合；精确的单轮用量可以补到已经结束的回合。 */
function consume(state: HistoryState, event: TurnEvent) {
  event = { ...event, at: new Date(event.at).toISOString() };
  if (event.model) state.model = event.model;
  if (event.type === "task_started" && event.id) {
    state.currentId = event.id;
    if (!state.turns.has(event.id))
      state.turns.set(event.id, {
        id: event.id,
        userInput: null,
        status: "inProgress",
        startedAt: event.startedAt ?? event.at,
        completedAt: null,
        updatedAt: event.at,
        tokens: null,
        durationMs: null,
        model: state.model,
        baseline: state.total,
        directTokens: false,
      });
  }
  const id = event.id ?? state.currentId;
  // 缺少开始事件时仍保留有明确回合 ID 的用量及结束记录。
  if (
    id &&
    !state.turns.has(id) &&
    ["turn_tokens", "task_complete", "turn_aborted"].includes(event.type)
  )
    state.turns.set(id, {
      id,
      userInput: null,
      status: "inProgress",
      startedAt: event.startedAt ?? null,
      completedAt: null,
      updatedAt: event.at,
      tokens: null,
      durationMs: null,
      model: null,
      baseline: null,
      directTokens: false,
    });
  const turn = id ? state.turns.get(id) : undefined;
  if (turn && event.model) turn.model = event.model;
  if (turn && event.userInput !== undefined) turn.userInput = event.userInput;
  if (event.total !== undefined) {
    if (!event.id || event.id === state.currentId) state.total = event.total;
    if (turn?.status === "inProgress" && !turn.directTokens) {
      // 累计计数重置后，本轮基线已丢失；后续上涨不能恢复这个基线。
      if (turn.baseline !== null && event.total < turn.baseline)
        turn.baseline = null;
      turn.tokens =
        turn.baseline !== null && event.total >= turn.baseline
          ? event.total - turn.baseline
          : null;
      turn.updatedAt = event.at;
    }
  }
  if (turn && event.turnTokens !== undefined) {
    turn.tokens = event.turnTokens;
    turn.directTokens = true;
    turn.updatedAt = event.at;
  }
  if (turn && ["task_complete", "turn_aborted"].includes(event.type)) {
    turn.status = event.type === "task_complete" ? "completed" : "interrupted";
    turn.startedAt = event.startedAt ?? turn.startedAt;
    turn.completedAt = event.completedAt ?? event.at;
    turn.updatedAt = event.at;
    turn.durationMs =
      event.durationMs ??
      (turn.startedAt
        ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
        : null);
  }
}

/** 增量读取完整日志行，缓存回合元数据，不缓存助手或工具正文。 */
export class WorkHistoryReader {
  private cache = new Map<string, HistoryCache>();
  private pending = new Map<
    string,
    Promise<(TurnUsage & { model: string | null })[]>
  >();

  /** 相同日志的并发读取共享一次扫描，返回副本供调用方筛选。 */
  read(path: string): Promise<(TurnUsage & { model: string | null })[]> {
    const existing = this.pending.get(path);
    if (existing) return existing;
    const result = this.scan(path).finally(() => this.pending.delete(path));
    this.pending.set(path, result);
    return result;
  }

  /** 按本次查询范围清理缓存，扫描期间保留所有即将读取的日志。 */
  retain(paths: Set<string>) {
    for (const path of this.cache.keys())
      if (!paths.has(path)) this.cache.delete(path);
  }

  /** 首次分块扫描，后续只读取追加部分；未完成的末行留到下次。 */
  private async scan(path: string) {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("工作日志不是文件");
    let cached = this.cache.get(path);
    if (
      !cached ||
      cached.ino !== info.ino ||
      info.size < cached.size ||
      (info.size === cached.size && info.mtimeMs !== cached.mtime)
    )
      cached = {
        ino: info.ino,
        size: 0,
        mtime: 0,
        offset: 0,
        state: { turns: new Map(), currentId: null, total: 0, model: null },
      };
    if (info.size !== cached.size || info.mtimeMs !== cached.mtime) {
      const file = await open(path, "r");
      try {
        let position = cached.offset;
        let suffix = Buffer.alloc(0);
        const block = Buffer.alloc(65536);
        while (position < info.size) {
          const { bytesRead } = await file.read(
            block,
            0,
            Math.min(block.length, info.size - position),
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
          const chunk = Buffer.concat([suffix, block.subarray(0, bytesRead)]);
          let start = 0;
          for (
            let end = chunk.indexOf(10);
            end >= 0;
            end = chunk.indexOf(10, start)
          ) {
            const event = parseTurnEvent(
              chunk.subarray(start, end).toString("utf8"),
            );
            if (event) consume(cached.state, event);
            cached.offset += end - start + 1;
            start = end + 1;
          }
          suffix = Buffer.from(chunk.subarray(start));
        }
        cached.size = info.size;
        cached.mtime = info.mtimeMs;
        this.cache.delete(path);
        this.cache.set(path, cached);
      } finally {
        await file.close();
      }
    }
    return [...cached.state.turns.values()].map(
      ({ baseline, directTokens, ...turn }) => ({ ...turn }),
    );
  }
}

function dateKey(date: Date, formatter: Intl.DateTimeFormat) {
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** 用当地日期边界计算范围，夏令时日不强行按 24 小时计算。 */
export function workReviewRange(
  days: number,
  timezone: string,
  now = new Date(),
) {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new RangeError("回顾范围需为 1 到 90 天");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = dateKey(now, formatter);
  const day = Date.parse(`${today}T00:00:00Z`);
  const shifted = (offset: number) =>
    new Date(day + offset * 86400000).toISOString().slice(0, 10);
  const boundary = (key: string) => {
    const target = Date.parse(`${key}T00:00:00Z`);
    let low = target - 36 * 3600000;
    let high = target + 36 * 3600000;
    // 找当地日期第一次达到目标日的时刻，也适用于切换夏令时的午夜。
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dateKey(new Date(middle), formatter) < key) low = middle + 1;
      else high = middle;
    }
    return new Date(low).toISOString();
  };
  return { from: boundary(shifted(1 - days)), to: boundary(shifted(1)) };
}

/** 汇总已知值，并显式保留未获取到用量和耗时的回合数。 */
export function summarizeWork(records: TurnUsage[]): WorkSummary {
  return records.reduce<WorkSummary>(
    (summary, record) => {
      summary.turns++;
      summary[record.status]++;
      if (record.tokens === null) summary.unknownTokens++;
      else summary.tokens += record.tokens;
      if (record.durationMs === null) summary.unknownDuration++;
      else summary.durationMs += record.durationMs;
      return summary;
    },
    {
      turns: 0,
      completed: 0,
      interrupted: 0,
      inProgress: 0,
      tokens: 0,
      unknownTokens: 0,
      durationMs: 0,
      unknownDuration: 0,
    },
  );
}

const reader = new WorkHistoryReader();

/** 汇总用户主对话中有输入记录的回合，并按项目分页返回明细。 */
export async function readWorkReview(
  home: string,
  options: WorkReviewOptions,
): Promise<WorkReview> {
  const now = new Date();
  const range = workReviewRange(options.days, options.timezone, now);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("回顾起始位置需为非负整数");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("每页回顾记录需为 1 到 200 条");
  const review: WorkReview = {
    generatedAt: now.toISOString(),
    ...range,
    timezone: options.timezone,
    records: [],
    totalRecords: 0,
    summary: summarizeWork([]),
    projects: [],
    sources: {
      metadata: true,
      scannedThreads: 0,
      unavailableLogs: 0,
      message: null,
    },
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(home, "state_5.sqlite"), {
      readOnly: true,
    });
    const columns = new Set(
      (
        database.prepare("PRAGMA table_info(threads)").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    const optional = (name: string, fallback = "NULL") =>
      columns.has(name) ? name : `${fallback} AS ${name}`;
    const fields = [
      "id",
      "title",
      "cwd",
      "source",
      optional("name"),
      optional("thread_source"),
      optional("agent_role"),
      optional("archived", "0"),
      optional("rollout_path"),
    ];
    // 只有最近更新过的对话才可能包含范围内开始的回合，避免扫描全部旧日志。
    const rows = database
      .prepare(
        `SELECT ${fields.join(", ")} FROM threads WHERE updated_at >= ? ORDER BY updated_at DESC`,
      )
      .all(Date.parse(range.from) / 1000) as Record<string, unknown>[];
    // 子代理日志会继承父线程历史；必须先排除，避免把同一回合重复统计。
    const userRows = rows.filter(
      (row) =>
        !row.agent_role &&
        !(typeof row.source === "string" && row.source.includes("subagent")) &&
        (row.thread_source
          ? row.thread_source === "user"
          : row.source === "vscode" || row.source === "cli"),
    );
    reader.retain(
      new Set(
        userRows.flatMap((row) =>
          typeof row.rollout_path === "string" && row.rollout_path
            ? [row.rollout_path]
            : [],
        ),
      ),
    );
    review.sources.scannedThreads = userRows.length;
    for (let offset = 0; offset < userRows.length; offset += 8) {
      await Promise.all(
        userRows.slice(offset, offset + 8).map(async (row) => {
          if (typeof row.rollout_path !== "string" || !row.rollout_path) {
            review.sources.unavailableLogs++;
            return;
          }
          try {
            const turns = await reader.read(row.rollout_path);
            const cwd = String(row.cwd ?? "");
            for (const turn of turns) {
              // 自动续跑与内部事件没有用户正文；明确空串仍保留，表示未输入文字。
              if (turn.userInput === null) continue;
              const at = turn.startedAt ?? turn.updatedAt;
              if (at < range.from || at >= range.to) continue;
              review.records.push({
                ...turn,
                threadId: String(row.id),
                title: displayTitle(row.name, row.title),
                cwd,
                project: basename(cwd) || "未归属项目",
                kind: "user",
                archived: Boolean(row.archived),
              });
            }
          } catch {
            review.sources.unavailableLogs++;
          }
        }),
      );
    }
    review.records.sort(
      (a, b) =>
        (b.startedAt ?? b.updatedAt).localeCompare(
          a.startedAt ?? a.updatedAt,
        ) ||
        a.threadId.localeCompare(b.threadId) ||
        a.id.localeCompare(b.id),
    );
    review.summary = summarizeWork(review.records);
    const projects = new Map<string, WorkRecord[]>();
    for (const record of review.records) {
      const records = projects.get(record.cwd) ?? [];
      records.push(record);
      projects.set(record.cwd, records);
    }
    review.projects = [...projects]
      .map(([cwd, records]) => ({
        cwd,
        project: records[0].project,
        ...summarizeWork(records),
      }))
      .sort((a, b) => b.tokens - a.tokens || a.cwd.localeCompare(b.cwd));
    // 汇总保留全部回合；只把当前项目的一页正文交给界面。
    const matching =
      options.project === undefined
        ? review.records
        : review.records.filter((record) => record.cwd === options.project);
    review.totalRecords = matching.length;
    review.records = matching.slice(offset, offset + limit);
    if (review.sources.unavailableLogs)
      review.sources.message = "部分工作日志不可用，汇总仅包含成功读取的记录。";
  } catch {
    review.sources.metadata = false;
    review.sources.message =
      "无法读取本机 Codex 工作记录，请检查 CODEX_HOME 或客户端版本。";
  } finally {
    database?.close();
  }
  return review;
}
