import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../shared/types";
import { matchesFilters } from "../ui/board-filters";
import {
  cachedSnapshot,
  clearSnapshotCache,
  readSnapshotCache,
  reconcileSnapshot,
  SNAPSHOT_CACHE_KEY,
  writeSnapshotCache,
} from "../ui/snapshot-cache";

/** 模拟宿主重新创建页面后仍可访问的存储，不触碰用户浏览器数据。 */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function snapshot(): Snapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-30T08:00:00.000Z",
    syncingThreads: false,
    connection: {
      state: "connected",
      endpoint: "ipc:///desktop.sock",
      since: "2026-10-30T07:00:00.000Z",
      message: null,
    },
    sources: {
      metadata: true,
      unread: true,
      unreadReason: "客户端记录",
      metadataError: null,
      unreadOptions: [],
      unreadSelection: null,
    },
    threads: [
      {
        id: "conversation",
        title: "现有对话",
        cwd: "/workspace",
        project: "workspace",
        kind: "user",
        updatedAt: "2026-10-30T08:00:00.000Z",
        lastUserMessageAt: "2026-10-30T07:59:00.000Z",
        model: "model",
        reasoningEffort: "high",
        collaborationMode: "plan",
        goalStatus: "active",
        turnUsage: null,
        unread: true,
        runtime: { type: "active", activeFlags: ["waitingOnApproval"] },
        runtimeAt: "2026-10-30T08:00:00.000Z",
        fresh: true,
        error: null,
        pendingUserInput: true,
        waitingQuestion: "PRIVATE_QUESTION",
        waitingSince: "2026-10-30T08:00:00.000Z",
      },
    ],
    confirmations: {
      available: true,
      requests: [
        {
          id: "request",
          threadId: "conversation",
          kind: "command",
          reason: "PRIVATE_REASON",
          command: "PRIVATE_COMMAND",
          cwd: null,
          details: "PRIVATE_DIFF",
          decisions: ["accept"],
          questions: [],
        },
      ],
    },
  };
}

test("a recreated view restores its last successful list as stale without confirmation content", () => {
  const storage = memoryStorage();
  const original = snapshot();
  writeSnapshotCache(storage, original, null);
  const restored = readSnapshotCache({ getItem: storage.getItem }, null)!;
  assert.equal(restored.threads[0].title, "现有对话");
  assert.deepEqual(restored.threads[0].runtime, original.threads[0].runtime);
  assert.equal(restored.threads[0].fresh, false);
  assert.equal(restored.threads[0].cachedColumn, "waiting");
  assert.equal(restored.cached, true);
  assert.equal(restored.threads[0].pendingUserInput, false);
  assert.equal(restored.threads[0].waitingQuestion, null);
  assert.equal(restored.threads[0].waitingSince, null);
  assert.deepEqual(restored.confirmations, { available: false, requests: [] });
  assert.equal(restored.connection.state, "connecting");
  assert.equal(restored.connection.since, null);
  assert.equal(original.threads[0].fresh, true);
  assert.equal(original.confirmations?.requests.length, 1);
  assert.doesNotMatch(storage.getItem(SNAPSHOT_CACHE_KEY)!, /PRIVATE_/);
});

test("temporary empty or unavailable metadata cannot overwrite the successful list", () => {
  const storage = memoryStorage();
  const original = snapshot();
  writeSnapshotCache(storage, original, null);
  writeSnapshotCache(storage, { ...original, threads: [] }, null);
  writeSnapshotCache(
    storage,
    { ...original, sources: { ...original.sources, metadata: false } },
    null,
  );
  assert.equal(readSnapshotCache(storage, null)?.threads[0].title, "现有对话");
  const next = snapshot();
  next.threads[0].title = "最新列表";
  writeSnapshotCache(storage, next, null);
  assert.equal(readSnapshotCache(storage, null)?.threads[0].title, "最新列表");
});

test("cached data only restores for its explicitly selected unread source", () => {
  const storage = memoryStorage();
  writeSnapshotCache(storage, snapshot(), "source-a");
  assert.equal(readSnapshotCache(storage, null), null);
  assert.equal(readSnapshotCache(storage, "source-b"), null);
  assert.equal(readSnapshotCache(storage, "source-a")?.threads.length, 1);
  writeSnapshotCache(storage, snapshot(), "source-b");
  assert.equal(readSnapshotCache(storage, "source-a"), null);
  assert.equal(readSnapshotCache(storage, "source-b")?.threads.length, 1);
});

test("corrupt storage and unusable cache shapes fall back to normal loading", () => {
  const storage = memoryStorage();
  for (const value of [
    "{broken",
    "null",
    '"old-value"',
    JSON.stringify({
      selection: null,
      snapshot: {
        schemaVersion: 1,
        threads: [{}],
        sources: {},
        connection: {},
      },
    }),
  ]) {
    storage.setItem(SNAPSHOT_CACHE_KEY, value);
    assert.equal(readSnapshotCache(storage, null), null);
  }
  assert.equal(
    readSnapshotCache(
      {
        getItem() {
          throw new Error("Blocked storage");
        },
      },
      null,
    ),
    null,
  );
  assert.doesNotThrow(() =>
    writeSnapshotCache(
      {
        setItem() {
          throw new Error("Quota exceeded");
        },
      },
      snapshot(),
      null,
    ),
  );
});

test("stale conversion clears pending actions without modifying the live snapshot", () => {
  const original = snapshot();
  const stale = cachedSnapshot(original);
  assert.notEqual(stale, original);
  assert.notEqual(stale.threads[0], original.threads[0]);
  assert.equal(original.connection.state, "connected");
  assert.equal(original.threads[0].waitingQuestion, "PRIVATE_QUESTION");
  assert.equal(stale.syncingThreads, false);
  assert.equal(stale.connection.message, null);
});

test("an authoritative empty directory can explicitly clear the previous cached list", () => {
  const storage = memoryStorage();
  writeSnapshotCache(storage, snapshot(), null);
  clearSnapshotCache(storage);
  assert.equal(readSnapshotCache(storage, null), null);
  assert.doesNotThrow(() =>
    clearSnapshotCache({
      removeItem() {
        throw new Error("Blocked storage");
      },
    }),
  );
});

test("returning to a running filter retains the known column while its live subscription reconnects", () => {
  const previous = snapshot();
  previous.threads[0].runtime = { type: "active", activeFlags: [] };
  previous.threads[0].pendingUserInput = false;
  const next = snapshot();
  next.threads[0] = {
    ...next.threads[0],
    title: "更新后的标题",
    fresh: false,
    runtime: null,
    runtimeAt: null,
  };
  next.syncingThreads = true;
  const merged = reconcileSnapshot(previous, next);
  assert.equal(merged.cached, true);
  assert.equal(merged.threads[0].cachedColumn, "running");
  assert.equal(matchesFilters(merged.threads[0], { state: ["running"] }), true);
  assert.equal(merged.threads[0].fresh, false);
  assert.equal(merged.threads[0].title, "更新后的标题");
  assert.deepEqual(merged.threads[0].runtime, previous.threads[0].runtime);
  assert.equal(merged.threads[0].runtimeAt, previous.threads[0].runtimeAt);
  assert.equal(merged.syncingThreads, false);
  assert.equal(merged.connection, next.connection);
  assert.deepEqual(merged.confirmations?.requests, []);
});

test("fresh states and explicit unloaded states replace their corresponding cached columns", () => {
  const previous = cachedSnapshot(snapshot());
  const next = snapshot();
  next.threads[0] = {
    ...next.threads[0],
    runtime: { type: "idle" },
    pendingUserInput: false,
  };
  const fresh = reconcileSnapshot(previous, next);
  assert.equal(fresh.cached, false);
  assert.equal(fresh.threads[0].cachedColumn, undefined);
  assert.equal(fresh.threads[0].fresh, true);
  assert.equal(fresh.threads[0].runtime?.type, "idle");
  assert.equal(fresh.confirmations?.requests.length, 1);
  next.threads[0] = {
    ...next.threads[0],
    runtime: { type: "notLoaded" },
    fresh: false,
  };
  const unloaded = reconcileSnapshot(previous, next);
  assert.equal(unloaded.cached, false);
  assert.equal(unloaded.threads[0].cachedColumn, undefined);
  assert.equal(unloaded.threads[0].runtime?.type, "notLoaded");
  assert.deepEqual(unloaded.confirmations?.requests, []);
});

test("metadata failure keeps the previous list and source error but a successful empty directory clears it", () => {
  const previous = snapshot();
  const unavailable = snapshot();
  unavailable.threads = [];
  unavailable.sources = {
    ...unavailable.sources,
    metadata: false,
    metadataError: "目录暂不可读",
  };
  const fallback = reconcileSnapshot(previous, unavailable);
  assert.equal(fallback.threads.length, 1);
  assert.equal(fallback.cached, true);
  assert.equal(fallback.sources.metadataError, "目录暂不可读");
  assert.deepEqual(fallback.confirmations, { available: false, requests: [] });
  const empty = {
    ...unavailable,
    sources: { ...unavailable.sources, metadata: true },
  };
  assert.equal(reconcileSnapshot(previous, empty), empty);
  assert.equal(reconcileSnapshot(null, unavailable), unavailable);
});

test("reconciliation uses conversation identity and never labels previously unknown threads as cached", () => {
  const previous = snapshot();
  previous.threads[0] = { ...previous.threads[0], fresh: false, runtime: null };
  const next = snapshot();
  next.threads[0] = { ...next.threads[0], fresh: false, runtime: null };
  assert.equal(
    reconcileSnapshot(previous, next).threads[0].cachedColumn,
    undefined,
  );
  const old = cachedSnapshot(snapshot());
  next.threads[0] = { ...next.threads[0], id: "different-conversation" };
  assert.equal(reconcileSnapshot(old, next).threads[0].cachedColumn, undefined);
});

test("reconciliation retains only newly verified confirmation requests, never the cached pending action", () => {
  const previous = cachedSnapshot(snapshot());
  const next = snapshot();
  const second = { ...next.threads[0], id: "second", fresh: false };
  next.threads.push(second);
  next.confirmations!.requests.push({
    ...next.confirmations!.requests[0],
    id: "second-request",
    threadId: "second",
  });
  const merged = reconcileSnapshot(previous, next);
  assert.deepEqual(
    merged.confirmations!.requests.map((request) => request.id),
    ["request"],
  );
  next.confirmations = undefined;
  assert.equal(reconcileSnapshot(previous, next).confirmations, undefined);
});
