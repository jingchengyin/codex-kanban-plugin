import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadArtifactIndex } from "../server/thread-artifacts.js";
import type {
  ArtifactDiscovery,
  ArtifactRules,
  DetectedArtifact,
} from "../shared/work-items.js";

const ids = ["first", "second", "third", "fourth"];
const at = "2026-10-27T01:00:00.000Z";
const cachePath = (home: string, id: string) =>
  join(
    home,
    "kanban",
    "thread-artifacts",
    `${createHash("sha256").update(id).digest("hex")}.json`,
  );
const final = (text: string) =>
  JSON.stringify({
    timestamp: at,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  }) + "\n";
const artifact = (threadId: string): DetectedArtifact => ({
  id: createHash("sha256").update(threadId).digest("hex"),
  kind: "mergeRequest",
  threadId,
  label: `${threadId} 成果`,
  detectedAt: at,
  url: `https://github.com/team/${threadId}/pull/1`,
});

async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-thread-artifacts-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function until(predicate: () => Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!(await predicate())) {
    if (performance.now() > deadline)
      throw new Error("Artifact index did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function promptly<T>(result: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Read waited for the background parser")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delayedReader() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[][] = [];
  return {
    calls,
    release,
    reader: {
      async read(
        _home: string,
        threadIds: string[],
      ): Promise<ArtifactDiscovery> {
        calls.push([...threadIds]);
        await gate;
        return { artifacts: threadIds.map(artifact), unavailableThreadIds: [] };
      },
    },
  };
}

test("cold indexes return pending, persist ready and empty results, and isolate unavailable threads", () =>
  fixture(async (home) => {
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT)",
    );
    const insert = database.prepare("INSERT INTO threads VALUES(?, ?, ?)");
    for (const id of ids.slice(0, 3))
      insert.run(id, home, join(home, `${id}.jsonl`));
    database.close();
    await writeFile(
      join(home, "first.jsonl"),
      final("https://github.com/team/repo/pull/7"),
    );
    await writeFile(join(home, "second.jsonl"), final("本轮没有交付成果。"));

    const index = new ThreadArtifactIndex(home);
    const cold = await index.read(ids.slice(0, 3));
    assert.deepEqual(cold.artifacts, []);
    assert.deepEqual(new Set(cold.pendingThreadIds), new Set(ids.slice(0, 3)));
    await until(
      async () =>
        (await index.read(ids.slice(0, 3))).pendingThreadIds?.length === 0,
    );
    const ready = await index.read(ids.slice(0, 3));
    assert.equal(ready.artifacts.length, 1);
    assert.deepEqual(ready.unavailableThreadIds, ["third"]);
    assert.deepEqual(ready.pendingThreadIds, []);
    for (const id of ids.slice(0, 3)) {
      const stored = JSON.parse(await readFile(cachePath(home, id), "utf8"));
      assert.equal(stored.schemaVersion, 1);
      assert.equal(stored.threadId, id);
      assert.equal(stored.unavailable, id === "third");
      assert.equal(stored.artifacts.length, id === "first" ? 1 : 0);
    }

    index.stop();
    const blocked = delayedReader();
    const restoredIndex = new ThreadArtifactIndex(home, blocked.reader);
    try {
      const restored = await promptly(restoredIndex.read(ids.slice(0, 3)));
      assert.deepEqual(restored.artifacts, ready.artifacts);
      assert.deepEqual(
        restored.unavailableThreadIds,
        ready.unavailableThreadIds,
      );
      assert.deepEqual(restored.pendingThreadIds, []);
    } finally {
      restoredIndex.stop();
      blocked.release();
    }
    await until(
      async () =>
        (await restoredIndex.read(ids.slice(0, 3))).artifacts.length === 3,
    );
  }));

test("overlapping requests share background batches and keep independent request sets cached", () =>
  fixture(async (home) => {
    const blocked = delayedReader();
    const index = new ThreadArtifactIndex(home, blocked.reader);
    try {
      const responses = await promptly(
        Promise.all([
          index.read(ids),
          index.read(["first", "first", "second"]),
          index.read(["third", "fourth"]),
        ]),
      );
      assert.ok(responses.every((result) => result.artifacts.length === 0));
      await until(async () => blocked.calls.length > 0);
      assert.ok(blocked.calls.every((batch) => batch.length <= 3));
    } finally {
      blocked.release();
    }
    await until(
      async () => (await index.read(ids)).pendingThreadIds?.length === 0,
    );
    assert.ok(blocked.calls.every((batch) => batch.length <= 3));
    assert.deepEqual(blocked.calls.flat().sort(), [...ids].sort());
    assert.deepEqual((await index.read(["first"])).artifacts, [
      artifact("first"),
    ]);
    assert.deepEqual((await index.read(["fourth"])).artifacts, [
      artifact("fourth"),
    ]);
    assert.deepEqual((await index.read(["first"])).artifacts, [
      artifact("first"),
    ]);
    assert.deepEqual(blocked.calls.flat().sort(), [...ids].sort());
    index.stop();
  }));

test("invalid JSON, schema versions and mismatched thread IDs are rebuilt instead of exposed", () =>
  fixture(async (home) => {
    await mkdir(join(home, "kanban", "thread-artifacts"), { recursive: true });
    await writeFile(cachePath(home, "first"), "{broken");
    await writeFile(
      cachePath(home, "second"),
      JSON.stringify({
        schemaVersion: 2,
        threadId: "second",
        artifacts: [artifact("second")],
        unavailable: false,
      }),
    );
    await writeFile(
      cachePath(home, "third"),
      JSON.stringify({
        schemaVersion: 1,
        threadId: "another-thread",
        artifacts: [artifact("another-thread")],
        unavailable: false,
      }),
    );
    const blocked = delayedReader();
    const index = new ThreadArtifactIndex(home, blocked.reader);
    try {
      const result = await promptly(index.read(ids.slice(0, 3)));
      assert.deepEqual(result.artifacts, []);
      assert.deepEqual(
        new Set(result.pendingThreadIds),
        new Set(ids.slice(0, 3)),
      );
    } finally {
      blocked.release();
    }
    await until(
      async () =>
        (await index.read(ids.slice(0, 3))).pendingThreadIds?.length === 0,
    );
    const rebuilt = await index.read(ids.slice(0, 3));
    assert.deepEqual(
      new Set(rebuilt.artifacts.map((item) => item.threadId)),
      new Set(ids.slice(0, 3)),
    );
    for (const id of ids.slice(0, 3)) {
      const stored = JSON.parse(await readFile(cachePath(home, id), "utf8"));
      assert.equal(stored.schemaVersion, 1);
      assert.equal(stored.threadId, id);
    }
    index.stop();
  }));

test("deleted native plan exports are filtered from cached results and rebuilt in the background", () =>
  fixture(async (home) => {
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT)",
    );
    database
      .prepare("INSERT INTO threads VALUES(?, ?, ?)")
      .run("first", home, join(home, "first.jsonl"));
    database.close();
    const content = "# 消费端小批次提交方案\n\n按小批次提交。";
    await writeFile(
      join(home, "first.jsonl"),
      final(`<proposed_plan>\n${content}\n</proposed_plan>`),
    );
    const index = new ThreadArtifactIndex(home);
    await index.read(["first"]);
    await until(
      async () => (await index.read(["first"])).pendingThreadIds?.length === 0,
    );
    const [plan] = (await index.read(["first"])).artifacts;
    assert.ok(plan?.kind === "planFile");
    await unlink(plan.path);
    const missing = await index.read(["first"]);
    assert.deepEqual(missing.artifacts, []);
    await until(async () => {
      const result = await index.read(["first"]);
      return result.artifacts.some((item) => item.id === plan.id);
    });
    assert.ok((await stat(plan.path)).isFile());
    assert.equal((await readFile(plan.path, "utf8")).trim(), content);
    index.stop();
  }));

test("ready results refresh on demand after fifteen seconds without blocking cached reads", (context) =>
  fixture(async (home) => {
    let clock = Date.now();
    context.mock.method(Date, "now", () => clock);
    let scans = 0;
    const reader = {
      async read(
        _home: string,
        threadIds: string[],
      ): Promise<ArtifactDiscovery> {
        scans++;
        return {
          artifacts: threadIds.map((id) => ({
            ...artifact(id),
            label: `版本 ${scans}`,
          })),
          unavailableThreadIds: [],
        };
      },
    };
    const index = new ThreadArtifactIndex(home, reader);
    await index.read(["first"]);
    await until(
      async () => (await index.read(["first"])).pendingThreadIds?.length === 0,
    );
    assert.equal(scans, 1);
    clock += 14999;
    assert.equal((await index.read(["first"])).artifacts[0].label, "版本 1");
    assert.equal(scans, 1);
    clock++;
    const stale = await index.read(["first"]);
    assert.equal(stale.artifacts[0].label, "版本 1");
    assert.deepEqual(stale.pendingThreadIds, []);
    await until(
      async () => (await index.read(["first"])).artifacts[0].label === "版本 2",
    );
    assert.equal(scans, 2);
    index.stop();
  }));

test("rule changes rebuild unchanged logs and persist the same outcomes across index restarts", () =>
  fixture(async (home) => {
    const prefix = "https://bytedance.sg.larkoffice.com/docx";
    const url = `${prefix}/VTWBdRKXso20opxNAC2liEuDgpf`;
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT)",
    );
    database
      .prepare("INSERT INTO threads VALUES(?, ?, ?)")
      .run("first", home, join(home, "first.jsonl"));
    database.close();
    await writeFile(
      join(home, "first.jsonl"),
      final(`[消费优化文档](${url}) https://github.com/team/repo/pull/7`),
    );
    const index = new ThreadArtifactIndex(home);
    await index.read(["first"]);
    await until(
      async () => (await index.read(["first"])).pendingThreadIds?.length === 0,
    );
    assert.equal((await index.read(["first"])).artifacts.length, 1);
    assert.deepEqual(await index.readRules(), { urlPrefixes: [] });
    await index.saveRules({ urlPrefixes: [prefix] });
    await until(async () => {
      const found = await index.read(["first"]);
      return (
        found.pendingThreadIds?.length === 0 && found.artifacts.length === 2
      );
    });
    const ready = await index.read(["first"]);
    const link = ready.artifacts.find((item) => item.kind === "link");
    assert.ok(link?.kind === "link");
    assert.equal(link.url, url);
    assert.equal(link.label, "消费优化文档");
    index.stop();

    // 新进程先读取同一份规则和成果磁盘缓存，无需等待日志解析。
    const blocked = delayedReader();
    const restarted = new ThreadArtifactIndex(home, blocked.reader);
    assert.deepEqual(await restarted.readRules(), { urlPrefixes: [prefix] });
    assert.deepEqual(
      (await promptly(restarted.read(["first"]))).artifacts,
      ready.artifacts,
    );
    restarted.stop();
    blocked.release();
    await until(
      async () => (await restarted.read(["first"])).artifacts.length === 1,
    );

    const changed = new ThreadArtifactIndex(home);
    await changed.saveRules({ urlPrefixes: [] });
    await until(async () => {
      const found = await changed.read(["first"]);
      return (
        found.pendingThreadIds?.length === 0 && found.artifacts.length === 1
      );
    });
    const remaining = (await changed.read(["first"])).artifacts;
    assert.equal(remaining[0].kind, "mergeRequest");
    assert.deepEqual(await changed.readRules(), { urlPrefixes: [] });
    changed.stop();
  }));

test("saving rules while a scan is running never publishes that scan under the new rules", () =>
  fixture(async (home) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const reader = {
      async read(
        _home: string,
        threadIds: string[],
        rules?: ArtifactRules,
      ): Promise<ArtifactDiscovery> {
        calls++;
        if (calls === 1) await gate;
        return {
          artifacts: threadIds.map((id) => ({
            ...artifact(id),
            label: rules?.urlPrefixes.length ? "新规则" : "旧规则",
          })),
          unavailableThreadIds: [],
        };
      },
    };
    const index = new ThreadArtifactIndex(home, reader);
    try {
      await index.read(["first"]);
      await until(async () => calls === 1);
      await index.saveRules({
        urlPrefixes: ["https://bytedance.sg.larkoffice.com/docx"],
      });
      assert.deepEqual((await index.read(["first"])).artifacts, []);
      release();
      await until(async () => {
        const found = await index.read(["first"]);
        assert.ok(found.artifacts.every((item) => item.label === "新规则"));
        return found.pendingThreadIds?.length === 0;
      });
      assert.equal((await index.read(["first"])).artifacts[0].label, "新规则");
    } finally {
      release();
      index.stop();
    }
  }));

test("a running index observes rule changes saved by another index", () =>
  fixture(async (home) => {
    const reader = {
      async read(
        _home: string,
        threadIds: string[],
        rules?: ArtifactRules,
      ): Promise<ArtifactDiscovery> {
        return {
          artifacts: threadIds.map((id) => ({
            ...artifact(id),
            label: rules?.urlPrefixes.length ? "有前缀" : "无前缀",
          })),
          unavailableThreadIds: [],
        };
      },
    };
    const first = new ThreadArtifactIndex(home, reader);
    const second = new ThreadArtifactIndex(home, reader);
    try {
      await first.read(["first"]);
      await until(
        async () =>
          (await first.read(["first"])).pendingThreadIds?.length === 0,
      );
      assert.equal((await second.read(["first"])).artifacts[0].label, "无前缀");
      await second.saveRules({
        urlPrefixes: ["https://bytedance.sg.larkoffice.com/docx"],
      });
      await until(async () =>
        (await first.read(["first"])).artifacts.some(
          (item) => item.label === "有前缀",
        ),
      );
      assert.deepEqual(await first.readRules(), await second.readRules());
    } finally {
      first.stop();
      second.stop();
    }
  }));
