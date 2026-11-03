import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { GitMetadataReader } from "../server/git-metadata";
import { StatusBridge } from "../server/status-bridge";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

/** 用真实临时仓库验证 Git 语义，不读取或改动用户仓库。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "taskboard-git-"));
  const repo = join(home, "main project");
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  return { home, repo, dispose: () => rm(home, { recursive: true }) };
}

test("reads an unborn branch from nested cwd and follows branch changes without waiting for the directory cache", async () => {
  const f = await fixture();
  try {
    const nested = join(f.repo, "src", "nested");
    await mkdir(nested, { recursive: true });
    const reader = new GitMetadataReader();
    assert.deepEqual(await reader.read(nested), {
      branch: "main",
      isWorktree: false,
    });
    git(f.repo, "switch", "-c", "feat/current");
    assert.deepEqual(await reader.read(nested), {
      branch: "feat/current",
      isWorktree: false,
    });
  } finally {
    await f.dispose();
  }
});

test("marks linked worktrees and preserves their marker when HEAD is detached", async () => {
  const f = await fixture();
  try {
    git(
      f.repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    const worktree = join(f.home, "linked project");
    git(f.repo, "worktree", "add", "-b", "feat/linked", worktree);
    const reader = new GitMetadataReader();
    assert.deepEqual(await reader.read(worktree), {
      branch: "feat/linked",
      isWorktree: true,
    });
    git(worktree, "switch", "--detach");
    assert.deepEqual(await reader.read(worktree), {
      branch: null,
      isWorktree: true,
    });
    assert.deepEqual(await reader.read(f.repo), {
      branch: "main",
      isWorktree: false,
    });
  } finally {
    await f.dispose();
  }
});

test("a .git file alone does not make a separate-git-dir checkout a linked worktree", async () => {
  const f = await fixture();
  try {
    const checkout = join(f.home, "separate checkout");
    await mkdir(checkout);
    git(
      checkout,
      "init",
      "-b",
      "feat/separate",
      `--separate-git-dir=${join(f.home, "separate.git")}`,
    );
    assert.deepEqual(await new GitMetadataReader().read(checkout), {
      branch: "feat/separate",
      isWorktree: false,
    });
  } finally {
    await f.dispose();
  }
});

test("empty paths, missing directories and non-repositories have no Git metadata", async () => {
  const f = await fixture();
  try {
    const reader = new GitMetadataReader();
    assert.equal(await reader.read(""), null);
    assert.equal(await reader.read(join(f.home, "missing")), null);
    assert.equal(await reader.read(f.home), null);
  } finally {
    await f.dispose();
  }
});

test("snapshots enrich both indexed and newly loaded conversations and refresh branches within the metadata cache", async () => {
  const f = await fixture();
  git(
    f.repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const worktree = join(f.home, "new conversation");
  git(f.repo, "worktree", "add", "-b", "feat/new", worktree);
  const database = new DatabaseSync(join(f.home, "state_5.sqlite"));
  database.exec(
    "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, thread_source TEXT, archived INTEGER)",
  );
  database
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)")
    .run(
      "indexed",
      "Existing conversation",
      f.repo,
      1800000000,
      "vscode",
      "user",
      0,
    );
  database.close();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridge = new StatusBridge({
    home: f.home,
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === undefined) return;
      const result =
        message.method === "thread/loaded/list"
          ? { data: ["new"] }
          : message.method === "thread/read"
            ? { thread: { id: "new", cwd: worktree, status: { type: "idle" } } }
            : message.method === "thread/turns/list"
              ? { data: [], nextCursor: null }
              : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    }),
  );
  try {
    bridge.start();
    let snapshot = await bridge.snapshot();
    const start = Date.now();
    while (!snapshot.threads.some((thread) => thread.id === "new")) {
      assert.ok(Date.now() - start < 5000, "新对话应从实时连接载入");
      await new Promise((resolve) => setTimeout(resolve, 20));
      snapshot = await bridge.snapshot();
    }
    assert.deepEqual(
      snapshot.threads.find((thread) => thread.id === "indexed")?.git,
      { branch: "main", isWorktree: false },
    );
    assert.deepEqual(
      snapshot.threads.find((thread) => thread.id === "new")?.git,
      { branch: "feat/new", isWorktree: true },
    );
    git(f.repo, "switch", "-c", "feat/switched");
    const changed = await bridge.snapshot();
    assert.deepEqual(
      changed.threads.find((thread) => thread.id === "indexed")?.git,
      { branch: "feat/switched", isWorktree: false },
    );
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.dispose();
  }
});
