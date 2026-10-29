import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { once } from "node:events";

test(
  "preview workspaces support persistent edits and reject writes from other pages",
  { timeout: 10000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "taskboard-workspace-http-"));
    const reserve = net.createServer();
    await new Promise<void>((ok) => reserve.listen(0, "127.0.0.1", ok));
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((ok) => reserve.close(() => ok()));
    const child = spawn(process.execPath, [resolve("dist/server/preview.js")], {
      env: {
        ...process.env,
        CODEX_HOME: home,
        TASKBOARD_PORT: String(port),
        TASKBOARD_WS_URL: "ws://127.0.0.1:1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const origin = `http://127.0.0.1:${port}`;
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const post = (path: string, data: object, source = origin) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: source, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${origin}/api/workspace`)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* 等待隔离预览进程启动。 */
        }
        await setTimeout(30);
      }
      assert.ok(ready, diagnostics);
      assert.deepEqual(await (await fetch(`${origin}/api/workspace`)).json(), {
        items: [],
        discovery: {
          artifacts: [],
          unavailableThreadIds: [],
          pendingThreadIds: [],
        },
      });
      const prefix = "https://bytedance.sg.larkoffice.com/docx";
      assert.deepEqual(
        await (await fetch(`${origin}/api/artifact-rules`)).json(),
        { urlPrefixes: [] },
      );
      assert.equal(
        (
          await post(
            "/api/artifact-rules",
            { urlPrefixes: [prefix] },
            "https://other.example",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post("/api/artifact-rules", {
            urlPrefixes: ["file:///tmp/docx"],
          })
        ).status,
        400,
      );
      assert.equal(
        (await post("/api/artifact-rules", { urlPrefixes: ["docx"] })).status,
        400,
      );
      const savedRules = await post("/api/artifact-rules", {
        urlPrefixes: [`${prefix}/`, prefix],
      });
      assert.equal(savedRules.status, 200);
      assert.deepEqual(await savedRules.json(), { urlPrefixes: [prefix] });
      assert.deepEqual(
        await (await fetch(`${origin}/api/artifact-rules`)).json(),
        { urlPrefixes: [prefix] },
      );
      // 首次同步会加载会话运行态，入口需显式同源 POST，普通快照仍可只读访问。
      assert.equal(
        (await post("/api/board/open", {}, "https://other.example")).status,
        403,
      );
      assert.equal(
        (await post("/api/board/open", { unreadSelection: 1 })).status,
        400,
      );
      const opened = await post("/api/board/open", {});
      assert.equal(opened.status, 200);
      assert.equal(
        typeof ((await opened.json()) as any).syncingThreads,
        "boolean",
      );
      const input = {
        title: "Local review",
        description: "",
        status: "planned",
        threadIds: [],
        checklist: [],
        links: [],
      };
      assert.equal(
        (await post("/api/work-items/save", input, "https://other.example"))
          .status,
        403,
      );
      const saved = await post("/api/work-items/save", input);
      assert.equal(saved.status, 200);
      const { items } = (await saved.json()) as any;
      assert.equal(items[0].title, input.title);
      assert.deepEqual(
        ((await (await fetch(`${origin}/api/workspace`)).json()) as any).items,
        items,
      );
      const association = {
        id: items[0].id,
        threadId: "a0000000-0000-4000-8000-000000000001",
      };
      assert.equal(
        (
          await post(
            "/api/work-items/add-thread",
            association,
            "https://other.example",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post("/api/work-items/add-thread", {
            ...association,
            threadId: "bad",
          })
        ).status,
        400,
      );
      const added = await post("/api/work-items/add-thread", association);
      assert.equal(added.status, 200);
      const addedData = (await added.json()) as any;
      assert.deepEqual(addedData.item.threadIds, [association.threadId]);
      assert.equal(addedData.item.title, input.title);
      const repeated = await post("/api/work-items/add-thread", association);
      assert.equal(repeated.status, 200);
      assert.deepEqual(((await repeated.json()) as any).items, addedData.items);
      assert.equal(
        (await post("/api/work-items/save", { ...input, title: "" })).status,
        400,
      );
      const review = await fetch(
        `${origin}/api/work-review?days=7&timezone=Asia%2FShanghai`,
      );
      assert.equal(review.status, 200);
      assert.deepEqual(((await review.json()) as any).records, []);
      // 长输入只能随当前页传输，汇总仍覆盖所有历史回合。
      const path = join(home, "large-history.jsonl");
      const historyInput = "原始用户输入".repeat(10000);
      const at = new Date().toISOString();
      const line = (payload: object) =>
        JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n";
      await writeFile(
        path,
        Array.from({ length: 55 }, (_, index) => {
          const id = `turn-${String(index).padStart(3, "0")}`;
          return (
            line({ type: "task_started", turn_id: id }) +
            line({ type: "user_message", turn_id: id, message: historyInput }) +
            line({ type: "task_complete", turn_id: id, duration_ms: 1000 })
          );
        }).join(""),
      );
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
      const reviewUrl = `${origin}/api/work-review?days=7&timezone=UTC`;
      const first = (await (await fetch(reviewUrl)).json()) as any;
      assert.equal(first.records.length, 50);
      assert.equal(first.totalRecords, 55);
      assert.equal(first.summary.turns, 55);
      const second = (await (
        await fetch(`${reviewUrl}&offset=50&limit=2`)
      ).json()) as any;
      assert.equal(second.records.length, 2);
      assert.equal(second.totalRecords, 55);
      assert.equal(second.records[0].userInput, historyInput);
      assert.deepEqual(second.summary, first.summary);
      assert.deepEqual(second.projects, first.projects);
      assert.ok(
        second.records.every(
          (record: any) =>
            !first.records.some((item: any) => item.id === record.id),
        ),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(second)) < 1000000);
      assert.equal((await fetch(`${reviewUrl}&limit=0`)).status, 400);
      assert.equal((await fetch(`${reviewUrl}&offset=-1`)).status, 400);
      // 已存在日志只有在事项关联该对话后才参与成果识别。
      const artifactThreadId = "d0000000-0000-4000-8000-000000000001";
      const artifactPath = join(home, "artifacts.jsonl");
      const planPath = join(home, "design.md");
      const larkDocument = `${prefix}/VTWBdRKXso20opxNAC2liEuDgpf`;
      const mergeRequest =
        "https://gitlab.example/team/project/-/merge_requests/42";
      await writeFile(planPath, "# 插件方案\n");
      await writeFile(
        artifactPath,
        line({
          type: "task_complete",
          turn_id: "artifact-turn",
          last_agent_message: `已创建 [MR](${mergeRequest}) 和 [设计方案](${planPath})、[消费优化文档](${larkDocument})。`,
        }),
      );
      const artifactDatabase = new DatabaseSync(join(home, "state_5.sqlite"));
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
      const unlinked = (await (
        await fetch(`${origin}/api/workspace`)
      ).json()) as any;
      assert.deepEqual(unlinked.items[0].threadIds, [association.threadId]);
      assert.deepEqual(unlinked.discovery.artifacts, []);
      // 先前关联的无日志对话仍在等待索引或已标记不可读，新成果对话尚未关联。
      assert.deepEqual(
        [
          ...unlinked.discovery.unavailableThreadIds,
          ...unlinked.discovery.pendingThreadIds,
        ],
        [association.threadId],
      );
      assert.equal(
        (await post("/api/thread-artifacts", { threadIds: [1] })).status,
        400,
      );
      let threadDiscovery: any;
      const started = Date.now();
      do {
        const response = await post("/api/thread-artifacts", {
          threadIds: [artifactThreadId],
        });
        assert.equal(response.status, 200);
        threadDiscovery = await response.json();
        if (!threadDiscovery.pendingThreadIds.length) break;
        assert.ok(Date.now() - started < 5000, "对话成果后台索引应能完成");
        await setTimeout(20);
      } while (true);
      assert.equal(threadDiscovery.artifacts.length, 3);
      assert.equal(
        threadDiscovery.artifacts.find((item: any) => item.kind === "link")
          ?.url,
        larkDocument,
      );
      const manualLinks = [
        { label: "Reference", url: "https://example.com/reference" },
      ];
      const linkedResponse = await post("/api/work-items/save", {
        ...items[0],
        threadIds: [artifactThreadId],
        links: manualLinks,
      });
      assert.equal(linkedResponse.status, 200);
      const linked = (await linkedResponse.json()) as any;
      assert.deepEqual(linked.discovery, threadDiscovery);
      assert.deepEqual(linked.item.links, manualLinks);
      assert.deepEqual(linked.discovery.unavailableThreadIds, []);
      assert.equal(linked.discovery.artifacts.length, 3);
      assert.ok(
        linked.discovery.artifacts.every(
          (artifact: any) => artifact.threadId === artifactThreadId,
        ),
      );
      assert.equal(
        linked.discovery.artifacts.find(
          (artifact: any) => artifact.kind === "mergeRequest",
        ).url,
        mergeRequest,
      );
      const plan = linked.discovery.artifacts.find(
        (artifact: any) => artifact.kind === "planFile",
      );
      assert.equal(plan.path, planPath);
      const discovered = (await (
        await fetch(`${origin}/api/workspace`)
      ).json()) as any;
      assert.deepEqual(discovered.discovery, linked.discovery);
      assert.deepEqual(discovered.items[0].links, manualLinks);
      // 删除前缀后，无日志变更也必须重新生成缓存，内建 MR 和方案仍保留。
      assert.equal(
        (await post("/api/artifact-rules", { urlPrefixes: [] })).status,
        200,
      );
      let cleared: any;
      const clearStarted = Date.now();
      do {
        cleared = await (
          await post("/api/thread-artifacts", { threadIds: [artifactThreadId] })
        ).json();
        if (!cleared.pendingThreadIds.length) break;
        assert.ok(Date.now() - clearStarted < 5000);
        await setTimeout(20);
      } while (true);
      assert.equal(cleared.artifacts.length, 2);
      assert.ok(cleared.artifacts.every((item: any) => item.kind !== "link"));
      assert.deepEqual(
        ((await (await fetch(`${origin}/api/workspace`)).json()) as any)
          .discovery,
        cleared,
      );

      assert.deepEqual(
        await (
          await post("/api/work-items/delete", { id: items[0].id })
        ).json(),
        {
          items: [],
          discovery: {
            artifacts: [],
            unavailableThreadIds: [],
            pendingThreadIds: [],
          },
        },
      );
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(home, { recursive: true, force: true });
    }
  },
);
