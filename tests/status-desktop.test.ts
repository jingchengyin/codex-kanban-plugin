import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StatusBridge } from "../server/status-bridge";
import { RemoteDataReader } from "../server/remote-data";
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
        if (
          ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(
            message.method,
          )
        ) {
          send({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            result: { ok: true },
          });
          const request = message.params.turnStart?.request ?? message.params;
          snapshot({
            ...state,
            turns: [
              {
                turnId: "message-test",
                status: "inProgress",
                items: [
                  {
                    type: "userMessage",
                    clientId: request.clientUserMessageId,
                    content: request.input,
                  },
                ],
              },
            ],
          });
        }
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

test("pending SSH metadata never blocks local desktop snapshots or updates", async (t) => {
  const f = await fixture();
  let releaseRemote!: (data: Awaited<ReturnType<RemoteDataReader["read"]>>) => void;
  const pendingRemote = new Promise<Awaited<ReturnType<RemoteDataReader["read"]>>>(
    (resolve) => {
      releaseRemote = resolve;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.bridge.open();
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.canSend === true,
    );
    t.mock.method(RemoteDataReader.prototype, "read", () => pendingRemote);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Local snapshots waited for SSH metadata")),
        1000,
      );
    });
    const first = await Promise.race([f.bridge.snapshot(null, [id]), timeout]);
    assert.equal(first.threads[0].fresh, true);
    assert.equal(first.threads[0].canSend, true);

    f.snapshot({ ...f.state(), threadRuntimeStatus: { type: "idle" } });
    await Promise.race([
      until(async () => {
        const next = await f.bridge.snapshot(null, [id]);
        return next.threads[0].fresh && columnFor(next.threads[0]) === "idle";
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    releaseRemote({ threads: [], hosts: [] });
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
          status: "inProgress",
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
          status: "inProgress",
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
          status: "inProgress",
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
          status: "inProgress",
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

for (const status of ["completed", "interrupted", "failed"]) {
  test(`a ${status} desktop turn ${status === "completed" ? "retains" : "clears"} unanswered async questions`, async () => {
    const f = await fixture();
    try {
      await f.bridge.snapshot(null, [id]);
      await until(
        async () => (await f.bridge.snapshot()).threads[0]?.fresh === true,
      );
      const question = {
        id: "retained-question",
        type: "agentMessage",
        questions: [
          { title: "继续处理吗？" },
          { title: "优先哪个目标？" },
          { title: "输出什么结果？" },
        ],
      };
      f.snapshot({
        ...f.state(),
        turnHistory: {
          history: {
            entitiesByKey: {
              current: {
                turnId: "question-turn",
                status: "inProgress",
                items: [question],
              },
            },
            islands: [{ entries: [{ value: "current" }] }],
          },
        },
        turns: [],
      });
      await until(
        async () =>
          columnFor((await f.bridge.snapshot()).threads[0]) === "waiting",
      );
      const waiting = await f.bridge.snapshot();
      assert.equal(waiting.threads[0].pendingUserInput, true);
      assert.ok(waiting.threads[0].waitingSince);
      assert.equal(waiting.threads[0].waitingQuestion, "继续处理吗？");
      assert.equal(waiting.confirmations?.requests.length, 1);
      assert.equal(waiting.confirmations?.requests[0].questions.length, 3);

      // 实时终态覆盖 canonical 的运行状态，但历史问题仍保留。
      f.snapshot({
        ...f.state(),
        threadRuntimeStatus: { type: "idle" },
        turns: [{ turnId: "question-turn", status, items: [] }],
      });
      await until(
        async () =>
          (await f.bridge.snapshot()).threads[0].runtime?.type === "idle",
      );
      const ended = await f.bridge.snapshot();
      const pending = status === "completed";
      assert.equal(
        columnFor(ended.threads[0]),
        pending ? "waiting" : status === "failed" ? "error" : "idle",
      );
      assert.equal(ended.threads[0].pendingUserInput, pending);
      assert.equal(
        ended.threads[0].waitingSince,
        pending ? waiting.threads[0].waitingSince : null,
      );
      assert.equal(
        ended.threads[0].waitingQuestion,
        pending ? "继续处理吗？" : null,
      );
      if (pending) {
        assert.equal(
          ended.confirmations?.requests[0].id,
          waiting.confirmations?.requests[0].id,
        );
        assert.equal(ended.confirmations?.requests[0].questions.length, 3);
      } else assert.deepEqual(ended.confirmations?.requests, []);

      f.snapshot({
        ...f.state(),
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turns: [
          { turnId: "question-turn", status, items: [] },
          {
            turnId: "next-turn",
            status: "inProgress",
            items: [
              { type: "userMessage", id: "new-input", content: [] },
              {
                ...question,
                id: "next-question",
                questions: [{ title: "本轮选择哪个方案？" }],
              },
            ],
          },
        ],
      });
      await until(
        async () =>
          (await f.bridge.snapshot()).threads[0].waitingQuestion ===
          "本轮选择哪个方案？",
      );
      const next = await f.bridge.snapshot();
      assert.equal(columnFor(next.threads[0]), "waiting");
      assert.equal(next.threads[0].pendingUserInput, true);
      assert.ok(next.threads[0].waitingSince);
      assert.equal(next.threads[0].waitingQuestion, "本轮选择哪个方案？");
      assert.deepEqual(
        next.confirmations?.requests.flatMap((request) =>
          request.questions.map((entry) => entry.question),
        ),
        ["本轮选择哪个方案？"],
      );
    } finally {
      await f.close();
    }
  });
}

test("duplicate sends share one delivery and reconnect snapshots control send availability", async () => {
  const f = await fixture();
  try {
    await f.bridge.open();
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.canSend === true,
    );
    const input = {
      threadId: id,
      clientUserMessageId: "00000000-0000-4000-8000-000000000123",
      text: "test message",
    };
    const results = await Promise.all([
      f.bridge.sendMessage(input),
      f.bridge.sendMessage(input),
    ]);
    assert.deepEqual(results, [{ submitted: true }, { submitted: true }]);
    assert.equal(
      f.messages.filter((m) => m.method === "thread-follower-steer-turn")
        .length,
      1,
    );
    assert.throws(
      () => f.bridge.sendMessage({ ...input, text: "different" }),
      /发送标识/,
    );
    f.snapshot({...f.state(),turns:[{turnId:"reply",items:[{type:"agentMessage",phase:"final_answer",text:"收到"}]}]});
    await until(async()=>(await f.bridge.snapshot()).threads[0]?.latestReply==="收到");
    f.disconnect();
    await until(
      async () => (await f.bridge.snapshot()).threads[0]?.canSend === false,
    );
  } finally {
    await f.close();
  }
});
