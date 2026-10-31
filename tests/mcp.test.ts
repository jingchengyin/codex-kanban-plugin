import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      await cp(resolve("plugins/codex-kanban-plugin"), plugin, {
        recursive: true,
      });
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
      const uri = (
        tools.find((tool) => tool.name === "taskboard_open")?._meta?.ui as any
      )?.resourceUri;
      assert.match(uri, /^ui:\/\/codex-taskboard\/board-[a-f0-9]{16}\.html$/);
      for (const tool of tools)
        assert.equal((tool._meta?.ui as any)?.resourceUri, uri);
      assert.equal(tools.length, 13);
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
      const writes = new Set([
        "taskboard_confirmation_reply",
        "taskboard_open",
        "taskboard_panel",
        "taskboard_work_item_save",
        "taskboard_work_item_add_thread",
        "taskboard_artifact_rules_save",
        "taskboard_work_item_delete",
        "taskboard_live_launch",
      ]);
      for (const tool of tools)
        assert.equal(tool.annotations?.readOnlyHint, !writes.has(tool.name));
      assert.ok(
        tools
          .filter(
            (tool) =>
              tool.name.startsWith("taskboard_work") ||
              tool.name === "taskboard_live_launch" ||
              tool.name === "taskboard_confirmation_reply" ||
              tool.name.startsWith("taskboard_artifact_rules"),
          )
          .every((tool) => (tool._meta?.ui as any)?.visibility?.[0] === "app"),
      );
      const rulesRead = await client.callTool({
        name: "taskboard_artifact_rules",
        arguments: {},
      });
      assert.deepEqual(rulesRead.structuredContent, { urlPrefixes: [] });
      const prefix = "https://bytedance.sg.larkoffice.com/docx";
      const rulesSaved = await client.callTool({
        name: "taskboard_artifact_rules_save",
        arguments: { urlPrefixes: [`${prefix}/`, prefix] },
      });
      assert.deepEqual(rulesSaved.structuredContent, { urlPrefixes: [prefix] });
      const invalidRules = await client.callTool({
        name: "taskboard_artifact_rules_save",
        arguments: { urlPrefixes: ["javascript:alert(1)"] },
      });
      assert.equal(invalidRules.isError, true);
      assert.deepEqual(
        (
          await client.callTool({
            name: "taskboard_artifact_rules",
            arguments: {},
          })
        ).structuredContent,
        { urlPrefixes: [prefix] },
      );
      const resource = await client.readResource({
        uri,
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
      const created = await client.callTool({
        name: "taskboard_work_item_save",
        arguments: {
          title: "Release work",
          description: "Test persistent plugin data",
          status: "review",
          threadIds: [],
          checklist: [{ id: "verify", text: "Verify install", done: false }],
          links: [],
        },
      });
      const items = (created.structuredContent as any).items;
      assert.equal(items[0].title, "Release work");
      assert.deepEqual((created.structuredContent as any).item, items[0]);
      const read = await client.callTool({
        name: "taskboard_workspace",
        arguments: {},
      });
      assert.deepEqual((read.structuredContent as any).items, items);
      const threadId = "a0000000-0000-4000-8000-000000000001";
      const associated = await client.callTool({
        name: "taskboard_work_item_add_thread",
        arguments: { id: items[0].id, threadId },
      });
      assert.equal(associated.isError, undefined);
      assert.deepEqual((associated.structuredContent as any).item.threadIds, [
        threadId,
      ]);
      assert.equal(
        (associated.structuredContent as any).item.description,
        items[0].description,
      );
      const repeated = await client.callTool({
        name: "taskboard_work_item_add_thread",
        arguments: { id: items[0].id, threadId },
      });
      assert.deepEqual(
        (repeated.structuredContent as any).items,
        (associated.structuredContent as any).items,
      );
      const review = await client.callTool({
        name: "taskboard_work_review",
        arguments: { days: 7, timezone: "Asia/Shanghai" },
      });
      assert.equal((review.structuredContent as any).sources.metadata, false);
      assert.deepEqual((review.structuredContent as any).records, []);
      if (!packaged) {
        // 全量输入超过 stdio 单条消息上限，每页仍保留完整用户输入。
        const input = "original input ".repeat(7000);
        const path = join(home, "large-history.jsonl");
        const at = new Date().toISOString();
        const line = (payload: object) =>
          JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n";
        const history = Array.from({ length: 120 }, (_, index) => {
          const id = `turn-${String(index).padStart(3, "0")}`;
          return (
            line({ type: "task_started", turn_id: id }) +
            line({ type: "user_message", turn_id: id, message: input }) +
            line({ type: "task_complete", turn_id: id, duration_ms: 1000 })
          );
        }).join("");
        assert.ok(Buffer.byteLength(history) > 10 * 1024 * 1024);
        await writeFile(path, history);
        const database = new DatabaseSync(join(home, "state_5.sqlite"));
        database.exec(
          "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, updated_at INTEGER, rollout_path TEXT)",
        );
        database
          .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            "one",
            "History",
            "/repo/one",
            "vscode",
            Math.floor(Date.now() / 1000),
            path,
          );
        database.close();
        const ids: string[] = [];
        for (const offset of [0, 50, 100]) {
          const page = await client.callTool({
            name: "taskboard_work_review",
            arguments: { days: 7, timezone: "UTC", offset },
          });
          const data = page.structuredContent as any;
          assert.equal(data.totalRecords, 120);
          assert.equal(data.summary.turns, 120);
          assert.equal(data.projects[0].turns, 120);
          assert.equal(data.records.length, offset === 100 ? 20 : 50);
          assert.equal(data.records[0].userInput, input);
          assert.ok(Buffer.byteLength(JSON.stringify(page)) < 10 * 1024 * 1024);
          ids.push(...data.records.map((record: any) => record.id));
        }
        assert.equal(new Set(ids).size, 120);
        const invalid = await client.callTool({
          name: "taskboard_work_review",
          arguments: { days: 7, timezone: "UTC", offset: -1 },
        });
        assert.equal(invalid.isError, true);
      }
      // 成果只从事项关联的对话派生，手工链接仍独立保存。
      const artifactThreadId = "d0000000-0000-4000-8000-000000000001";
      const planPath = join(home, "design.md");
      const artifactPath = join(home, "artifacts.jsonl");
      const mergeRequest =
        "https://gitlab.example/team/project/-/merge_requests/42";
      const githubPr = "https://github.com/team/project/pull/43";
      const gitlabMr =
        "https://gitlab.com/team/subgroup/project/-/merge_requests/44";
      const larkDocument = `${prefix}/VTWBdRKXso20opxNAC2liEuDgpf`;
      const nativePlan =
        "# 消费端小批次提交方案\n\n按批次提交，保留原始事件。\n";
      const historicalMr =
        "https://code.byted.org/dp/data-brain/merge_requests/1570";
      const historicalDirectory = join(home, "sessions", "2026", "10", "20");
      await mkdir(historicalDirectory, { recursive: true });
      await writeFile(
        join(
          historicalDirectory,
          `rollout-2026-10-20T12-00-00-${artifactThreadId}.jsonl`,
        ),
        [
          {
            type: "session_meta",
            payload: { id: artifactThreadId, cwd: home },
          },
          {
            timestamp: "2026-10-20T04:00:00.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              phase: "final_answer",
              content: [
                { type: "output_text", text: `[运行时 MR](${historicalMr})` },
              ],
            },
          },
        ]
          .map((record) => JSON.stringify(record) + "\n")
          .join(""),
      );
      await writeFile(planPath, "# 插件方案\n");
      await writeFile(
        artifactPath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "artifact-turn",
            last_agent_message: `已创建 [MR](${mergeRequest})、[GitHub PR](${githubPr}/files?diff=split#discussion) 和 [设计方案](${planPath})、[消费优化文档](${larkDocument})，补齐优化前后的完整链路，明确区分**小批次成功**与失败。GitLab MR：${gitlabMr}/diffs?view=inline#note_1。\n<proposed_plan>\n${nativePlan}</proposed_plan>`,
          },
        }) + "\n",
      );
      const artifactDatabase = new DatabaseSync(join(home, "state_5.sqlite"));
      artifactDatabase.exec(
        "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, updated_at INTEGER, rollout_path TEXT)",
      );
      artifactDatabase
        .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          artifactThreadId,
          "Deliverable thread",
          home,
          "vscode",
          Math.floor(Date.now() / 1000),
          artifactPath,
        );
      artifactDatabase.close();
      const unlinked = await client.callTool({
        name: "taskboard_workspace",
        arguments: {},
      });
      const unlinkedData = unlinked.structuredContent as any;
      assert.deepEqual(unlinkedData.items[0].threadIds, [threadId]);
      assert.deepEqual(unlinkedData.discovery.artifacts, []);
      // 先前关联的无日志对话仍在等待索引或已标记不可读，新成果对话尚未关联。
      assert.deepEqual(
        [
          ...unlinkedData.discovery.unavailableThreadIds,
          ...unlinkedData.discovery.pendingThreadIds,
        ],
        [threadId],
      );
      // 看板先建立对话成果索引，工作事项直接读取同一份已完成结果。
      let threadDiscovery: any;
      const started = Date.now();
      do {
        const read = await client.callTool({
          name: "taskboard_thread_artifacts",
          arguments: { threadIds: [artifactThreadId] },
        });
        threadDiscovery = read.structuredContent;
        if (!threadDiscovery.pendingThreadIds.length) break;
        assert.ok(Date.now() - started < 5000, "对话成果后台索引应能完成");
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (true);
      assert.equal(threadDiscovery.artifacts.length, 7);
      assert.deepEqual(
        threadDiscovery.artifacts.find((item: any) => item.kind === "link")
          ?.url,
        larkDocument,
      );
      const manualLinks = [
        { label: "Reference", url: "https://example.com/reference" },
      ];
      const linked = await client.callTool({
        name: "taskboard_work_item_save",
        arguments: {
          ...items[0],
          threadIds: [artifactThreadId],
          links: manualLinks,
        },
      });
      const linkedData = linked.structuredContent as any;
      assert.deepEqual(linkedData.discovery, threadDiscovery);
      assert.notEqual(linked.isError, true);
      assert.deepEqual(linkedData.item.links, manualLinks);
      assert.deepEqual(linkedData.discovery.unavailableThreadIds, []);
      assert.equal(linkedData.discovery.artifacts.length, 7);
      assert.ok(
        linkedData.discovery.artifacts.every(
          (artifact: any) => artifact.threadId === artifactThreadId,
        ),
      );
      assert.deepEqual(
        linkedData.discovery.artifacts
          .filter((artifact: any) => artifact.kind === "mergeRequest")
          .map((artifact: any) => artifact.url)
          .sort(),
        [mergeRequest, githubPr, gitlabMr, historicalMr].sort(),
      );
      assert.equal(
        linkedData.discovery.artifacts.find(
          (artifact: any) => artifact.label === "设计方案",
        ).path,
        planPath,
      );
      const native = linkedData.discovery.artifacts.find(
        (artifact: any) => artifact.label === "消费端小批次提交方案",
      );
      assert.equal(native.kind, "planFile");
      assert.equal(await readFile(native.path, "utf8"), nativePlan);
      assert.equal(
        linkedData.discovery.artifacts.find(
          (artifact: any) => artifact.url === historicalMr,
        )?.label,
        "运行时 MR",
      );
      const discovered = await client.callTool({
        name: "taskboard_workspace",
        arguments: {},
      });
      assert.deepEqual(
        (discovered.structuredContent as any).discovery,
        linkedData.discovery,
      );
      assert.deepEqual(
        (discovered.structuredContent as any).items[0].links,
        manualLinks,
      );
      const deleted = await client.callTool({
        name: "taskboard_work_item_delete",
        arguments: { id: items[0].id },
      });
      assert.deepEqual((deleted.structuredContent as any).items, []);
    } finally {
      await client.close();
      await new Promise<void>((ok) => unavailable.close(() => ok()));
      await rm(home, { recursive: true });
    }
  });
}
