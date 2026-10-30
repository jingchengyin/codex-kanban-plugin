import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** 同版本重装时，新页面必须获得新地址；相同页面则沿用地址。 */
test("UI resources invalidate cached HTML after a same-version reinstall", async () => {
  const home = await mkdtemp(join(tmpdir(), "kanban-resource-cache-test-"));
  const plugin = join(home, "installed plugin");
  await cp(resolve("plugins/codex-kanban-plugin"), plugin, { recursive: true });
  const page = join(plugin, "runtime/ui/index.html");
  async function inspect(html: string) {
    await writeFile(page, html);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(plugin, "runtime/server/index.mjs")],
      cwd: home,
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        CODEX_HOME: home,
        TASKBOARD_WS_URL: "ws://127.0.0.1:1",
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "resource-cache-regression",
      version: "1",
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      const uri = (
        tools.find((tool) => tool.name === "taskboard_open")?._meta?.ui as {
          resourceUri: string;
        }
      ).resourceUri;
      const listed = (await client.listResources()).resources;
      assert.ok(listed.some((resource) => resource.uri === uri));
      for (const tool of tools)
        assert.equal(
          (tool._meta?.ui as { resourceUri: string }).resourceUri,
          uri,
        );
      const result = await client.readResource({ uri });
      assert.ok("text" in result.contents[0]);
      assert.equal(result.contents[0].text, html);
      return uri;
    } finally {
      await client.close();
    }
  }
  try {
    const old = await inspect("<main>旧版事项，没有图标选择</main>");
    const updated = await inspect("<main>新版事项，支持图标选择</main>");
    const repeated = await inspect("<main>新版事项，支持图标选择</main>");
    assert.notEqual(old, updated);
    assert.equal(updated, repeated);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
