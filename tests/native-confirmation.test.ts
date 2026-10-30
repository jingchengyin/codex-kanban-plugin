import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  readConfirmations,
  replyToConfirmation,
} from "../server/confirmations";

const cli =
  process.env.TASKBOARD_CODEX_CLI ??
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

for (const packaged of [false, true]) {
  test(
    `${packaged ? "packaged" : "source"} desktop forwards a board decision to a real native approval and completes the turn`,
    { timeout: 20000 },
    async (t) => {
      if (process.platform !== "darwin") return t.skip("macOS desktop runtime");
      try {
        await access(cli);
      } catch {
        return t.skip("bundled CLI unavailable");
      }
      const home = await mkdtemp(join(tmpdir(), "kanban-native-approval-"));
      let calls = 0;
      // 模型响应由本机固定样本提供，测试不调用外部模型或真实用户对话。
      const model = createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* 消费完整请求。 */
        }
        const output =
          ++calls === 1
            ? {
                id: "fc_1",
                type: "function_call",
                call_id: "call_1",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: "printf 'isolated-confirmation-test'",
                  sandbox_permissions: "require_escalated",
                  justification: "Allow the isolated printf verification?",
                }),
              }
            : {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Verified." }],
              };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: {
              id: `resp_${calls}`,
              status: "in_progress",
              output: [],
            },
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
      await new Promise<void>((ok) => model.listen(0, "127.0.0.1", ok));
      const modelPort = (model.address() as net.AddressInfo).port;
      await writeFile(
        join(home, "config.toml"),
        `model='fixture'\nmodel_provider='fixture'\n[model_providers.fixture]\nname='fixture'\nbase_url='http://127.0.0.1:${modelPort}'\nwire_api='responses'\nrequires_openai_auth=false\n`,
      );
      // 避开系统临时端口，防止模型连接抢占紧邻的确认端口。
      let port = 24000;
      for (; ; port += 2) {
        const reservations = [net.createServer(), net.createServer()];
        try {
          for (const [index, server] of reservations.entries())
            await new Promise<void>((ok, fail) => {
              server.once("error", fail);
              server.listen(port + index, "127.0.0.1", ok);
            });
          break;
        } catch {
          assert.ok(port < 25000, "No isolated test port pair available");
        } finally {
          await Promise.all(
            reservations
              .filter((server) => server.listening)
              .map(
                (server) => new Promise<void>((ok) => server.close(() => ok())),
              ),
          );
        }
      }
      const endpoint = `ws://127.0.0.1:${port}`;
      const script = resolve(
        packaged
          ? "plugins/codex-kanban-plugin/scripts/desktop-cli.mjs"
          : "scripts/desktop-cli.mjs",
      );
      const child = spawn(process.execPath, [script, "app-server"], {
        env: {
          ...process.env,
          CODEX_HOME: home,
          TASKBOARD_CODEX_CLI: cli,
          TASKBOARD_WS_URL: endpoint,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finished = once(child, "exit");
      let diagnostics = "";
      child.stderr.on("data", (c) => {
        diagnostics = (diagnostics + c).slice(-3000);
      });
      const messages: any[] = [];
      const pending = new Map<
        number,
        {
          ok: (v: any) => void;
          fail: (e: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      let sequence = 0;
      createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        messages.push(message);
        const waiter = pending.get(message.id);
        if (!waiter || message.method) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error)
          waiter.fail(new Error(JSON.stringify(message.error)));
        else waiter.ok(message.result);
      });
      const request = (method: string, params: object) =>
        new Promise<any>((ok, fail) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`${method} timed out: ${diagnostics}`));
          }, 8000);
          pending.set(id, { ok, fail, timer });
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
      const until = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 8000;
        while (!(await check())) {
          assert.ok(Date.now() < deadline, diagnostics);
          await new Promise((ok) => setTimeout(ok, 30));
        }
      };
      try {
        await request("initialize", {
          clientInfo: { name: "isolated_confirmation_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const { thread } = await request("thread/start", {
          ephemeral: true,
          cwd: home,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
        });
        await request("turn/start", {
          threadId: thread.id,
          input: [
            { type: "text", text: "Run the isolated printf verification." },
          ],
        });
        await until(
          async () => (await readConfirmations(endpoint)).requests.length === 1,
        );
        const [confirmation] = (await readConfirmations(endpoint)).requests;
        assert.match(
          confirmation.command!,
          /printf 'isolated-confirmation-test'/,
        );
        assert.equal(confirmation.threadId, thread.id);
        assert.equal(
          messages.some((m) => m.method === "turn/completed"),
          false,
        );
        await replyToConfirmation(endpoint, {
          id: confirmation.id,
          threadId: thread.id,
          decision: "accept",
        });
        await until(async () =>
          messages.some((m) => m.method === "turn/completed"),
        );
        assert.ok(messages.some((m) => m.method === "serverRequest/resolved"));
        assert.ok(
          messages.some(
            (m) =>
              m.method === "item/completed" &&
              m.params.item.type === "commandExecution" &&
              m.params.item.aggregatedOutput === "isolated-confirmation-test",
          ),
        );
        assert.equal(
          messages.find((m) => m.method === "turn/completed").params.turn
            .status,
          "completed",
        );
        assert.deepEqual((await readConfirmations(endpoint)).requests, []);
      } finally {
        for (const p of pending.values()) clearTimeout(p.timer);
        child.stdin.end();
        if (child.exitCode === null) {
          const force = setTimeout(() => child.kill("SIGTERM"), 3000);
          await finished;
          clearTimeout(force);
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await new Promise<void>((ok) => {
          model.close(() => ok());
          model.closeAllConnections();
        });
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
