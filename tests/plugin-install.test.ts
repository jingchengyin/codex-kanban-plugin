import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

for (const desktopPath of [false, true]) {
  test(
    `native Codex installs and loads MCP tools with ${desktopPath ? "an old desktop Node and NVM fallback" : "the shell PATH"}`,
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
      const userHome = join(temp, "user home");
      let runtimePath = process.env.PATH;
      if (desktopPath) {
        const oldBin = join(temp, "old-system-bin");
        const nvmBin = join(
          userHome,
          ".nvm/versions/node",
          `v${process.versions.node}`,
          "bin",
        );
        await mkdir(oldBin, { recursive: true });
        await mkdir(nvmBin, { recursive: true });
        await writeFile(
          join(oldBin, "node"),
          "#!/bin/sh\nprintf 'Unsupported system Node\\n'\nexit 1\n",
          { mode: 0o700 },
        );
        await symlink(process.execPath, join(nvmBin, "node"));
        runtimePath = `${oldBin}:/usr/bin:/bin`;
      }
      const env = {
        PATH: runtimePath,
        HOME: desktopPath ? userHome : process.env.HOME,
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
        const marketplaceOverride =
          process.env.TASKBOARD_TEST_MARKETPLACE_SOURCE;
        const marketplaceSource =
          marketplaceOverride ?? join(temp, "marketplace");
        if (marketplaceOverride === undefined) {
          // 默认验证本次打包内容；显式指定来源时才使用远端市场。
          await mkdir(join(marketplaceSource, ".agents/plugins"), {
            recursive: true,
          });
          await cp(
            resolve("plugins/codex-kanban-plugin"),
            join(marketplaceSource, "plugins/codex-kanban-plugin"),
            { recursive: true },
          );
          await writeFile(
            join(marketplaceSource, ".agents/plugins/marketplace.json"),
            JSON.stringify({
              name: "codex-kanban-plugin",
              plugins: [
                {
                  name: "codex-kanban-plugin",
                  source: {
                    source: "local",
                    path: "./plugins/codex-kanban-plugin",
                  },
                },
              ],
            }) + "\n",
          );
        }
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
          marketplaceSource,
          "--json",
        ]);
        assert.equal(marketplace.marketplaceName, "codex-kanban-plugin");
        const installed = run([
          "plugin",
          "add",
          "codex-kanban-plugin@codex-kanban-plugin",
          "--json",
        ]);
        assert.ok(
          installed.installedPath.startsWith(await realpath(codexHome)),
        );

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
          "taskboard_artifact_rules",
          "taskboard_artifact_rules_save",
          "taskboard_confirmation_reply",
          "taskboard_live_launch",
          "taskboard_open",
          "taskboard_panel",
          "taskboard_snapshot",
          "taskboard_thread_artifacts",
          "taskboard_work_item_add_thread",
          "taskboard_work_item_delete",
          "taskboard_work_item_save",
          "taskboard_work_review",
          "taskboard_workspace",
        ]);
        assert.ok(
          server.resources.some((resource: any) =>
            /^ui:\/\/codex-taskboard\/board-[a-f0-9]{16}\.html$/.test(
              resource.uri,
            ),
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
}
