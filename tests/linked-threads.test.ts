import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLinkedThreads, readLocalData } from "../server/local-data";

test("linked conversations include archived and older sources without expanding the board window", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-linked-threads-"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, archived INTEGER, first_user_message TEXT)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, '/repo/project', ?, 'vscode', 'user', ?, 'PRIVATE_BODY_MUST_NOT_LEAK')",
    );
    for (let rank = 0; rank < 500; rank++)
      insert.run(
        `recent-${rank}`,
        `Recent ${rank}`,
        null,
        1700000000 + rank,
        0,
      );
    insert.run("old", "原始标题", "[当前标题](https://example.com)", 1, 0);
    insert.run("archived", "归档对话", null, 1700001000, 1);

    const board = await readLocalData(home);
    assert.equal(board.threads.length, 500);
    assert.ok(board.threads.every((thread) => thread.id.startsWith("recent-")));
    const linked = readLinkedThreads(home, [
      "old",
      "archived",
      "old",
      "missing",
      "' OR 1=1 --",
    ]);
    assert.deepEqual(linked, [
      { id: "old", title: "当前标题", project: "project" },
      { id: "archived", title: "归档对话", project: "project" },
    ]);
    assert.equal(JSON.stringify(linked).includes("PRIVATE_BODY"), false);
    database
      .prepare("UPDATE threads SET name = '更新后的标题' WHERE id = 'old'")
      .run();
    assert.equal(readLinkedThreads(home, ["old"])[0].title, "更新后的标题");
  } finally {
    database.close();
    await rm(home, { recursive: true });
  }
});

test("linked conversations support legacy indexes and an unavailable index", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-linked-legacy-"));
  try {
    assert.deepEqual(readLinkedThreads(home, ["missing"]), []);
    assert.deepEqual(readLinkedThreads(home, []), []);
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    try {
      database.exec("CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT)");
      database
        .prepare("INSERT INTO threads VALUES (?, ?, ?)")
        .run("legacy", "旧版标题", "");
      assert.deepEqual(readLinkedThreads(home, ["legacy"]), [
        { id: "legacy", title: "旧版标题", project: "未归属项目" },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(home, { recursive: true });
  }
});

test("linked conversations exclude child agents from each supported source marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-linked-agents-"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_role TEXT, archived INTEGER)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, '/repo/project', 1700000000, ?, ?, ?, ?)",
    );
    insert.run("user", "用户对话", "vscode", "user", null, 0);
    insert.run("archived-user", "归档用户对话", "vscode", "user", null, 1);
    insert.run(
      "spawn",
      "子 Agent",
      JSON.stringify({ subagent: { thread_spawn: {} } }),
      "user",
      null,
      0,
    );
    insert.run(
      "guardian",
      "Guardian review",
      JSON.stringify({ subagent: { other: "guardian" } }),
      "guardian_review",
      null,
      1,
    );
    insert.run("role", "角色 Agent", "vscode", "user", "reviewer", 0);
    insert.run("agent-kind", "内部 Agent", "vscode", "agent", null, 0);
    insert.run("subagent-kind", "子 Agent", "vscode", "subagent", null, 0);
    insert.run(
      "guardian-kind",
      "Guardian review",
      "vscode",
      "guardian_review",
      null,
      0,
    );

    const ids = [
      "user",
      "spawn",
      "guardian",
      "role",
      "agent-kind",
      "subagent-kind",
      "guardian-kind",
      "archived-user",
    ];
    assert.deepEqual(readLinkedThreads(home, ids), [
      { id: "user", title: "用户对话", project: "project" },
      { id: "archived-user", title: "归档用户对话", project: "project" },
    ]);
    const board = await readLocalData(home);
    assert.ok(
      board.threads
        .filter((thread) => thread.id !== "user")
        .every((thread) => thread.kind === "agent"),
    );
  } finally {
    database.close();
    await rm(home, { recursive: true });
  }
});
