import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const packaged of [false, true]) {
  test(`${packaged ? "isolated GitHub distribution" : "built plugin"} exposes sidebar/panel metadata, inline self-contained HTML, and read-only snapshots over real MCP stdio`, async () => {
    const home = await mkdtemp(join(tmpdir(), "taskboard-mcp-"));
    let command = process.execPath;
    let args = [resolve("dist/server/index.js")];
    if (packaged) {
      const plugin = join(home, "installed plugin with spaces");
      await cp(resolve("plugins/codex-taskboard"), plugin, { recursive: true });
      const config = JSON.parse(
        await readFile(join(plugin, ".mcp.json"), "utf8"),
      );
      command = config.mcpServers["codex-taskboard"].command;
      args = config.mcpServers["codex-taskboard"].args.map((arg: string) =>
        resolve(plugin, arg),
      );
    }
    // Keep the unavailable test endpoint reserved; never observe a user's backend.
    const unavailable = net.createServer((socket) => socket.destroy());
    await new Promise<void>((ok, fail) => {
      unavailable.once("error", fail);
      unavailable.listen(0, "127.0.0.1", ok);
    });
    const port = (unavailable.address() as net.AddressInfo).port;
    const transport = new StdioClientTransport({
      command,
      args,
      cwd: home,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        CODEX_HOME: home,
        TASKBOARD_WS_URL: `ws://127.0.0.1:${port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "taskboard-test", version: "1" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 3);
      assert.deepEqual(
        (
          tools.find((tool) => tool.name === "taskboard_open")?._meta?.[
            "openai/ui"
          ] as any
        ).entrypoints,
        [{ type: "global" }],
      );
      assert.deepEqual(
        (
          tools.find((tool) => tool.name === "taskboard_panel")?._meta?.[
            "openai/ui"
          ] as any
        ).entrypoints,
        [{ type: "thread" }],
      );
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
      const resource = await client.readResource({
        uri: "ui://codex-taskboard/board",
      });
      assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
      assert.ok("text" in resource.contents[0]);
      const html = resource.contents[0].text as string;
      assert.match(html, /npm run codex-kanban-plugin/);
      assert.match(html, /<script\b[^>]*type="module"[^>]*>/);
      assert.equal(
        /<script[^>]+src=|<link[^>]+rel="stylesheet"/.test(html),
        false,
      );
      const result = await client.callTool({
        name: "taskboard_snapshot",
        arguments: {},
      });
      const snapshot = result.structuredContent as any;
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.sources.metadata, false);
      assert.deepEqual(snapshot.threads, []);
    } finally {
      await client.close();
      await new Promise<void>((ok) => unavailable.close(() => ok()));
      await rm(home, { recursive: true });
    }
  });
}
