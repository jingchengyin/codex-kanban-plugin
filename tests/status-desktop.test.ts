import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StatusBridge } from "../server/status-bridge";
import { columnFor } from "../shared/types";

const id = "00000000-0000-0000-0000-000000000001";
const owner = "original-desktop-window";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Desktop status did not converge");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}

/** 以隔离桌面 socket 验证默认接入，不启动 Codex、不执行回合或真实审批。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "kanban-desktop-state-"));
  await mkdir(join(home, "ipc"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec(
    "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, archived INTEGER)",
  );
  database
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)")
    .run(id, "本地对话", "/work/project", 1800000000, "vscode", "user", 0);
  database.close();
  let state: any = {
    id,
    title: "本地对话",
    cwd: "/work/project",
    updatedAt: 1800000000000,
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    latestModel: "live-model",
    latestReasoningEffort: "high",
    latestCollaborationMode: "plan",
    threadGoal: { status: "active" },
    hasUnreadTurn: true,
    turns: [],
    requests: [],
  };
  const messages: any[] = [];
  let socket: Socket;
  let revision = 0;
  const send = (message: object) => {
    const data = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    socket.write(Buffer.concat([header, data]));
  };
  const snapshot = (next: any = state) => {
    state = next;
    send({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: owner,
      params: {
        hostId: "local",
        conversationId: id,
        change: {
          type: "snapshot",
          revision: ++revision,
          conversationState: state,
        },
      },
    });
  };
  const server = createServer((connection) => {
    socket = connection;
    let buffer = Buffer.alloc(0);
    connection.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (buffer.length < size + 4) return;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        messages.push(message);
        if (message.method === "initialize")
          send({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { clientId: "board-observer" },
          });
        if (
          message.method === "thread-stream-following-changed" &&
          message.params.following &&
          message.params.conversationId === id
        )
          snapshot();
      }
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((ok) =>
    server.listen(join(home, "ipc", "ipc.sock"), ok),
  );
  const bridge = new StatusBridge({ home });
  bridge.start();
  return {
    bridge,
    messages,
    snapshot,
    state: () => state,
    disconnect: () => socket.destroy(),
    async close() {
      bridge.stop();
      socket?.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("default bridge observes the original desktop without spawning or resuming a backend", async () => {
  const f = await fixture();
  try {
    await f.bridge.open();
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
    );
    const data = await f.bridge.snapshot();
    assert.match(data.connection.endpoint, /^ipc:\/\//);
    assert.equal(data.connection.state, "connected");
    const thread = data.threads[0];
    assert.equal(columnFor(thread), "running");
    assert.equal(thread.model, "live-model");
    assert.equal(thread.reasoningEffort, "high");
    assert.equal(thread.collaborationMode, "plan");
    assert.equal(thread.goalStatus, "active");
    assert.equal(thread.unread, true);
    assert.equal(data.syncingThreads, false);
    assert.deepEqual([...new Set(f.messages.map((m) => m.method))].sort(), [
      "initialize",
      "thread-stream-following-changed",
    ]);
    f.snapshot({
      ...f.state(),
      threadRuntimeStatus: { type: "idle" },
      threadGoal: null,
      latestCollaborationMode: "default",
    });
    await until(
      async () => columnFor((await f.bridge.snapshot()).threads[0]) === "idle",
    );
    assert.equal((await f.bridge.snapshot()).threads[0].goalStatus, "none");
  } finally {
    await f.close();
  }
});

test("canonical message order clears answered questions and keeps the latest failed turn", async () => {
  const f = await fixture();
  try {
    await f.bridge.snapshot(null, [id]);
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
    );
    const question = {
      id: "q",
      type: "agentMessage",
      questions: [{ title: "选哪个方案？" }],
    };
    const turn1 = { turnId: "first", status: "completed", items: [question] };
    const turn2 = {
      turnId: "second",
      status: "completed",
      items: [
        { id: "answer", type: "steeringUserMessage", status: "accepted" },
      ],
    };
    const history = {
      entitiesByKey: { second: turn2, first: turn1 },
      islands: [{ entries: [{ value: "first" }, { value: "second" }] }],
    };
    f.snapshot({
      ...f.state(),
      threadRuntimeStatus: { type: "idle" },
      turns: [],
      turnHistory: { history },
    });
    await until(
      async () =>
        (await f.bridge.snapshot()).threads[0].runtime?.type === "idle",
    );
    assert.equal(
      (await f.bridge.snapshot()).threads[0].pendingUserInput,
      false,
    );
    f.snapshot({
      ...f.state(),
      turns: [
        {
          turnId: "third",
          status: "failed",
          items: [{ ...question, id: "new-question" }],
        },
      ],
    });
    await until(
      async () => columnFor((await f.bridge.snapshot()).threads[0]) === "error",
    );
    f.snapshot({
      ...f.state(),
      turns: [
        {
          turnId: "third",
          status: "completed",
          items: [{ ...question, id: "new-question" }],
        },
      ],
    });
    await until(
      async () =>
        columnFor((await f.bridge.snapshot()).threads[0]) === "waiting",
    );
    assert.equal(
      (await f.bridge.snapshot()).threads[0].waitingQuestion,
      "选哪个方案？",
    );
  } finally {
    await f.close();
  }
});

test("closing the observed view and losing the desktop revoke freshness and confirmations", async () => {
  const f = await fixture();
  try {
    await f.bridge.snapshot(null, [id]);
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
    );
    f.snapshot({
      ...f.state(),
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
      requests: [
        {
          id: 21,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: id,
            turnId: "turn",
            itemId: "command",
            command: "printf fixture",
          },
        },
      ],
    });
    await until(
      async () =>
        (await f.bridge.snapshot()).confirmations?.requests.length === 1,
    );
    await f.bridge.snapshot(null, []);
    await until(async () =>
      f.messages.some((m) => m.params?.following === false),
    );
    const closed = await f.bridge.snapshot();
    assert.equal(closed.threads[0].fresh, false);
    assert.equal(columnFor(closed.threads[0]), "unknown");
    assert.deepEqual(closed.confirmations?.requests, []);
    await f.bridge.snapshot(null, [id]);
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
    );
    f.disconnect();
    await until(
      async () =>
        (await f.bridge.snapshot()).connection.state === "disconnected",
    );
    const lost = await f.bridge.snapshot();
    assert.equal(lost.threads[0].fresh, false);
    assert.equal(lost.confirmations?.available, false);
    assert.deepEqual(lost.confirmations?.requests, []);
  } finally {
    await f.close();
  }
});

test("a sparse live turn keeps canonical questions until an accepted user reply arrives", async () => {
  const f = await fixture();
  try {
    await f.bridge.snapshot(null, [id]);
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
    );
    const question = {
      id: "question",
      type: "agentMessage",
      questions: [{ title: "继续吗？" }],
    };
    f.snapshot({
      ...f.state(),
      threadRuntimeStatus: { type: "idle" },
      turnHistory: {
        history: {
          entitiesByKey: { first: { turnId: "first", items: [question] } },
          islands: [{ entries: [{ value: "first" }] }],
        },
      },
      turns: [
        {
          turnId: "first",
          status: "completed",
          items: [{ id: "tail", type: "agentMessage" }],
        },
      ],
    });
    await until(
      async () =>
        columnFor((await f.bridge.snapshot()).threads[0]) === "waiting",
    );
    f.snapshot({
      ...f.state(),
      turns: [
        {
          turnId: "first",
          status: "completed",
          items: [
            { id: "answer", type: "steeringUserMessage", status: "pending" },
          ],
        },
      ],
    });
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(columnFor((await f.bridge.snapshot()).threads[0]), "waiting");
    f.snapshot({
      ...f.state(),
      turns: [
        {
          turnId: "first",
          status: "completed",
          items: [
            { id: "answer", type: "steeringUserMessage", status: "accepted" },
          ],
        },
      ],
    });
    await until(
      async () => columnFor((await f.bridge.snapshot()).threads[0]) === "idle",
    );
  } finally {
    await f.close();
  }
});
