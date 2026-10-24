import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
          type: "token_count",
          info: { total_token_usage: { total_tokens: 123 } },
        }) +
        record({ type: "task_complete", turn_id: "latest", duration_ms: 4567 }),
    );
    const data = await readLocalData(home);
    assert.equal(data.threads[0].collaborationMode, "plan");
    assert.equal(data.threads[0].goalStatus, "paused");
    assert.equal(data.threads[0].turnUsage?.tokens, 123);
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
      ["initialize", "initialized", "thread/loaded/list", "thread/read"],
    );
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true });
  }
});

test("async question dialogs override ordinary active status, survive hydration/reconnect, and clear on replies or turn end", async () => {
  const home = await fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = new StatusBridge({
    home,
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  let turn = {
    id: "async-turn",
    status: "inProgress",
    items: [
      {
        type: "agentMessage",
        id: "async-question",
        text: "PRIVATE_BODY",
        questions: [{ title: "PRIVATE_QUESTION" }],
      },
    ] as any[],
  };
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
            : { id: message.id, result: { data: [turn] } },
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
            status: { type: "active", activeFlags: [] },
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

    for (const socket of server.clients) socket.close();
    await until(
      async () => (await bridge.snapshot()).connection.state === "disconnected",
    );
    assert.equal(await column(), "unknown");
    await until(async () => (await column()) === "waiting", 6500);

    holdRead = true;
    const refreshing = refresh();
    await until(async () => !!releaseRead);
    item(reply);
    await until(async () => (await column()) === "running");
    releaseRead!();
    await refreshing;
    assert.equal(
      await column(),
      "running",
      "stale hydration must not undo a live reply",
    );
    holdRead = false;
    turn.items.push(reply);
    await refresh();
    assert.equal(await column(), "running");

    const nextQuestion = {
      type: "agentMessage",
      id: "next-question",
      questions: [{ title: "PRIVATE_NEXT" }],
    };
    item(nextQuestion);
    await until(async () => (await column()) === "waiting");
    notify("turn/completed", {
      threadId: id,
      turn: { id: turn.id, status: "completed" },
    });
    turn.status = "completed";
    await until(async () => (await column()) === "running");
    await refresh();
    assert.equal(
      await column(),
      "running",
      "completed turns cannot retain pending dialogs",
    );

    turn = { id: "new-turn", status: "inProgress", items: [] };
    notify("turn/started", { threadId: id, turn: { id: turn.id } });
    item(nextQuestion, "async-turn");
    await refresh();
    assert.equal(
      await column(),
      "running",
      "old turn items cannot affect the new turn",
    );
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
    await until(async () => (await column()) === "idle");
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
