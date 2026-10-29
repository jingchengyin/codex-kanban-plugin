import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { StatusBridge } from "../server/status-bridge";
import { readLocalData } from "../server/local-data";
import { columnFor } from "../shared/types";

const id = "00000000-0000-0000-0000-000000000001";
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_role TEXT, archived INTEGER, first_user_message TEXT)",
  );
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    id,
    "真实元数据标题",
    "/work/project",
    1700000000,
    "vscode",
    "user",
    null,
    0,
    "PRIVATE_BODY_MUST_NOT_LEAK",
  );
  db.close();
  await writeFile(
    join(home, ".codex-global-state.json"),
    JSON.stringify({
      "electron-thread-read-state-v1": {
        unreadByIdentity: { account: { "local:host": [id] } },
      },
    }),
  );
  return home;
}
async function until(predicate: () => Promise<boolean>, timeout = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout)
      throw new Error("Timed out waiting for state");
    await new Promise((r) => setTimeout(r, 20));
  }
}
test("local reader returns title and unread without exposing prompt bodies or inventing runtime", async () => {
  const home = await fixture();
  try {
    const data = await readLocalData(home);
    assert.equal(data.metadata, true);
    assert.equal(data.threads[0].unread, true);
    assert.equal(data.threads[0].runtime, null);
    assert.equal(data.threads[0].model, null);
    assert.equal(data.threads[0].reasoningEffort, null);
    assert.equal(data.threads[0].collaborationMode, null);
    assert.equal(data.threads[0].goalStatus, null);
    assert.equal(data.threads[0].turnUsage, null);
    assert.equal(JSON.stringify(data).includes("PRIVATE_BODY"), false);
  } finally {
    await rm(home, { recursive: true });
  }
});
test("local reader reuses normal startup records and follows file updates without rewriting them", async () => {
  const home = await fixture();
  const path = join(home, ".codex-global-state.json");
  const normal =
    "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c";
  const shared =
    "local:7dc900dd6a290203089e04146af2bfd891d16d31297f87dd05c8ff68065a145f";
  try {
    for (const unread of [true, false]) {
      const content = JSON.stringify({
        "electron-thread-read-state-v1": {
          unreadByIdentity: {
            account: { [normal]: unread ? [id] : [], [shared]: [id] },
          },
        },
      });
      await writeFile(path, content);
      const data = await readLocalData(home);
      assert.equal(data.unread, true);
      assert.equal(data.threads[0].unread, unread);
      assert.equal(data.unreadReason.includes("复用普通启动"), true);
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally {
    await rm(home, { recursive: true });
  }
});
test("unread source counts include only visible user conversations and follow source selection", async () => {
  const home = await fixture();
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  const normal =
    "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c";
  const shared =
    "local:7dc900dd6a290203089e04146af2bfd891d16d31297f87dd05c8ff68065a145f";
  const agentId = "00000000-0000-0000-0000-000000000002";
  const roleAgentId = "00000000-0000-0000-0000-000000000003";
  const archivedId = "00000000-0000-0000-0000-000000000004";
  const readUserId = "00000000-0000-0000-0000-000000000005";
  const missingId = "00000000-0000-0000-0000-000000000006";
  try {
    const insert = db.prepare(
      "INSERT INTO threads(id,title,cwd,updated_at,source,thread_source,agent_role,archived) VALUES(?,'测试对话','/work/project',1700000000,?,?,?,?)",
    );
    insert.run(
      agentId,
      JSON.stringify({ subagent: { thread_spawn: {} } }),
      null,
      null,
      0,
    );
    insert.run(roleAgentId, "vscode", "user", "reviewer", 0);
    insert.run(archivedId, "vscode", "user", null, 1);
    insert.run(readUserId, "vscode", "user", null, 0);
    const excludedIds = [agentId, roleAgentId, archivedId, missingId];
    const path = join(home, ".codex-global-state.json");
    const state = {
      "electron-thread-read-state-v1": {
        unreadByIdentity: {
          account: {
            [normal]: [id, ...excludedIds],
            [shared]: [readUserId, ...excludedIds],
          },
        },
      },
    };
    await writeFile(path, JSON.stringify(state));
    const automatic = await readLocalData(home);
    assert.deepEqual(
      automatic.unreadOptions.map(({ count }) => count),
      [1, 1],
    );
    assert.equal(
      automatic.threads.find((thread) => thread.id === id)?.unread,
      true,
    );
    assert.equal(
      automatic.threads.find((thread) => thread.id === readUserId)?.unread,
      false,
    );
    assert.equal(
      automatic.threads.filter(
        (thread) => thread.kind === "user" && thread.unread,
      ).length,
      1,
    );
    const selected = await readLocalData(
      home,
      JSON.stringify(["account", shared]),
    );
    assert.deepEqual(selected.unreadOptions, automatic.unreadOptions);
    assert.equal(
      selected.threads.find((thread) => thread.id === id)?.unread,
      false,
    );
    assert.equal(
      selected.threads.find((thread) => thread.id === readUserId)?.unread,
      true,
    );
    state["electron-thread-read-state-v1"].unreadByIdentity.account[normal] =
      excludedIds;
    await writeFile(path, JSON.stringify(state));
    const noUserUnread = await readLocalData(home);
    assert.deepEqual(
      noUserUnread.unreadOptions.map(({ count }) => count),
      [0, 1],
    );
    assert.equal(
      noUserUnread.threads.some(
        (thread) => thread.kind === "user" && thread.unread,
      ),
      false,
    );
  } finally {
    db.close();
    await rm(home, { recursive: true });
  }
});
test("local reader exposes stored model and reasoning effort and picks up changes", async () => {
  const home = await fixture();
  try {
    const db = new DatabaseSync(join(home, "state_5.sqlite"));
    db.exec(
      "ALTER TABLE threads ADD COLUMN model TEXT; ALTER TABLE threads ADD COLUMN reasoning_effort TEXT",
    );
    db.prepare("UPDATE threads SET model=?, reasoning_effort=? WHERE id=?").run(
      "gpt-6.1-sol",
      "ultra",
      id,
    );
    const first = (await readLocalData(home)).threads[0];
    assert.equal(first.model, "gpt-6.1-sol");
    assert.equal(first.reasoningEffort, "ultra");
    db.prepare("UPDATE threads SET model=?, reasoning_effort=? WHERE id=?").run(
      "gpt-6-astra",
      "high",
      id,
    );
    const updated = (await readLocalData(home)).threads[0];
    assert.equal(updated.model, "gpt-6-astra");
    assert.equal(updated.reasoningEffort, "high");
    db.close();
  } finally {
    await rm(home, { recursive: true });
  }
});
test("local reader joins per-turn metrics and goal lifecycle without exposing goal text", async () => {
  const home = await fixture();
  const path = join(home, "rollout.jsonl");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  const goals = new DatabaseSync(join(home, "goals_1.sqlite"));
  try {
    db.exec("ALTER TABLE threads ADD COLUMN rollout_path TEXT");
    db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(path, id);
    goals.exec(
      "CREATE TABLE thread_goals(thread_id TEXT, status TEXT, objective TEXT)",
    );
    goals
      .prepare("INSERT INTO thread_goals VALUES(?,?,?)")
      .run(id, "paused", "PRIVATE_GOAL");
    const record = (payload: object) =>
      JSON.stringify({
        timestamp: "2026-10-24T00:00:00Z",
        type: "event_msg",
        payload,
      }) + "\n";
    await writeFile(
      path,
      record({
        type: "task_started",
        turn_id: "latest",
        collaboration_mode_kind: "plan",
      }) +
        record({
          type: "user_message",
          message: "本轮的真实用户输入\n第二行",
        }) +
        record({
          type: "token_count",
          info: { total_token_usage: { total_tokens: 123 } },
        }) +
        record({ type: "task_complete", turn_id: "latest", duration_ms: 4567 }),
    );
    const data = await readLocalData(home);
    assert.equal(data.threads[0].collaborationMode, "plan");
    assert.equal(data.threads[0].goalStatus, "paused");
    assert.equal(data.threads[0].turnUsage?.tokens, 123);
    assert.equal(
      data.threads[0].turnUsage?.userInput,
      "本轮的真实用户输入\n第二行",
    );
    assert.equal(data.threads[0].turnUsage?.durationMs, 4567);
    assert.equal(JSON.stringify(data).includes("PRIVATE"), false);
    goals.prepare("UPDATE thread_goals SET status=?").run("budget_limited");
    assert.equal(
      (await readLocalData(home)).threads[0].goalStatus,
      "budgetLimited",
    );
    goals.exec("DELETE FROM thread_goals");
    assert.equal((await readLocalData(home)).threads[0].goalStatus, "none");
  } finally {
    db.close();
    goals.close();
    await rm(home, { recursive: true });
  }
});
test("snapshots sort by the latest user message instead of thread updates and place unknown times last", async () => {
  const home = await fixture();
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  const latestId = "00000000-0000-0000-0000-000000000002";
  const unknownId = "00000000-0000-0000-0000-000000000003";
  const earlierAt = "2026-10-24T00:00:10.000Z";
  const latestAt = "2026-10-24T00:00:20.000Z";
  try {
    db.exec("ALTER TABLE threads ADD COLUMN rollout_path TEXT");
    const earlierPath = join(home, "earlier.jsonl");
    const latestPath = join(home, "latest.jsonl");
    const unknownPath = join(home, "unknown.jsonl");
    db.prepare(
      "UPDATE threads SET updated_at=?, rollout_path=? WHERE id=?",
    ).run(1792800300, earlierPath, id);
    const insert = db.prepare(
      "INSERT INTO threads(id, title, cwd, updated_at, source, archived, rollout_path) VALUES(?,?,?,?,?,?,?)",
    );
    insert.run(
      latestId,
      "最近发消息",
      "/work/project",
      1792800200,
      "vscode",
      0,
      latestPath,
    );
    insert.run(
      unknownId,
      "没有用户输入",
      "/work/project",
      1792800400,
      "vscode",
      0,
      unknownPath,
    );
    const record = (at: string, payload: object) =>
      JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n";
    for (const [path, at] of [
      [earlierPath, earlierAt],
      [latestPath, latestAt],
    ])
      await writeFile(
        path,
        record(at, { type: "task_started", turn_id: "latest" }) +
          record(at, { type: "user_message", message: "用户输入" }),
      );
    await writeFile(
      unknownPath,
      record(latestAt, { type: "task_started", turn_id: "automatic" }),
    );

    const local = await readLocalData(home);
    assert.deepEqual(
      Object.fromEntries(
        local.threads.map((thread) => [thread.id, thread.lastUserMessageAt]),
      ),
      { [id]: earlierAt, [latestId]: latestAt, [unknownId]: null },
    );
    // 元数据更新时间相反，排序仍以用户发消息时间为准。
    assert.deepEqual(
      local.threads.map((thread) => thread.id),
      [unknownId, id, latestId],
    );
    const snapshot = await new StatusBridge({ home }).snapshot();
    assert.deepEqual(
      snapshot.threads.map((thread) => thread.id),
      [latestId, id, unknownId],
    );
  } finally {
    db.close();
    await rm(home, { recursive: true });
  }
});
test("real WebSocket notifications update waiting/running/error, ignore approval requests, and invalidate snapshots on disconnect", async () => {
  const home = await fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = new StatusBridge({
    home,
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  const received: any[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (!message.method || message.id === undefined) return;
      const responses: Record<string, unknown> = {
        initialize: {},
        "thread/loaded/list": { data: [id] },
        "thread/read": {
          thread: { id, cwd: "/work/project", status: { type: "idle" } },
        },
      };
      socket.send(
        JSON.stringify({ id: message.id, result: responses[message.method] }),
      );
    }),
  );
  const notify = (method: string, params: object) => {
    for (const socket of server.clients)
      socket.send(JSON.stringify({ method, params }));
  };
  try {
    bridge.start();
    await until(
      async () =>
        (await bridge.snapshot()).threads[0]?.runtime?.type === "idle",
    );
    notify("thread/settings/updated", {
      threadId: id,
      threadSettings: { collaborationMode: { mode: "plan" } },
    });
    notify("thread/goal/updated", {
      threadId: id,
      goal: { status: "active", objective: "PRIVATE_GOAL" },
    });
    await until(async () => {
      const thread = (await bridge.snapshot()).threads[0];
      return (
        thread.collaborationMode === "plan" && thread.goalStatus === "active"
      );
    });
    assert.equal(
      JSON.stringify(await bridge.snapshot()).includes("PRIVATE_GOAL"),
      false,
    );
    notify("thread/goal/cleared", { threadId: id });
    await until(
      async () => (await bridge.snapshot()).threads[0].goalStatus === "none",
    );
    notify("thread/status/changed", {
      threadId: id,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    await until(
      async () => columnFor((await bridge.snapshot()).threads[0]) === "waiting",
    );
    for (const socket of server.clients)
      socket.send(
        JSON.stringify({
          id: 808,
          method: "item/commandExecution/requestApproval",
          params: { threadId: id },
        }),
      );
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      received.some((message) => message.id === 808),
      false,
    );
    notify("thread/status/changed", {
      threadId: id,
      status: { type: "active", activeFlags: [] },
    });
    await until(
      async () => columnFor((await bridge.snapshot()).threads[0]) === "running",
    );
    notify("turn/completed", { threadId: id, turn: { status: "failed" } });
    await until(
      async () => columnFor((await bridge.snapshot()).threads[0]) === "error",
    );
    notify("turn/started", { threadId: id });
    await until(
      async () => columnFor((await bridge.snapshot()).threads[0]) === "running",
    );
    for (const socket of server.clients) socket.close();
    await until(
      async () => (await bridge.snapshot()).connection.state === "disconnected",
    );
    const stale = (await bridge.snapshot()).threads[0];
    assert.equal(stale.runtime?.type, "active");
    assert.equal(stale.fresh, false);
    assert.equal(columnFor(stale), "unknown");
    await until(async () => {
      const restored = await bridge.snapshot();
      return (
        restored.connection.state === "connected" &&
        restored.threads[0]?.runtime?.type === "idle"
      );
    }, 6500);
    assert.equal(columnFor((await bridge.snapshot()).threads[0]), "idle");
    assert.equal((await bridge.snapshot()).threads[0].collaborationMode, null);
    assert.equal((await bridge.snapshot()).threads[0].goalStatus, null);
    assert.deepEqual(
      [...new Set(received.map((message) => message.method))].sort(),
      [
        "initialize",
        "initialized",
        "thread/loaded/list",
        "thread/read",
        "thread/turns/list",
      ],
    );
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true });
  }
});

test("async questions follow user-message order across live events, automatic turns and reconnect", async () => {
  const home = await fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = new StatusBridge({
    home,
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  let nativeStatus: { type: "active" | "idle"; activeFlags?: string[] } = {
    type: "idle",
  };
  let turn = {
    id: "async-turn",
    status: "completed",
    items: [
      {
        type: "agentMessage",
        id: "async-question",
        text: "PRIVATE_BODY",
        questions: [{ title: "选择发布范围" }],
      },
    ] as any[],
  };
  const olderTurns: (typeof turn)[] = [];
  const received: any[] = [];
  let holdRead = false;
  let releaseRead: (() => void) | undefined;
  let unsupported = false;
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (!message.method || message.id === undefined) return;
      if (message.method === "thread/turns/list") {
        const response = JSON.stringify(
          unsupported
            ? {
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              }
            : {
                id: message.id,
                result: {
                  data: [turn, ...olderTurns].slice(
                    Number(message.params.cursor ?? 0),
                    Number(message.params.cursor ?? 0) + 1,
                  ),
                  nextCursor:
                    Number(message.params.cursor ?? 0) < olderTurns.length
                      ? String(Number(message.params.cursor ?? 0) + 1)
                      : null,
                },
              },
        );
        if (holdRead) releaseRead = () => socket.send(response);
        else socket.send(response);
        return;
      }
      const responses: Record<string, unknown> = {
        initialize: {},
        "thread/loaded/list": { data: [id] },
        "thread/read": {
          thread: {
            id,
            cwd: "/work/project",
            status: nativeStatus,
          },
        },
      };
      socket.send(
        JSON.stringify({ id: message.id, result: responses[message.method] }),
      );
    }),
  );
  const notify = (method: string, params: object) => {
    for (const socket of server.clients)
      socket.send(JSON.stringify({ method, params }));
  };
  const column = async () => columnFor((await bridge.snapshot()).threads[0]);
  // Exercise periodic hydration deterministically without a ten-second timer.
  const refresh = () => (bridge as any).hydrate() as Promise<void>;
  const item = (value: any, turnId = turn.id) =>
    notify("item/completed", { threadId: id, turnId, item: value });
  const reply = {
    type: "userMessage",
    content: [
      {
        type: "text",
        text: `<send_user_message_question_reply>${JSON.stringify({ questionItemId: JSON.stringify(["request_user_input_async", "async-question", 0]), question: "PRIVATE_QUESTION", answer: "" })}</send_user_message_question_reply>`,
      },
    ],
  };
  try {
    bridge.start();
    await until(async () => (await column()) === "waiting");
    assert.equal((await bridge.snapshot()).threads[0].runtime?.type, "idle");
    const initialWaiting = (await bridge.snapshot()).threads[0];
    assert.equal(initialWaiting.waitingQuestion, "选择发布范围");
    assert.ok(initialWaiting.waitingSince);
    assert.equal(
      JSON.stringify(await bridge.snapshot()).includes("PRIVATE"),
      false,
    );
    assert.deepEqual(
      received.find((message) => message.method === "thread/turns/list").params,
      { threadId: id, limit: 1, sortDirection: "desc", itemsView: "full" },
    );
    await refresh();
    assert.equal(await column(), "waiting");
    assert.equal(
      (await bridge.snapshot()).threads[0].waitingSince,
      initialWaiting.waitingSince,
      "periodic hydration must retain the first observation of the same question",
    );

    for (const socket of server.clients) socket.close();
    await until(
      async () => (await bridge.snapshot()).connection.state === "disconnected",
    );
    assert.equal(await column(), "unknown");
    assert.equal((await bridge.snapshot()).threads[0].waitingQuestion, null);
    assert.equal((await bridge.snapshot()).threads[0].waitingSince, null);
    await until(async () => (await column()) === "waiting", 6500);
    assert.equal(
      (await bridge.snapshot()).threads[0].waitingQuestion,
      "选择发布范围",
    );

    holdRead = true;
    const refreshing = refresh();
    await until(async () => !!releaseRead);
    item(reply);
    await until(async () => (await column()) === "idle");
    assert.equal((await bridge.snapshot()).threads[0].waitingQuestion, null);
    assert.equal((await bridge.snapshot()).threads[0].waitingSince, null);
    releaseRead!();
    await refreshing;
    assert.equal(
      await column(),
      "idle",
      "stale hydration must not undo a live reply",
    );
    holdRead = false;
    turn.items.push(reply);
    await refresh();
    assert.equal(await column(), "idle");

    const nextQuestion = {
      type: "agentMessage",
      id: "next-question",
      questions: [{ title: "选择测试环境" }],
    };
    item(nextQuestion);
    await until(async () => (await column()) === "waiting");
    const nextWaiting = (await bridge.snapshot()).threads[0];
    assert.equal(nextWaiting.waitingQuestion, "选择测试环境");
    assert.notEqual(nextWaiting.waitingSince, initialWaiting.waitingSince);
    turn.items.push(nextQuestion);
    notify("turn/completed", {
      threadId: id,
      turn: { id: turn.id, status: "completed" },
    });
    turn.status = "completed";
    assert.equal(await column(), "waiting");
    assert.equal(
      (await bridge.snapshot()).threads[0].waitingSince,
      nextWaiting.waitingSince,
    );
    await refresh();
    assert.equal(
      await column(),
      "waiting",
      "completed turns retain unanswered dialogs until the user responds",
    );

    // 助手最终答复不等于用户输入，必须保留此前的待答状态。
    const finalAnswer = {
      type: "agentMessage",
      id: "final-answer",
      phase: "final_answer",
      text: "PRIVATE_RESULT",
      questions: null,
    };
    item(finalAnswer);
    turn.items.push(finalAnswer);
    await refresh();
    assert.equal(await column(), "waiting");
    const ordinaryReply = {
      type: "userMessage",
      content: [{ type: "text", text: "PRIVATE_USER_INPUT" }],
    };
    item(ordinaryReply);
    await until(async () => (await column()) === "idle");
    turn.items.push(ordinaryReply);
    await refresh();
    assert.equal(await column(), "idle");
    for (const socket of server.clients) socket.close();
    await until(
      async () => (await bridge.snapshot()).connection.state === "disconnected",
    );
    await until(async () => (await column()) === "idle", 6500);
    assert.equal(
      JSON.stringify(await bridge.snapshot()).includes("PRIVATE"),
      false,
    );

    // 清除历史提问后，原生确认与输入等待仍必须显示为待处理。
    for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
      nativeStatus = { type: "active", activeFlags: [flag] };
      notify("thread/status/changed", { threadId: id, status: nativeStatus });
      await until(
        async () =>
          !!(await bridge.snapshot()).threads[0].runtime?.activeFlags?.includes(
            flag,
          ),
      );
      assert.equal(await column(), "waiting");
      const nativeWaiting = (await bridge.snapshot()).threads[0];
      assert.ok(nativeWaiting.waitingSince);
      assert.equal(nativeWaiting.waitingQuestion, null);
      await refresh();
      assert.equal(
        (await bridge.snapshot()).threads[0].waitingSince,
        nativeWaiting.waitingSince,
      );
    }
    nativeStatus = { type: "idle" };
    notify("thread/status/changed", { threadId: id, status: nativeStatus });
    await until(async () => (await column()) === "idle");

    // 自动续跑没有用户消息，实时新轮和分页回读都必须保留旧问题。
    const unanswered = { ...nextQuestion, id: "unanswered-question" };
    item(unanswered);
    await until(async () => (await column()) === "waiting");
    turn.items.push(unanswered);
    olderTurns.unshift(turn);
    turn = { id: "automatic-turn", status: "inProgress", items: [finalAnswer] };
    nativeStatus = { type: "active", activeFlags: [] };
    notify("thread/status/changed", { threadId: id, status: nativeStatus });
    notify("turn/started", { threadId: id, turn: { id: turn.id } });
    await refresh();
    assert.equal(await column(), "waiting");
    for (const socket of server.clients) socket.close();
    await until(
      async () => (await bridge.snapshot()).connection.state === "disconnected",
    );
    await until(async () => (await column()) === "waiting", 6500);
    assert.ok(
      received.some(
        (message) =>
          message.method === "thread/turns/list" &&
          message.params.cursor === "1",
      ),
      "automatic turns without input must inspect the preceding turn",
    );
    item(ordinaryReply);
    await until(async () => (await column()) === "running");
    turn.items.push(ordinaryReply);
    await refresh();
    assert.equal(await column(), "running");

    // 用户开启的新轮会清除旧问题；迟到的旧轮事件不能影响它。
    olderTurns.unshift(turn);
    turn = { id: "new-turn", status: "inProgress", items: [ordinaryReply] };
    notify("turn/started", { threadId: id, turn: { id: turn.id } });
    item(ordinaryReply);
    item(nextQuestion, "async-turn");
    await refresh();
    assert.equal(await column(), "running");
    unsupported = true;
    await refresh();
    assert.equal((await bridge.snapshot()).connection.state, "connected");
    item(nextQuestion);
    await until(async () => (await column()) === "waiting");
    await refresh();
    assert.equal(
      await column(),
      "waiting",
      "older servers retain live question evidence",
    );
    notify("thread/status/changed", { threadId: id, status: { type: "idle" } });
    await until(
      async () => (await bridge.snapshot()).threads[0].runtime?.type === "idle",
    );
    assert.equal(
      await column(),
      "waiting",
      "idle notifications do not answer a question",
    );
    assert.deepEqual(
      [...new Set(received.map((message) => message.method))].sort(),
      [
        "initialize",
        "initialized",
        "thread/loaded/list",
        "thread/read",
        "thread/turns/list",
      ],
    );
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true });
  }
});
