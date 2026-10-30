import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net, { type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusBridge } from "../server/status-bridge";

const cli =
  process.env.TASKBOARD_CODEX_CLI ??
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** 按桌面原协议封装消息，仅用于本测试的临时 Unix socket。 */
function frame(message: object) {
  const body = Buffer.from(JSON.stringify(message));
  const bytes = Buffer.alloc(body.length + 4);
  bytes.writeUInt32LE(body.length);
  body.copy(bytes, 4);
  return bytes;
}

test(
  "native IPC board confirmation reaches the original App Server request and completes the isolated turn",
  { timeout: 20000 },
  async (t) => {
    if (process.platform !== "darwin") return t.skip("macOS desktop runtime");
    try {
      await access(cli);
    } catch {
      return t.skip("bundled CLI unavailable");
    }
    const home = await mkdtemp(join(tmpdir(), "ipc-confirm-"));
    await mkdir(join(home, "ipc"));
    let calls = 0;
    // 模型只返回固定样本，真实后端和命令均在本次临时目录运行。
    const model = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* 消费完整请求，不连接外部模型。 */
      }
      const output =
        ++calls === 1
          ? {
              id: "fc_ipc",
              type: "function_call",
              call_id: "call_ipc",
              name: "exec_command",
              arguments: JSON.stringify({
                cmd: "printf 'isolated-ipc-confirmation'",
                sandbox_permissions: "require_escalated",
                justification: "Allow this isolated printf test?",
              }),
            }
          : {
              id: "msg_ipc",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Verified." }],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `resp_${calls}`, status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: output },
        { type: "response.output_item.done", output_index: 0, item: output },
        {
          type: "response.completed",
          response: {
            id: `resp_${calls}`,
            status: "completed",
            output: [output],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const modelPort = (model.address() as net.AddressInfo).port;
    await writeFile(
      join(home, "config.toml"),
      `model='fixture'\nmodel_provider='fixture'\n[model_providers.fixture]\nname='fixture'\nbase_url='http://127.0.0.1:${modelPort}'\nwire_api='responses'\nrequires_openai_auth=false\n`,
    );
    const child = spawn(cli, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finished = once(child, "exit");
    const messages: any[] = [];
    const ipcActions: any[] = [];
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-3000);
    });
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let sequence = 0;
    let threadId: string | undefined;
    let revision = 0;
    const ownerClientId = "isolated-desktop-owner";
    const sockets = new Set<Socket>();
    const followers = new Set<Socket>();
    const state: any = {
      title: "Isolated IPC approval",
      cwd: home,
      source: "vscode",
      updatedAt: Date.now() / 1000,
      threadRuntimeStatus: { type: "idle" },
      requests: [],
      turns: [],
    };
    /** 模拟 owner 的增量广播，只转发真实 App Server 已发生的状态变化。 */
    const publish = (patches: object[]) => {
      const baseRevision = revision++;
      for (const socket of followers)
        if (socket.writable)
          socket.write(
            frame({
              type: "broadcast",
              method: "thread-stream-state-changed",
              version: 11,
              sourceClientId: ownerClientId,
              params: {
                conversationId: threadId,
                hostId: "local",
                change: { type: "patches", baseRevision, revision, patches },
              },
            }),
          );
    };
    const removeRequest = (requestId?: string | number) => {
      state.requests =
        requestId === undefined
          ? []
          : state.requests.filter((request: any) => request.id !== requestId);
      publish([{ op: "replace", path: ["requests"], value: state.requests }]);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      const waiter = pending.get(message.id);
      if (waiter && !message.method) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
      if (message.params?.threadId !== threadId || !threadId) return;
      if (message.method === "thread/status/changed") {
        state.threadRuntimeStatus = message.params.status;
        publish([
          {
            op: "replace",
            path: ["threadRuntimeStatus"],
            value: state.threadRuntimeStatus,
          },
        ]);
      }
      if (message.method === "item/commandExecution/requestApproval") {
        state.requests.push(message);
        publish([{ op: "replace", path: ["requests"], value: state.requests }]);
      }
      if (message.method === "serverRequest/resolved")
        removeRequest(message.params.requestId);
      if (message.method === "turn/completed") removeRequest();
    });
    const request = (method: string, params: object) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out: ${diagnostics}`));
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    const until = async (check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8000;
      while (!(await check())) {
        assert.ok(
          Date.now() < deadline,
          `Isolated native IPC test timed out: ${diagnostics}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    // 路由器只接受本测试的观察者，确认仍由持有原 stdio 的模拟 owner 回传。
    const router = net.createServer((socket) => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE();
          if (buffer.length < size + 4) return;
          const message = JSON.parse(buffer.subarray(4, size + 4).toString());
          buffer = buffer.subarray(size + 4);
          if (message.method === "initialize")
            socket.write(
              frame({
                type: "response",
                requestId: message.requestId,
                resultType: "success",
                method: "initialize",
                result: { clientId: "isolated-board-observer" },
              }),
            );
          else if (message.method === "thread-stream-following-changed") {
            assert.equal(message.params.conversationId, threadId);
            if (!message.params.following) {
              followers.delete(socket);
              continue;
            }
            followers.add(socket);
            socket.write(
              frame({
                type: "broadcast",
                method: "thread-stream-state-changed",
                version: 11,
                sourceClientId: ownerClientId,
                params: {
                  conversationId: threadId,
                  hostId: "local",
                  change: {
                    type: "snapshot",
                    revision,
                    conversationState: state,
                  },
                },
              }),
            );
          } else if (
            message.method === "thread-follower-command-approval-decision"
          ) {
            ipcActions.push(message);
            assert.equal(message.targetClientId, ownerClientId);
            assert.equal(message.params.conversationId, threadId);
            assert.equal(message.version, 1);
            const raw = state.requests.find(
              (entry: any) => entry.id === message.params.requestId,
            );
            assert.ok(
              raw,
              "The original App Server request must still be pending",
            );
            child.stdin.write(
              JSON.stringify({
                id: raw.id,
                result: { decision: message.params.decision },
              }) + "\n",
            );
            socket.write(
              frame({
                type: "response",
                requestId: message.requestId,
                resultType: "success",
                method: message.method,
                handledByClientId: ownerClientId,
                result: { method: message.method, result: { ok: true } },
              }),
            );
          }
        }
      });
      socket.on("close", () => {
        sockets.delete(socket);
        followers.delete(socket);
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      router.once("error", reject);
      router.listen(join(home, "ipc", "ipc.sock"), resolve);
    });
    const previousEndpoint = process.env.TASKBOARD_WS_URL;
    delete process.env.TASKBOARD_WS_URL;
    const bridge = new StatusBridge({ home });
    try {
      await request("initialize", {
        clientInfo: { name: "isolated_native_ipc_fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const created = await request("thread/start", {
        ephemeral: true,
        cwd: home,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
      });
      threadId = created.thread.id;
      assert.ok(
        threadId,
        "The isolated App Server must create a real thread ID",
      );
      state.id = threadId;
      bridge.start();
      await until(async () =>
        (await bridge.snapshot(null, [threadId!])).threads.some(
          (thread) => thread.id === threadId && thread.fresh,
        ),
      );
      await request("turn/start", {
        threadId,
        input: [
          { type: "text", text: "Run the isolated printf verification." },
        ],
      });
      await until(
        async () =>
          (await bridge.snapshot(null, [threadId!])).confirmations?.requests
            .length === 1,
      );
      const [confirmation] = (await bridge.snapshot(null, [threadId]))
        .confirmations!.requests;
      assert.equal(confirmation.threadId, threadId);
      assert.match(confirmation.command!, /printf 'isolated-ipc-confirmation'/);
      assert.equal(
        messages.some((message) => message.method === "turn/completed"),
        false,
      );
      assert.equal(
        ipcActions.length,
        0,
        "Reading snapshots must never answer an approval",
      );
      const input = {
        id: confirmation.id,
        threadId,
        decision: "accept",
      } as const;
      assert.deepEqual(await bridge.replyToConfirmation(input), {
        submitted: true,
      });
      await until(() =>
        messages.some((message) => message.method === "turn/completed"),
      );
      assert.equal(ipcActions.length, 1);
      assert.ok(
        messages.some((message) => message.method === "serverRequest/resolved"),
      );
      assert.ok(
        messages.some(
          (message) =>
            message.method === "item/completed" &&
            message.params.item.type === "commandExecution" &&
            message.params.item.aggregatedOutput ===
              "isolated-ipc-confirmation",
        ),
      );
      assert.equal(
        messages.find((message) => message.method === "turn/completed").params
          .turn.status,
        "completed",
      );
      assert.deepEqual(
        (await bridge.snapshot(null, [threadId])).confirmations!.requests,
        [],
      );
      await assert.rejects(bridge.replyToConfirmation(input), /已处理或已失效/);
      assert.equal(
        ipcActions.length,
        1,
        "The old board UUID must not send a second decision",
      );
    } finally {
      bridge.stop();
      if (previousEndpoint === undefined) delete process.env.TASKBOARD_WS_URL;
      else process.env.TASKBOARD_WS_URL = previousEndpoint;
      for (const value of pending.values()) clearTimeout(value.timer);
      child.stdin.end();
      if (child.exitCode === null) {
        const force = setTimeout(() => child.kill("SIGTERM"), 3000);
        await finished;
        clearTimeout(force);
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => router.close(() => resolve()));
      await new Promise<void>((resolve) => {
        model.close(() => resolve());
        model.closeAllConnections();
      });
      await rm(home, { recursive: true, force: true });
    }
  },
);
