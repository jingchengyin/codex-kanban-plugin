import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopIpc, type DesktopConversation } from "../server/desktop-ipc";

const thread = "existing-thread";
const owner = "desktop-window-owner";

async function until(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Desktop IPC fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function frame(message: object) {
  const body = Buffer.from(JSON.stringify(message));
  const value = Buffer.alloc(4 + body.length);
  value.writeUInt32LE(body.length);
  body.copy(value, 4);
  return value;
}

/** 隔离的桌面路由器，仅在临时 Unix socket 上模拟原协议。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "kanban-ipc-"));
  const socketPath = join(home, "ipc.sock");
  const messages: any[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const clientId = `observer-${sockets.length}`;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (buffer.length < size + 4) return;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        messages.push(message);
        if (message.method === "initialize")
          socket.write(
            frame({
              type: "response",
              requestId: message.requestId,
              resultType: "success",
              method: "initialize",
              result: { clientId },
            }),
          );
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const connectionStates: { state: string; message?: string }[] = [];
  const changes: { id: string; value: DesktopConversation }[] = [];
  const unavailable: string[] = [];
  const client = new DesktopIpc({
    home,
    socketPath,
    retryMs: 20,
    onState: (state, message) => connectionStates.push({ state, message }),
    onConversation: (id, value) => changes.push({ id, value }),
    onUnavailable: (id) => unavailable.push(id),
  });
  const send = (message: object) =>
    sockets[sockets.length - 1].write(frame(message));
  const snapshot = (
    state: any,
    revision = 1,
    sourceClientId = owner,
    id = thread,
  ) =>
    send({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId,
      params: {
        conversationId: id,
        hostId: "local",
        change: { type: "snapshot", revision, conversationState: state },
      },
    });
  const patches = (
    patches: any[],
    baseRevision = 1,
    revision = 2,
    sourceClientId = owner,
  ) =>
    send({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId,
      params: {
        conversationId: thread,
        hostId: "local",
        change: { type: "patches", baseRevision, revision, patches },
      },
    });
  return {
    home,
    client,
    messages,
    sockets,
    connectionStates,
    changes,
    unavailable,
    send,
    snapshot,
    patches,
    async ready(ids = [thread]) {
      client.watch(ids);
      client.start();
      await until(() =>
        messages.some(
          (message) => message.method === "thread-stream-following-changed",
        ),
      );
    },
    async close() {
      client.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("desktop IPC initializes as an observer and applies framed snapshots and Immer patches", async () => {
  const f = await fixture();
  try {
    await f.ready();
    assert.deepEqual(f.messages[0].params, { clientType: "codex-kanban" });
    assert.equal(f.messages[0].version, 0);
    assert.deepEqual(f.messages[1], {
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: "observer-1",
      version: 1,
      params: { conversationId: thread, hostId: "local", following: true },
    });
    const payload = frame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: owner,
      version: 11,
      params: {
        conversationId: thread,
        hostId: "local",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            requests: [{ id: "first" }],
            threadRuntimeStatus: { type: "active" },
          },
        },
      },
    });
    f.sockets[0].write(payload.subarray(0, 2));
    f.sockets[0].write(payload.subarray(2, 10));
    f.sockets[0].write(payload.subarray(10));
    await until(() => !!f.client.get(thread));
    f.patches([
      { op: "add", path: ["requests", 0], value: { id: "second" } },
      { op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" },
      { op: "remove", path: ["requests", 1] },
    ]);
    await until(() => f.client.get(thread)?.revision === 2);
    assert.deepEqual(f.client.get(thread)?.state, {
      requests: [{ id: "second" }],
      threadRuntimeStatus: { type: "idle" },
    });
    assert.equal(f.client.get(thread)?.ownerClientId, owner);
    assert.equal(
      f.connectionStates.some((value) => value.state === "connected"),
      true,
    );
    f.send({
      type: "client-discovery-request",
      requestId: "discovery",
      request: { method: "thread-owner-discovery" },
    });
    await until(() =>
      f.messages.some(
        (message) => message.type === "client-discovery-response",
      ),
    );
    assert.deepEqual(f.messages.at(-1).response, { canHandle: false });
    assert.equal(
      f.messages.some((message) => message.method?.includes("start-turn")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("missing revisions revoke stale state and request a replacement snapshot", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [{ id: "old" }] }, 4);
    await until(() => !!f.client.get(thread));
    f.patches([{ op: "remove", path: ["requests", 0] }], 5, 6);
    await until(() => f.unavailable.includes(thread));
    assert.equal(f.client.get(thread), undefined);
    await until(
      () =>
        f.messages.filter((message) => message.params?.following === true)
          .length === 2,
    );
    await assert.rejects(
      f.client.requestOwner(thread, "thread-follower-submit-user-input", {}),
      /已失效/,
    );
    f.snapshot({ requests: [] }, 7);
    await until(() => f.client.get(thread)?.revision === 7);
    f.patches(
      [{ op: "replace", path: ["missing", "field"], value: true }],
      7,
      8,
    );
    await until(() => !f.client.get(thread));
    assert.equal(f.unavailable.length, 2);
    const followsBefore = f.messages.filter(
      (message) => message.params?.following === true,
    ).length;
    f.send({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      sourceClientId: "replacement-owner",
      version: 1,
      params: { conversationId: thread, hostId: "local" },
    });
    await until(
      () =>
        f.messages.filter((message) => message.params?.following === true)
          .length > followsBefore,
    );
  } finally {
    await f.close();
  }
});

test("owner changes and owner disconnects immediately invalidate pending actions", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [{ id: "request" }] });
    await until(() => !!f.client.get(thread));
    const pending = f.client.requestOwner(
      thread,
      "thread-follower-command-approval-decision",
      { requestId: "request", decision: "accept", conversationId: thread },
    );
    const rejected = assert.rejects(pending, /原窗口连接已失效/);
    f.snapshot({ requests: [] }, 1, "new-owner");
    await rejected;
    assert.equal(f.client.get(thread)?.ownerClientId, "new-owner");
    f.send({
      type: "broadcast",
      method: "client-status-changed",
      version: 0,
      sourceClientId: "new-owner",
      params: { clientId: "new-owner", status: "disconnected" },
    });
    await until(() => !f.client.get(thread));
    assert.equal(f.unavailable.length, 2);
  } finally {
    await f.close();
  }
});

test("explicit confirmation actions route to the current owner and preserve response errors", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [{ id: "rpc-request" }] }, 1, "actual-owner");
    await until(() => !!f.client.get(thread));
    const params = {
      conversationId: thread,
      requestId: "rpc-request",
      decision: "decline",
    };
    const action = f.client.requestOwner(
      thread,
      "thread-follower-command-approval-decision",
      params,
    );
    await until(() =>
      f.messages.some(
        (message) =>
          message.method === "thread-follower-command-approval-decision",
      ),
    );
    const request = f.messages.at(-1);
    assert.equal(request.targetClientId, "actual-owner");
    assert.equal(request.version, 1);
    assert.equal(Object.hasOwn(request, "hostId"), false);
    assert.deepEqual(request.params, params);
    const result = { method: request.method, result: { ok: true } };
    f.send({
      type: "response",
      requestId: request.requestId,
      resultType: "success",
      method: request.method,
      handledByClientId: "actual-owner",
      result,
    });
    assert.deepEqual(await action, result);
    assert.equal(
      f.client.get(thread)?.state.requests.length,
      1,
      "routing ACK must not remove a pending request",
    );
    const invalid = f.client.requestOwner(
      thread,
      "thread-follower-submit-user-input",
      {
        conversationId: thread,
        requestId: "rpc-request",
        response: { answers: {} },
      },
    );
    const rejected = assert.rejects(invalid, /request-expired/);
    await until(() =>
      f.messages.some(
        (message) => message.method === "thread-follower-submit-user-input",
      ),
    );
    f.send({
      type: "response",
      requestId: f.messages.at(-1).requestId,
      resultType: "error",
      error: "request-expired",
    });
    await rejected;
    await assert.rejects(
      f.client.requestOwner(thread, "thread-follower-run-command", {}),
      /暂不支持/,
    );
  } finally {
    await f.close();
  }
});

test("async answers route start and steer to the original owner with their native protocol versions", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [], threadRuntimeStatus: { type: "idle" } });
    await until(() => !!f.client.get(thread));
    for (const [method, version] of [
      ["thread-follower-start-turn", 2],
      ["thread-follower-steer-turn", 1],
    ] as const) {
      const params = { conversationId: thread, input: [] };
      const action = f.client.requestOwner(thread, method, params);
      await until(() =>
        f.messages.some((message) => message.method === method),
      );
      const request = f.messages.find((message) => message.method === method);
      assert.equal(request.targetClientId, owner);
      assert.equal(request.version, version);
      assert.deepEqual(request.params, params);
      f.send({
        type: "response",
        requestId: request.requestId,
        resultType: "success",
        result: { ok: true },
      });
      assert.deepEqual(await action, { ok: true });
    }
  } finally {
    await f.close();
  }
});

test("transport reconnection clears old state and renews client identity and subscriptions", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [{ id: "old-connection" }] });
    await until(() => !!f.client.get(thread));
    f.sockets[0].destroy();
    await until(() =>
      f.connectionStates.some((value) => value.state === "disconnected"),
    );
    assert.equal(f.client.get(thread), undefined);
    await until(() =>
      f.messages.some((message) => message.sourceClientId === "observer-2"),
    );
    const following = f.messages.find(
      (message) => message.sourceClientId === "observer-2",
    );
    assert.equal(following.params.following, true);
    f.snapshot(
      { requests: [], threadRuntimeStatus: { type: "idle" } },
      1,
      "new-window",
    );
    await until(() => f.client.get(thread)?.ownerClientId === "new-window");
  } finally {
    await f.close();
  }
});

test("watch differences and stop release subscriptions without acquiring ownership", async () => {
  const f = await fixture();
  try {
    await f.ready([thread, "other"]);
    f.snapshot({ requests: [] });
    await until(() => !!f.client.get(thread));
    f.client.watch(["other"]);
    await until(() =>
      f.messages.some(
        (message) =>
          message.params?.conversationId === thread &&
          message.params.following === false,
      ),
    );
    assert.equal(f.client.get(thread), undefined);
    f.client.watch(["other"]);
    assert.equal(
      f.messages.filter(
        (message) =>
          message.params?.conversationId === "other" &&
          message.params.following === true,
      ).length,
      1,
    );
    f.client.stop();
    await until(() =>
      f.messages.some(
        (message) =>
          message.params?.conversationId === "other" &&
          message.params.following === false,
      ),
    );
    assert.equal(
      f.messages
        .filter((message) => message.type === "request")
        .every((message) => message.method === "initialize"),
      true,
    );
  } finally {
    await f.close();
  }
});

test("incompatible state versions fail visibly instead of presenting stale state", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.snapshot({ requests: [] });
    await until(() => !!f.client.get(thread));
    f.send({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 12,
      sourceClientId: owner,
      params: {
        conversationId: thread,
        hostId: "local",
        change: { type: "snapshot", revision: 2, conversationState: {} },
      },
    });
    await until(() =>
      f.connectionStates.some((value) => value.message?.includes("协议不兼容")),
    );
    assert.equal(f.client.get(thread), undefined);
  } finally {
    await f.close();
  }
});
