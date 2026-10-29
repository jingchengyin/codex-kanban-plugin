import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { StatusBridge } from "../server/status-bridge";
import { columnFor, type RuntimeStatus } from "../shared/types";

const threadId = (rank: number) =>
  `00000000-0000-0000-0000-${String(rank).padStart(12, "0")}`;
type Seed = {
  rank: number;
  kind?: "user" | "agent" | "unknown";
  status?: RuntimeStatus;
  archived?: boolean;
};

/** 用真实本机协议验证首次同步，不接触用户的 Codex 服务或数据库。 */
async function fixture(
  seeds: Seed[],
  options: {
    pauseInitialization?: boolean;
    failResume?: string;
    readStatus?: Map<string, RuntimeStatus>;
    resumeStatus?: Map<string, RuntimeStatus>;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-initial-sync-"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec(
    "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_role TEXT, archived INTEGER, rollout_path TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const statuses = new Map<string, RuntimeStatus>();
  const loadedIds = new Set<string>();
  for (const seed of seeds) {
    const id = threadId(seed.rank);
    const path = join(home, `${id}.jsonl`);
    insert.run(
      id,
      `对话 ${seed.rank}`,
      "/work/project",
      1800000000 - seed.rank,
      seed.kind === "unknown" ? "custom" : "vscode",
      seed.kind === "unknown" ? null : (seed.kind ?? "user"),
      seed.kind === "agent" ? "reviewer" : null,
      seed.archived ? 1 : 0,
      path,
    );
    await writeFile(
      path,
      JSON.stringify({
        timestamp: new Date(1792800000000 + seed.rank * 1000).toISOString(),
        type: "event_msg",
        payload: { type: "user_message", message: "测试用户输入" },
      }) + "\n",
    );
    if (seed.status) {
      statuses.set(id, seed.status);
      loadedIds.add(id);
    }
  }
  database.close();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = new StatusBridge({
    home,
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  const received: any[] = [];
  let initialize: (() => void) | undefined;
  const thread = (id: string, status: RuntimeStatus) => ({
    id,
    cwd: "/work/project",
    status,
  });
  const respond = (socket: WebSocket, request: any, result: object) =>
    socket.send(JSON.stringify({ id: request.id, result }));
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      received.push(request);
      if (request.id === undefined) return;
      const id = request.params?.threadId;
      if (request.method === "initialize") {
        initialize = () => respond(socket, request, {});
        if (!options.pauseInitialization) initialize();
      } else if (request.method === "thread/loaded/list")
        respond(socket, request, { data: [...loadedIds] });
      else if (request.method === "thread/read") {
        const status = options.readStatus?.get(id) ??
          statuses.get(id) ?? { type: "notLoaded" };
        if (status.type !== "notLoaded") {
          statuses.set(id, status);
          loadedIds.add(id);
        }
        respond(socket, request, { thread: thread(id, status) });
      } else if (request.method === "thread/resume") {
        if (id === options.failResume)
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32000, message: "测试单条恢复失败" },
            }),
          );
        else {
          const status = options.resumeStatus?.get(id) ?? { type: "idle" };
          statuses.set(id, status);
          loadedIds.add(id);
          respond(socket, request, { thread: thread(id, status) });
        }
      } else if (request.method === "thread/turns/list")
        respond(socket, request, { data: [], nextCursor: null });
      else respond(socket, request, {});
    }),
  );
  return {
    bridge,
    received,
    releaseInitialization() {
      assert.ok(initialize, "客户端应先完成初始化请求");
      initialize();
    },
    async dispose() {
      bridge.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true });
    },
  };
}

async function until(predicate: () => Promise<boolean>, timeout = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout)
      throw new Error("Timed out waiting for initial synchronization");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("opening before connection synchronizes only the latest 15 unknown user threads once", async () => {
  const users = Array.from({ length: 18 }, (_, index) => ({ rank: index + 1 }));
  const f = await fixture(
    [
      ...users,
      { rank: 40, status: { type: "active", activeFlags: [] } },
      { rank: 41, status: { type: "idle" } },
      { rank: 42, status: { type: "systemError" } },
      { rank: 43, kind: "agent" },
      { rank: 44, kind: "unknown" },
      { rank: 45, archived: true },
    ],
    {
      pauseInitialization: true,
      resumeStatus: new Map([
        [threadId(18), { type: "active", activeFlags: ["waitingOnApproval"] }],
        [threadId(16), { type: "active", activeFlags: [] }],
      ]),
    },
  );
  try {
    f.bridge.start();
    const openings = await Promise.all([f.bridge.open(), f.bridge.open()]);
    assert.equal(
      openings.every((snapshot) => snapshot.syncingThreads),
      true,
    );
    assert.equal(
      f.received.some((request) => request.method === "thread/resume"),
      false,
    );
    await until(async () =>
      f.received.some((request) => request.method === "initialize"),
    );
    f.releaseInitialization();
    await until(
      async () => (await f.bridge.snapshot()).syncingThreads === false,
    );

    const expected = Array.from({ length: 15 }, (_, index) =>
      threadId(18 - index),
    );
    const resumes = f.received.filter(
      (request) => request.method === "thread/resume",
    );
    assert.deepEqual(
      resumes.map((request) => request.params.threadId),
      expected,
    );
    for (const request of resumes)
      assert.deepEqual(request.params, {
        threadId: request.params.threadId,
        excludeTurns: true,
      });
    const snapshot = await f.bridge.snapshot();
    const threads = new Map(
      snapshot.threads.map((thread) => [thread.id, thread]),
    );
    assert.equal(columnFor(threads.get(threadId(18))!), "waiting");
    assert.equal(columnFor(threads.get(threadId(17))!), "idle");
    assert.equal(columnFor(threads.get(threadId(16))!), "running");
    assert.equal(columnFor(threads.get(threadId(3))!), "unknown");
    assert.equal(columnFor(threads.get(threadId(40))!), "running");
    assert.equal(columnFor(threads.get(threadId(42))!), "error");
    for (const id of expected) {
      assert.ok(
        f.received.some(
          (request) =>
            request.method === "thread/read" &&
            request.params.threadId === id &&
            request.params.includeTurns === false,
        ),
      );
      assert.ok(
        f.received.some(
          (request) =>
            request.method === "thread/turns/list" &&
            request.params.threadId === id,
        ),
      );
    }
    await Promise.all([f.bridge.open(), f.bridge.snapshot(), f.bridge.open()]);
    assert.equal(
      f.received.filter((request) => request.method === "thread/resume").length,
      15,
    );
    assert.equal(
      f.received.some((request) => request.method === "turn/start"),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("ordinary snapshots observe statuses without starting the initial synchronization", async () => {
  const f = await fixture([{ rank: 1 }]);
  try {
    f.bridge.start();
    await until(
      async () => (await f.bridge.snapshot()).connection.state === "connected",
    );
    await f.bridge.snapshot();
    await f.bridge.snapshot();
    assert.equal(
      f.received.some((request) => request.method === "thread/resume"),
      false,
    );
    assert.equal(columnFor((await f.bridge.snapshot()).threads[0]), "unknown");
  } finally {
    await f.dispose();
  }
});

test("initial synchronization rechecks native status and isolates one failed resume without backfilling", async () => {
  const f = await fixture(
    Array.from({ length: 17 }, (_, index) => ({ rank: index + 1 })),
    {
      failResume: threadId(16),
      readStatus: new Map([
        [threadId(17), { type: "active", activeFlags: [] }],
      ]),
    },
  );
  try {
    f.bridge.start();
    await f.bridge.open();
    await until(
      async () => (await f.bridge.snapshot()).syncingThreads === false,
    );
    const resumes = f.received.filter(
      (request) => request.method === "thread/resume",
    );
    assert.deepEqual(
      resumes.map((request) => request.params.threadId),
      Array.from({ length: 14 }, (_, index) => threadId(16 - index)),
    );
    const snapshot = await f.bridge.snapshot();
    const threads = new Map(
      snapshot.threads.map((thread) => [thread.id, thread]),
    );
    assert.equal(columnFor(threads.get(threadId(17))!), "running");
    assert.equal(columnFor(threads.get(threadId(16))!), "unknown");
    assert.equal(columnFor(threads.get(threadId(15))!), "idle");
    assert.equal(columnFor(threads.get(threadId(2))!), "unknown");
    assert.equal(columnFor(threads.get(threadId(1))!), "unknown");
    await f.bridge.open();
    await f.bridge.snapshot();
    assert.equal(
      f.received.filter((request) => request.method === "thread/resume").length,
      14,
    );
    assert.equal(
      f.received.some((request) => request.method === "turn/start"),
      false,
    );
  } finally {
    await f.dispose();
  }
});
