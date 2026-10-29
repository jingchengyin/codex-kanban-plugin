import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const cli =
  process.env.TASKBOARD_CODEX_CLI ??
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const wrapper = resolve("scripts/start-desktop-cli.sh");

for (const packaged of [false, true]) {
  const bootstrapWrapper = packaged
    ? resolve("plugins/codex-kanban-plugin/scripts/start-desktop-cli.sh")
    : wrapper;
  test(
    `${packaged ? "packaged" : "source"} desktop bootstrap keeps automation discovery, tool calls, shared status and backend cleanup`,
    { timeout: 40000 },
    async (t) => {
      if (process.platform !== "darwin") return t.skip("macOS launcher");
      const appTools =
        "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools";
      try {
        await access(cli);
        await access(appTools);
      } catch {
        return t.skip("bundled Codex CLI and app tools not installed");
      }
      const root = await mkdtemp(
        join(tmpdir(), "taskboard-desktop-bootstrap-"),
      );
      const home = join(root, "home");
      const marketplace = join(root, "marketplace");
      const nativeSockets = new Set<net.Socket>();
      const requests: any[] = [];
      const native = net.createServer((socket) => {
        nativeSockets.add(socket);
        socket.once("close", () => nativeSockets.delete(socket));
        let buffer = Buffer.alloc(0);
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);
          while (
            buffer.length >= 4 &&
            buffer.length >= 4 + buffer.readUInt32LE(0)
          ) {
            const length = buffer.readUInt32LE(0);
            const message = JSON.parse(
              buffer.subarray(4, length + 4).toString(),
            );
            buffer = buffer.subarray(length + 4);
            requests.push(message);
            // 使用隔离管道验证工具调用链，不读取或修改真实定时任务。
            const result =
              message.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "automation_update",
                        namespace: "codex_app",
                        description: "Isolated automation fixture",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  }
                : {
                    contentItems: [
                      {
                        type: "inputText",
                        text: "isolated automation call succeeded",
                      },
                    ],
                    success: true,
                  };
            const body = Buffer.from(
              JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
            );
            const header = Buffer.alloc(4);
            header.writeUInt32LE(body.length);
            socket.write(Buffer.concat([header, body]));
          }
        });
      });
      let child: ReturnType<typeof spawn> | undefined;
      let observer: WebSocket | undefined;
      let finished: Promise<any> | undefined;
      const pending = new Map<
        string,
        {
          resolve: (value: any) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      try {
        await mkdir(home);
        await mkdir(join(marketplace, ".agents/plugins"), { recursive: true });
        await cp(appTools, join(marketplace, "plugins/codex-app-tools"), {
          recursive: true,
        });
        await writeFile(
          join(marketplace, ".agents/plugins/marketplace.json"),
          JSON.stringify({
            name: "taskboard-bootstrap-fixture",
            plugins: [
              {
                name: "codex-app-tools",
                source: { source: "local", path: "./plugins/codex-app-tools" },
              },
            ],
          }),
        );
        const pipe = join(root, "test-tools.sock");
        native.listen(pipe);
        await once(native, "listening");
        const portServer = net.createServer();
        portServer.listen(0, "127.0.0.1");
        await once(portServer, "listening");
        const port = (portServer.address() as net.AddressInfo).port;
        await new Promise<void>((ok) => portServer.close(() => ok()));
        const endpoint = `ws://127.0.0.1:${port}`;
        const env = {
          HOME: home,
          CODEX_HOME: home,
          PATH: process.env.PATH,
          CODEX_MCP_NODE_PATH: process.execPath,
          TASKBOARD_CODEX_CLI: cli,
          TASKBOARD_WS_URL: endpoint,
          CODEX_APP_TOOLS_PIPE_PATH: pipe,
        };
        for (const args of [
          ["plugin", "marketplace", "add", marketplace, "--json"],
          [
            "plugin",
            "add",
            "codex-app-tools@taskboard-bootstrap-fixture",
            "--json",
          ],
        ])
          execFileSync(cli, args, { env, cwd: root, timeout: 20000 });
        // 真实桌面端传入的启用配置必须经转发器完整保留。
        child = spawn(
          "/bin/sh",
          [
            bootstrapWrapper,
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "-c",
            "plugins.codex-app-tools@taskboard-bootstrap-fixture.mcp_servers.codex_app.enabled=true",
          ],
          {
            env,
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        finished = once(child, "exit");
        let diagnostics = "";
        child.stderr!.on("data", (data) => {
          diagnostics = (diagnostics + data).slice(-3000);
        });
        createInterface({ input: child.stdout! }).on("line", (line) => {
          const message = JSON.parse(line);
          const waiter = pending.get(message.id);
          if (!waiter || message.method) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error)
            waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        });
        let sequence = 0;
        const request = (method: string, params: object) =>
          new Promise<any>((resolve, reject) => {
            const id = `desktop-request-${++sequence}`;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error(`${method} timed out\n${diagnostics}`));
            }, 15000);
            pending.set(id, { resolve, reject, timer });
            child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
          });
        await request("initialize", {
          clientInfo: { name: "isolated_desktop_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
        const status = await request("mcpServerStatus/list", {
          limit: 100,
          detail: "full",
        });
        const tools = status.data.find((server: any) =>
          server.name.includes("codex_app"),
        );
        assert.ok(tools, diagnostics);
        assert.equal(tools.toolsError, null, diagnostics);
        assert.ok(Object.keys(tools.tools).includes("automation_update"));
        const thread = await request("thread/start", { cwd: root });
        const called = await request("mcpServer/tool/call", {
          server: tools.name,
          tool: "automation_update",
          threadId: thread.thread.id,
          arguments: {},
        });
        assert.match(
          JSON.stringify(called),
          /isolated automation call succeeded/,
        );
        assert.ok(requests.some((message) => message.method === "tools/call"));
        observer = new WebSocket(endpoint);
        await new Promise<void>((ok, fail) => {
          observer!.addEventListener("open", () => ok(), { once: true });
          observer!.addEventListener(
            "error",
            () => fail(new Error("observer connect failed")),
            { once: true },
          );
        });
        const observe = (id: string, method: string, params: object) =>
          new Promise<any>((ok, fail) => {
            const timer = setTimeout(() => {
              observer!.removeEventListener("message", listener);
              fail(new Error("observer timeout"));
            }, 5000);
            const listener = (event: MessageEvent) => {
              const message = JSON.parse(String(event.data));
              if (message.id !== id || message.method) return;
              clearTimeout(timer);
              observer!.removeEventListener("message", listener);
              if (message.error) fail(new Error(JSON.stringify(message.error)));
              else ok(message.result);
            };
            observer!.addEventListener("message", listener);
            observer!.send(JSON.stringify({ id, method, params }));
          });
        await observe("observer-init", "initialize", {
          clientInfo: { name: "isolated_board_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        });
        observer.send(JSON.stringify({ method: "initialized" }));
        const loaded = await observe(
          "observer-loaded",
          "thread/loaded/list",
          {},
        );
        assert.ok(
          loaded.data.includes(thread.thread.id),
          "board and desktop must see the same live backend",
        );
        const closed = new Promise<void>((ok) =>
          observer!.addEventListener("close", () => ok(), { once: true }),
        );
        child.stdin!.end();
        assert.equal((await finished)[0], 0, diagnostics);
        await closed;
        assert.throws(() =>
          execFileSync("/usr/sbin/lsof", [
            "-nP",
            "-t",
            `-iTCP:${port}`,
            "-sTCP:LISTEN",
          ]),
        );
      } finally {
        for (const waiter of pending.values()) clearTimeout(waiter.timer);
        observer?.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          child.stdin!.end();
          child.kill("SIGTERM");
          await finished;
        }
        for (const socket of nativeSockets) socket.destroy();
        if (native.listening)
          await new Promise<void>((ok) => native.close(() => ok()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("desktop CLI version and startup config inspection bypass the live transport", async (t) => {
  try {
    await access(cli);
  } catch {
    return t.skip("Codex CLI not installed");
  }
  const home = await mkdtemp(join(tmpdir(), "taskboard-cli-inspection-"));
  const env = {
    ...process.env,
    CODEX_HOME: home,
    TASKBOARD_CODEX_CLI: cli,
    TASKBOARD_WS_URL: "invalid",
  };
  try {
    const version = execFileSync("/bin/sh", [wrapper, "--version"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.match(version, /codex/);
    const config = execFileSync(
      "/bin/sh",
      [wrapper, "app-server", "--print-startup-config"],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.ok(JSON.parse(config).appServerVersion);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "auxiliary desktop app servers keep their original stdio transport",
  { timeout: 15000 },
  async (t) => {
    try {
      await access(cli);
    } catch {
      return t.skip("Codex CLI not installed");
    }
    const home = await mkdtemp(join(tmpdir(), "taskboard-cli-auxiliary-"));
    const child = spawn("/bin/sh", [wrapper, "app-server"], {
      env: {
        ...process.env,
        CODEX_HOME: home,
        TASKBOARD_CODEX_CLI: cli,
        TASKBOARD_WS_URL: "invalid",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_latex_preview",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finished = once(child, "exit");
    child.stderr.resume();
    try {
      const response = new Promise<any>((ok) => {
        createInterface({ input: child.stdout }).once("line", (line) =>
          ok(JSON.parse(line)),
        );
      });
      child.stdin.write(
        JSON.stringify({
          id: "aux-init",
          method: "initialize",
          params: { clientInfo: { name: "auxiliary_fixture", version: "1" } },
        }) + "\n",
      );
      assert.equal((await response).id, "aux-init");
      child.stdin.end();
      assert.equal((await finished)[0], 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await finished;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);
