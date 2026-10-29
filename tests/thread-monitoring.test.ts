import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readLocalData } from "../server/local-data";
import { TurnUsageReader } from "../server/turn-usage";

const id = (rank: number) =>
  `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
const line = (seconds: number, payload: object, type = "event_msg") =>
  JSON.stringify({
    timestamp: new Date(1792800000000 + seconds * 1000).toISOString(),
    type,
    payload,
  }) + "\n";
const started = (turn = "current", seconds = 0) =>
  line(seconds, { type: "task_started", turn_id: turn });
type WaitTarget = { threadId: string; hostId?: string } | null;
const result = (targets: WaitTarget[], extra: object = {}) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        timedOut: true,
        wake: null,
        polls: targets
          .filter((target) => target !== null)
          .map((target) => ({
            thread: { id: target.threadId, hostId: target.hostId ?? "local" },
            latestTurn: { status: "inProgress" },
            latestAssistantMessage: { text: "PRIVATE_TOOL_OUTPUT" },
          })),
        ...extra,
      }),
    },
  ],
  isError: false,
});
const wait = (
  seconds: number,
  targets: WaitTarget[],
  item: Record<string, unknown> = {},
  turn = "current",
) =>
  line(seconds, {
    type: "item_completed",
    thread_id: id(1),
    turn_id: turn,
    item: {
      type: "McpToolCall",
      server: "codex_app",
      tool: "wait_threads",
      arguments: { targets, timeoutMs: 55000 },
      status: "completed",
      result: result(targets),
      ...item,
    },
  });

/** 每个用例使用独立目录，不读取或修改用户的实际聊天记录。 */
async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-monitoring-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true });
  }
}

/** 仅建立关系解析所需的对话索引，模拟现有本机数据库结构。 */
function database(home: string) {
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_role TEXT, archived INTEGER, rollout_path TEXT)",
  );
  const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)");
  return {
    db,
    add(
      rank: number,
      name: string,
      options: {
        kind?: "user" | "agent" | "unknown";
        archived?: boolean;
        updatedAt?: number;
        path?: string;
      } = {},
    ) {
      const kind = options.kind ?? "user";
      insert.run(
        id(rank),
        "旧标题",
        name,
        "/work/project",
        options.updatedAt ?? 1800000000 - rank,
        kind === "unknown" ? "custom" : "vscode",
        kind === "unknown" ? null : kind,
        kind === "agent" ? "reviewer" : null,
        options.archived ? 1 : 0,
        options.path ?? null,
      );
    },
  };
}

test("monitoring uses successful structured waits, deduplicates local targets, and ignores unrelated evidence", () =>
  fixture(async (home) => {
    const path = join(home, "rollout.jsonl");
    const target = { threadId: id(4) };
    const rejectedItems: Record<string, unknown>[] = [
      { type: "CommandExecution" },
      { server: "another_server" },
      { tool: "read_thread" },
      { status: "failed" },
      { status: "inProgress" },
      { error: { message: "工具调用失败" } },
      { result: { ...result([target]), isError: true } },
      { result: { content: [], isError: false } },
      { result: { content: [{ type: "text", text: "not JSON" }] } },
      { arguments: { targets: [target], timeoutMs: 0 } },
    ];
    await writeFile(
      path,
      started() +
        wait(1, [
          { threadId: id(2), hostId: "local" },
          { threadId: id(2) },
          { threadId: id(3) },
          { threadId: id(4), hostId: "remote" },
          { threadId: "not-a-thread-id" },
          { threadId: "-".repeat(36) },
          null,
        ]) +
        wait(2, [{ threadId: id(3) }], {
          arguments: { targets: [{ threadId: id(3) }] },
        }) +
        rejectedItems
          .map((item, index) => wait(index + 3, [target], item))
          .join("") +
        line(20, {
          type: "item_started",
          turn_id: "current",
          item: {
            type: "McpToolCall",
            server: "codex_app",
            tool: "wait_threads",
            arguments: { targets: [target], timeoutMs: 55000 },
            status: "inProgress",
          },
        }) +
        line(
          21,
          {
            type: "custom_tool_call",
            name: "exec",
            input: `await tools.mcp__codex_app__wait_threads({targets:[{threadId:"${id(4)}"}]});`,
          },
          "response_item",
        ),
    );
    const value = await new TurnUsageReader().read(path);
    assert.deepEqual(value.monitoringThreadIds, [id(2), id(3)]);
    assert.equal(JSON.stringify(value).includes("PRIVATE_TOOL_OUTPUT"), false);
  }));

test("a partially failed wait records only requested targets that returned local polls", () =>
  fixture(async (home) => {
    const path = join(home, "rollout.jsonl");
    await writeFile(
      path,
      started() +
        wait(
          1,
          [{ threadId: id(2) }, { threadId: id(3) }, { threadId: id(4) }],
          {
            result: result(
              [
                { threadId: id(2) },
                { threadId: id(4), hostId: "remote" },
                { threadId: id(5) },
              ],
              {
                errors: [
                  {
                    threadId: id(3),
                    hostId: "local",
                    error: "Thread not found",
                  },
                ],
              },
            ),
          },
        ),
    );
    assert.deepEqual(
      (await new TurnUsageReader().read(path)).monitoringThreadIds,
      [id(2)],
    );
  }));

test("latest-turn monitoring survives completion and interruption, updates incrementally, and resets on a new turn", () =>
  fixture(async (home) => {
    const path = join(home, "rollout.jsonl");
    const reader = new TurnUsageReader();
    await writeFile(path, started() + wait(1, [{ threadId: id(2) }]));
    assert.deepEqual((await reader.read(path)).monitoringThreadIds, [id(2)]);

    const next = wait(2, [{ threadId: id(3) }], {
      result: result([], {
        timedOut: false,
        wake: { reason: "turnCompleted", threadId: id(3), hostId: "local" },
        polls: [
          {
            thread: { id: id(3), hostId: "local", status: { type: "idle" } },
            latestTurn: { status: "completed" },
          },
        ],
      }),
    });
    await appendFile(path, next.slice(0, -9));
    assert.deepEqual((await reader.read(path)).monitoringThreadIds, [id(2)]);
    await appendFile(
      path,
      next.slice(-9) + line(3, { type: "task_complete", turn_id: "current" }),
    );
    const completed = await reader.read(path);
    assert.deepEqual(completed.monitoringThreadIds, [id(2), id(3)]);
    assert.equal(completed.turnUsage?.status, "completed");
    assert.deepEqual(await new TurnUsageReader().read(path), completed);

    await appendFile(path, started("next", 4));
    assert.deepEqual((await reader.read(path)).monitoringThreadIds, []);
    await appendFile(
      path,
      wait(5, [{ threadId: id(4) }], {}, "next") +
        line(6, { type: "turn_aborted", turn_id: "next" }),
    );
    const interrupted = await reader.read(path);
    assert.deepEqual(interrupted.monitoringThreadIds, [id(4)]);
    assert.equal(interrupted.turnUsage?.status, "interrupted");
    assert.deepEqual(await new TurnUsageReader().read(path), interrupted);
  }));

test("local metadata resolves both directions with current titles and excludes self, agents, and archived listeners", () =>
  fixture(async (home) => {
    const { db, add } = database(home);
    const sourcePath = join(home, "source.jsonl");
    const otherPath = join(home, "other.jsonl");
    try {
      await writeFile(
        sourcePath,
        started() +
          wait(
            1,
            [1, 2, 2, 3, 4, 99].map((rank) => ({ threadId: id(rank) })),
          ),
      );
      await writeFile(otherPath, started() + wait(1, [{ threadId: id(2) }]));
      add(1, "验收多 Agent Runtime 模型能力", { path: sourcePath });
      add(2, "Multi Agent Runtime - Trae");
      add(3, "子任务", { kind: "agent", path: otherPath });
      add(4, "来源不明的对话", { kind: "unknown", path: otherPath });
      add(5, "归档的监听者", { archived: true, path: otherPath });
      add(6, "另一位监听者", { path: otherPath });

      const data = await readLocalData(home);
      assert.equal(data.metadata, true);
      const byId = new Map(data.threads.map((thread) => [thread.id, thread]));
      assert.deepEqual(byId.get(id(1))?.monitoring, [
        { id: id(2), title: "Multi Agent Runtime - Trae" },
      ]);
      assert.deepEqual(byId.get(id(1))?.monitoredBy, []);
      assert.deepEqual(byId.get(id(2))?.monitoredBy, [
        { id: id(1), title: "验收多 Agent Runtime 模型能力" },
        { id: id(6), title: "另一位监听者" },
      ]);
      assert.deepEqual(byId.get(id(3))?.monitoring, []);
      assert.deepEqual(byId.get(id(4))?.monitoring, []);

      db.prepare("UPDATE threads SET name=? WHERE id=?").run(
        "Trae 新标题",
        id(2),
      );
      const refreshed = await readLocalData(home);
      assert.deepEqual(
        refreshed.threads.find((thread) => thread.id === id(1))?.monitoring,
        [{ id: id(2), title: "Trae 新标题" }],
      );

      await appendFile(sourcePath, started("next", 2));
      const nextTurn = await readLocalData(home);
      assert.deepEqual(
        nextTurn.threads.find((thread) => thread.id === id(1))?.monitoring,
        [],
      );
      assert.deepEqual(
        nextTurn.threads.find((thread) => thread.id === id(2))?.monitoredBy,
        [{ id: id(6), title: "另一位监听者" }],
      );
    } finally {
      db.close();
    }
  }));

test("monitoring resolves archived targets and targets older than the board's 500-thread window", () =>
  fixture(async (home) => {
    const { db, add } = database(home);
    const path = join(home, "source.jsonl");
    try {
      await writeFile(
        path,
        started() + wait(1, [{ threadId: id(501) }, { threadId: id(502) }]),
      );
      add(1, "监听者", { path });
      for (let rank = 2; rank <= 500; rank++) add(rank, `对话 ${rank}`);
      add(501, "窗口之外的目标", { updatedAt: 1700000000 });
      add(502, "已归档的目标", { archived: true });

      const data = await readLocalData(home);
      assert.equal(data.metadata, true);
      assert.equal(data.threads.length, 500);
      assert.equal(
        data.threads.some((thread) => thread.id === id(501)),
        false,
      );
      assert.equal(
        data.threads.some((thread) => thread.id === id(502)),
        false,
      );
      assert.deepEqual(
        data.threads.find((thread) => thread.id === id(1))?.monitoring,
        [
          { id: id(501), title: "窗口之外的目标" },
          { id: id(502), title: "已归档的目标" },
        ],
      );
    } finally {
      db.close();
    }
  }));
