import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

// 只读研究工具：订阅现有桌面对话，结束后退订，不处理确认请求。
const target = process.argv[2] ?? process.env.CODEX_THREAD_ID;
const output = process.argv[3] ?? "/tmp/kanban-desktop-ipc-probe.json";
if (!target) throw new Error("A real caller thread ID is required");
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const address = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "ipc",
  "ipc.sock",
);
const report = {
  checkedAt: new Date().toISOString(),
  targetHash: digest(target),
  transport: "existing desktop IPC observer subscription",
  initialized: false,
  snapshotReceived: false,
  snapshots: [],
  broadcasts: {},
  patchCount: 0,
  patchRevisions: [],
  patchPaths: [],
  sentMethods: [],
};
const socket = net.createConnection(address);
let buffer = Buffer.alloc(0);
let clientId = "initializing-client";
let subscribed = false;
let finished = false;
let afterSnapshot;
const initRequest = randomUUID();

/** 按桌面客户端原有的长度帧协议发送观察订阅。 */
function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length);
  payload.copy(frame, 4);
  socket.write(frame);
  if (message.method) report.sentMethods.push(message.method);
}

/** 只保存结构摘要，丢弃对话正文、命令、文件差异和原始请求 ID。 */
function receive(message) {
  if (message.type === "client-discovery-request") {
    send({
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false },
    });
    return;
  }
  if (message.type === "response" && message.requestId === initRequest) {
    report.initialized = message.resultType === "success";
    clientId = message.result?.clientId;
    if (!clientId) return;
    subscribed = true;
    send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: clientId,
      version: 1,
      params: { conversationId: target, hostId: "local", following: true },
    });
    return;
  }
  if (message.type !== "broadcast") return;
  report.broadcasts[message.method] =
    (report.broadcasts[message.method] ?? 0) + 1;
  if (
    message.method !== "thread-stream-state-changed" ||
    message.params?.conversationId !== target
  )
    return;
  const change = message.params.change;
  if (change?.type === "snapshot") {
    const state = change.conversationState ?? {};
    report.snapshotReceived = true;
    report.snapshots.push({
      version: message.version,
      revision: change.revision,
      stateKeys: Object.keys(state),
      runtimeStatus: state.threadRuntimeStatus?.type ?? null,
      resumeState: state.resumeState ?? null,
      requestCount: state.requests?.length ?? 0,
      requests: (state.requests ?? []).map((request) => ({
        method: request.method,
        requestHash: digest(request.id),
        paramKeys: Object.keys(request.params ?? {}),
      })),
    });
    afterSnapshot ??= setTimeout(
      () =>
        finish(
          report.patchCount
            ? "snapshot_and_patches_observed"
            : "snapshot_observed",
        ),
      12000,
    );
  } else if (change?.type === "patches") {
    report.patchCount += 1;
    report.patchRevisions.push({
      version: message.version,
      baseRevision: change.baseRevision,
      revision: change.revision,
    });
    for (const patch of change.patches ?? []) {
      const path = (patch.path ?? []).slice(0, 2).map(String).join(".");
      if (!report.patchPaths.includes(path)) report.patchPaths.push(path);
    }
  }
}

/** 退出观察时解除订阅；不发送任何审批、用户回答或回合操作。 */
async function finish(reason) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(afterSnapshot);
  if (subscribed && !socket.destroyed) {
    send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: clientId,
      version: 1,
      params: { conversationId: target, hostId: "local", following: false },
    });
  }
  report.result = reason;
  if (!report.snapshotReceived) process.exitCode = 1;
  socket.end();
  const cleanup = setTimeout(() => socket.destroy(), 200);
  cleanup.unref();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

socket.on("connect", () =>
  send({
    type: "request",
    requestId: initRequest,
    sourceClientId: clientId,
    version: 0,
    method: "initialize",
    params: { clientType: "kanban-readonly-probe" },
  }),
);
socket.on("data", (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE();
    if (buffer.length < length + 4) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length));
    buffer = buffer.subarray(4 + length);
    receive(message);
  }
});
socket.on("error", (error) => {
  report.error = { code: error.code, message: error.message };
  void finish("connection_failed");
});
const deadline = setTimeout(
  () =>
    finish(
      report.snapshotReceived
        ? report.patchCount
          ? "snapshot_and_patches_observed"
          : "snapshot_observed"
        : "no_snapshot_within_20_seconds",
    ),
  20000,
);
