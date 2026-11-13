import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteDataReader } from "../server/remote-data";
import {
  boardThreadId,
  conversationUrl,
  projectKey,
} from "../shared/thread-location";
import { matchesFilters } from "../ui/board-filters";
import { compareByLastUserMessage } from "../shared/types";

const id = "00000000-0000-4000-8000-000000000001";
const hostId = "remote-ssh-discovered:example-host";
const row = {
  id,
  title: "Remote conversation",
  name: null,
  cwd: "/work/project",
  updated_at: 1800000000,
  model: null,
  reasoning_effort: null,
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "kanban-remote-"));
  const output = join(home, "response.json");
  const args = join(home, "args.json");
  await writeFile(output, JSON.stringify([row]));
  const config = {
    "codex-managed-remote-connections": [
      {
        hostId,
        source: "discovered",
        alias: "example-host",
        displayName: "Devbox",
      },
    ],
    "remote-projects": [
      { hostId, label: "Remote project", remotePath: "/work/project" },
    ],
  };
  await writeFile(
    join(home, ".codex-global-state.json"),
    JSON.stringify(config),
  );
  await writeFile(
    join(home, "ssh"),
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));const data=fs.readFileSync(${JSON.stringify(output)},'utf8');if(data==='FAIL'){process.stderr.write('SSH authentication failed');process.exit(255)}process.stdout.write(data);\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${home}:${previousPath}`;
  return {
    home,
    output,
    args,
    config,
    reader: new RemoteDataReader(home),
    async close() {
      process.env.PATH = previousPath;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("SSH metadata becomes host-scoped conversations and projects using the configured alias", async () => {
  const f = await fixture();
  try {
    const data = await f.reader.read();
    assert.equal(data.threads.length, 1);
    const remote = data.threads[0];
    assert.equal(remote.id, boardThreadId(hostId, id));
    assert.equal(remote.hostName, "Devbox");
    assert.equal(remote.project, "Remote project");
    assert.equal(remote.fresh, false);
    const args = JSON.parse(await readFile(f.args, "utf8"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.equal(args.at(-2), "example-host");
    assert.equal(data.hosts[0].available, true);
    const local = {
      ...remote,
      id,
      hostId: undefined,
      hostName: undefined,
      project: remote.project,
    };
    assert.notEqual(projectKey(local), projectKey(remote));
    assert.equal(
      matchesFilters(remote, { project: [projectKey(remote)] }),
      true,
    );
    assert.equal(
      matchesFilters(local, { project: [projectKey(remote)] }),
      false,
    );
    assert.equal(matchesFilters(remote, { project: [remote.project] }), false);
    assert.equal(matchesFilters(local, { project: [local.project] }), true);
    const url = new URL(conversationUrl(remote.id));
    assert.equal(url.pathname, `/${id}`);
    assert.equal(url.searchParams.get("hostId"), hostId);
    assert.equal(conversationUrl(id), `codex://threads/${id}`);
    const older = { ...remote, id: "older", updatedAt: "2026-01-01T00:00:00Z" };
    assert.deepEqual(
      [older, remote].sort(compareByLastUserMessage).map((t) => t.id),
      [remote.id, "older"],
    );
    assert.equal(remote.lastUserMessageAt, null);
  } finally {
    await f.close();
  }
});

test("a host outage keeps the last index, reports the failure and retries after the cache expires", async (t) => {
  const f = await fixture();
  try {
    const first = await f.reader.read();
    await writeFile(f.output, "FAIL");
    assert.equal((await f.reader.read()).hosts[0].available, true);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 11000);
    const failed = await f.reader.read();
    assert.deepEqual(failed.threads, first.threads);
    assert.equal(failed.hosts[0].available, false);
    assert.match(failed.hosts[0].error!, /SSH authentication failed/);
    await writeFile(f.output, JSON.stringify([row]));
    t.mock.method(Date, "now", () => now + 22000);
    assert.equal((await f.reader.read()).hosts[0].available, true);
  } finally {
    await f.close();
  }
});

test("cached reads return immediately and share background SSH refreshes", async (t) => {
  const f = await fixture();
  try {
    const empty = f.reader.readCached();
    assert.deepEqual(empty, { threads: [], hosts: [] });
    const loading = f.reader.read();
    assert.equal(f.reader.read(), loading);
    assert.equal(f.reader.readCached(), empty);

    const loaded = await loading;
    assert.equal(loaded.threads.length, 1);
    assert.equal(f.reader.readCached(), loaded);

    await writeFile(f.output, JSON.stringify([{ ...row, title: "Updated" }]));
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 11000);
    assert.equal(f.reader.readCached(), loaded);
    const refreshing = f.reader.read();
    assert.notEqual(refreshing, loading);
    assert.equal(f.reader.read(), refreshing);
    assert.equal(f.reader.readCached(), loaded);

    const refreshed = await refreshing;
    assert.equal(refreshed.threads[0].title, "Updated");
    assert.equal(f.reader.readCached(), refreshed);
  } finally {
    await f.close();
  }
});

test("failed background reads keep the last index and can retry", async (t) => {
  const f = await fixture();
  try {
    const loaded = await f.reader.read();
    await writeFile(join(f.home, ".codex-global-state.json"), "{");
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 11000);
    assert.equal(f.reader.readCached(), loaded);
    await assert.rejects(f.reader.read(), SyntaxError);

    await writeFile(
      join(f.home, ".codex-global-state.json"),
      JSON.stringify(f.config),
    );
    assert.equal(f.reader.readCached(), loaded);
    const recovered = await f.reader.read();
    assert.equal(recovered.hosts[0].available, true);
    assert.equal(f.reader.readCached(), recovered);
  } finally {
    await f.close();
  }
});

test("invalid remote rows are reported instead of entering the trusted conversation model", async () => {
  const f = await fixture();
  try {
    await writeFile(f.output, JSON.stringify([{ ...row, id: "invalid" }]));
    const data = await f.reader.read();
    assert.deepEqual(data.threads, []);
    assert.equal(data.hosts[0].available, false);
    assert.match(data.hosts[0].error!, /uuid/i);
  } finally {
    await f.close();
  }
});

test("SSH option-shaped destinations are rejected at the configuration boundary", async () => {
  const f = await fixture();
  try {
    f.config["codex-managed-remote-connections"][0].alias =
      "-oProxyCommand=bad";
    await writeFile(
      join(f.home, ".codex-global-state.json"),
      JSON.stringify(f.config),
    );
    await assert.rejects(
      f.reader.read(),
      /SSH connection|Invalid input|custom/,
    );
    await assert.rejects(readFile(f.args), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
