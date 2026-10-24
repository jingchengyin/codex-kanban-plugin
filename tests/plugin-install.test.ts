import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

test(
  "native Codex installs the marketplace and loads the packaged MCP tools",
  { timeout: 45000 },
  async (t) => {
    const cli =
      process.env.TASKBOARD_CODEX_CLI ??
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    try {
      await access(cli);
    } catch {
      t.skip("The desktop Codex CLI is not installed on this machine.");
      return;
    }
    const temp = await mkdtemp(join(tmpdir(), "taskboard-plugin-install-"));
    const codexHome = join(temp, "codex");
    await mkdir(codexHome);
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: codexHome,
      TASKBOARD_WS_URL: "ws://127.0.0.1:1",
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    };
    let child: ReturnType<typeof spawn> | undefined;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    try {
      const run = (args: string[]) =>
        JSON.parse(
          execFileSync(cli, args, {
            env,
            cwd: temp,
            encoding: "utf8",
            timeout: 20000,
          }),
        );
      const marketplace = run([
        "plugin",
        "marketplace",
        "add",
        process.env.TASKBOARD_TEST_MARKETPLACE_SOURCE ?? resolve("."),
        "--json",
      ]);
      assert.equal(marketplace.marketplaceName, "codex-kanban-plugin");
      const installed = run([
        "plugin",
        "add",
        "codex-taskboard@codex-kanban-plugin",
        "--json",
      ]);
      assert.ok(installed.installedPath.startsWith(await realpath(codexHome)));

      child = spawn(cli, ["app-server"], {
        env,
        cwd: temp,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let diagnostics = "";
      child.stderr!.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-4000);
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const message = JSON.parse(line);
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error)
          request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      });
      let id = 0;
      const request = (method: string, params: object) =>
        new Promise<any>((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(
            () => reject(new Error(`Timed out: ${method}\n${diagnostics}`)),
            10000,
          );
          pending.set(requestId, { resolve, reject, timer });
          child!.stdin!.write(
            JSON.stringify({ id: requestId, method, params }) + "\n",
          );
        });
      await request("initialize", {
        clientInfo: { name: "taskboard_release_check", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
      const result = await request("mcpServerStatus/list", {
        limit: 100,
        detail: "full",
      });
      const server = result.data.find(
        (entry: any) => entry.name === "codex-taskboard",
      );
      assert.ok(server, "The installed plugin must register its MCP server.");
      assert.equal(server.toolsError, null);
      assert.deepEqual(Object.keys(server.tools).sort(), [
        "taskboard_open",
        "taskboard_panel",
        "taskboard_snapshot",
      ]);
      assert.ok(
        server.resources.some(
          (resource: any) => resource.uri === "ui://codex-taskboard/board",
        ),
      );
    } finally {
      for (const request of pending.values()) clearTimeout(request.timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.stdin!.end();
        const timer = setTimeout(() => child!.kill("SIGTERM"), 1500);
        await exited;
        clearTimeout(timer);
      }
      await rm(temp, { recursive: true, force: true });
    }
  },
);
