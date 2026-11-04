import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalData } from "../server/local-data";
import { belongsToColumn } from "../shared/types";
import { matchesFilters } from "../ui/board-filters";

test("recent user conversations and older unread conversations survive newer child-agent records", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-unread-window-"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, agent_role TEXT, archived INTEGER)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, '/repo/project', ?, ?, ?, ?, ?)",
    );
    for (let rank = 0; rank < 500; rank++) {
      insert.run(
        `recent-${rank}`,
        `对话 ${rank}`,
        1000 + rank,
        "vscode",
        "user",
        null,
        0,
      );
      insert.run(
        `agent-${rank}`,
        "子 Agent",
        2000 + rank,
        '{"subagent":{}}',
        "subagent",
        null,
        0,
      );
    }
    insert.run(
      "old-unread",
      "排查子 Agent 无有效输出",
      2,
      "vscode",
      "user",
      null,
      0,
    );
    insert.run("other-unread", "另一来源的未读", 1, "vscode", "user", null, 0);
    insert.run("old-read", "较早的已读对话", 1, "vscode", "user", null, 0);
    insert.run("archived", "已归档", 3000, "vscode", "user", null, 1);
    insert.run(
      "role-agent",
      "角色 Agent",
      3000,
      "vscode",
      "user",
      "reviewer",
      0,
    );
    insert.run(
      "guardian",
      "审查 Agent",
      3000,
      "vscode",
      "guardian_review",
      null,
      0,
    );
    insert.run("unknown", "未知来源", 3000, "cli", null, null, 0);
    const normal =
      "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c";
    const path = join(home, ".codex-global-state.json");
    const state = {
      "electron-thread-read-state-v1": {
        unreadByIdentity: {
          account: {
            [normal]: [
              "old-unread",
              "recent-0",
              "old-unread",
              "agent-0",
              "role-agent",
              "guardian",
              "unknown",
              "archived",
              "missing",
            ],
            "local:other": ["other-unread"],
          },
        },
      },
    };
    const content = JSON.stringify(state);
    await writeFile(path, content);

    const data = await readLocalData(home);
    assert.equal(data.metadata, true);
    assert.equal(data.threads.length, 501);
    assert.equal(new Set(data.threads.map((thread) => thread.id)).size, 501);
    assert.ok(data.threads.every((thread) => thread.kind === "user"));
    assert.equal(
      data.threads.filter((thread) => thread.id.startsWith("recent-")).length,
      500,
    );
    const unread = data.threads.find((thread) => thread.id === "old-unread")!;
    assert.equal(unread?.unread, true);
    assert.equal(matchesFilters(unread, {}), true);
    assert.equal(belongsToColumn(unread, "unread"), true);
    assert.equal(data.unreadOptions[0].count, 2);

    const selected = await readLocalData(
      home,
      JSON.stringify(["account", "local:other"]),
    );
    assert.equal(selected.threads.length, 501);
    assert.equal(
      selected.threads.find((thread) => thread.id === "other-unread")?.unread,
      true,
    );
    assert.equal(
      selected.threads.some((thread) => thread.id === "old-unread"),
      false,
    );
    assert.equal(await readFile(path, "utf8"), content);

    state["electron-thread-read-state-v1"].unreadByIdentity.account[normal] =
      [];
    await writeFile(path, JSON.stringify(state));
    const read = await readLocalData(home);
    assert.equal(read.threads.length, 500);
    assert.ok(
      read.threads.every(
        (thread) => thread.id.startsWith("recent-") && !thread.unread,
      ),
    );
  } finally {
    database.close();
    await rm(home, { recursive: true });
  }
});

test("legacy indexes exclude child agents before applying the recent conversation limit", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-legacy-window-"));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  try {
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, archived INTEGER)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, '对话', '/repo', ?, ?, 0)",
    );
    for (let rank = 0; rank < 500; rank++)
      insert.run(`agent-${rank}`, 2000 + rank, '{"subagent":{}}');
    insert.run("user", 1, "vscode");

    const data = await readLocalData(home);
    assert.equal(data.metadata, true);
    assert.deepEqual(
      data.threads.map((thread) => thread.id),
      ["user"],
    );
    assert.equal(data.threads[0].unread, null);
  } finally {
    database.close();
    await rm(home, { recursive: true });
  }
});
