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
