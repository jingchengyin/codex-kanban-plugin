import { test } from "node:test";
import assert from "node:assert/strict";
import {
  belongsToColumn,
  columnFor,
  compareByLastUserMessage,
  type BoardColumn,
  type Thread,
} from "../shared/types";
import { displayTitle, parseUnread } from "../server/local-data";
import { localEndpoint } from "../server/status-bridge";

const thread: Thread = {
  id: "test",
  title: "test",
  cwd: "",
  project: "",
  updatedAt: "",
  lastUserMessageAt: null,
  kind: "user",
  unread: null,
  model: null,
  reasoningEffort: null,
  collaborationMode: null,
  goalStatus: null,
  turnUsage: null,
  runtime: { type: "active", activeFlags: [] },
  runtimeAt: "",
  fresh: true,
  error: null,
};
test("recent sorting uses user messages, ignores runtime updates, and keeps unknown times last", () => {
  const threads: Thread[] = [
    { ...thread, id: "unknown-b", updatedAt: "2026-10-26T12:00:00Z" },
    {
      ...thread,
      id: "older-message",
      updatedAt: "2026-10-26T12:00:00Z",
      lastUserMessageAt: "2026-10-26T10:00:00.000Z",
    },
    {
      ...thread,
      id: "latest-message-b",
      updatedAt: "2026-10-26T11:00:00Z",
      lastUserMessageAt: "2026-10-26T11:00:00.000Z",
    },
    { ...thread, id: "unknown-a" },
    {
      ...thread,
      id: "latest-message-a",
      updatedAt: "2026-10-26T11:00:00Z",
      lastUserMessageAt: "2026-10-26T11:00:00.000Z",
    },
  ];
  const expected = [
    "latest-message-a",
    "latest-message-b",
    "older-message",
    "unknown-a",
    "unknown-b",
  ];
  assert.deepEqual(
    threads.sort(compareByLastUserMessage).map((t) => t.id),
    expected,
  );
  assert.deepEqual(
    threads
      .map((t) => ({ ...t, updatedAt: "2026-10-26T13:00:00Z" }))
      .reverse()
      .sort(compareByLastUserMessage)
      .map((t) => t.id),
    expected,
  );
});
test("display titles prefer user names and strip attachment wrappers from fallback labels", () => {
  assert.equal(displayTitle("自定义名称", "initial prompt"), "自定义名称");
  assert.equal(
    displayTitle(
      null,
      "# Files mentioned by the user:\n/private/secret.png\n## My request:\n优化目录交互",
    ),
    "优化目录交互",
  );
  assert.equal(
    displayTitle(
      null,
      "[https://example.com](https://example.com)\n解释这个项目",
    ),
    "解释这个项目",
  );
  assert.ok(displayTitle(null, "字".repeat(300)).length <= 121);
  assert.equal(
    displayTitle(null, 'API_KEY="sensitive-value"'),
    'API_KEY="[已隐藏凭据]"',
  );
  assert.equal(
    displayTitle(null, "sk-privateexamplekey123456"),
    "[已隐藏凭据]",
  );
});
test("waiting flags have precedence over ordinary active, idle is not a completion claim", () => {
  assert.equal(columnFor(thread), "running");
  assert.equal(
    columnFor({
      ...thread,
      runtime: { type: "active", activeFlags: ["waitingOnApproval"] },
    }),
    "waiting",
  );
  assert.equal(
    columnFor({
      ...thread,
      runtime: { type: "active", activeFlags: ["waitingOnUserInput"] },
    }),
    "waiting",
  );
  assert.equal(columnFor({ ...thread, runtime: { type: "idle" } }), "idle");
});
test("stale, absent and unloaded runtime never become idle or thread failures", () => {
  for (const value of [
    { ...thread, fresh: false },
    { ...thread, runtime: null },
    { ...thread, runtime: { type: "notLoaded" as const } },
  ])
    assert.equal(columnFor(value), "unknown");
  assert.equal(
    columnFor({ ...thread, runtime: { type: "systemError" } }),
    "error",
  );
  assert.equal(
    columnFor({ ...thread, error: { message: "failed", at: "" } }),
    "error",
  );
});
test("unanswered async dialogs need attention even when the native thread is idle", () => {
  const pending: Thread = {
    ...thread,
    unread: true,
    pendingUserInput: true,
    runtime: { type: "idle" },
  };
  assert.equal(columnFor(pending), "waiting");
  assert.equal(belongsToColumn(pending, "waiting"), true);
  assert.equal(belongsToColumn(pending, "unread"), false);
  assert.equal(columnFor({ ...pending, pendingUserInput: false }), "idle");
  assert.equal(columnFor({ ...pending, fresh: false }), "unknown");
  assert.equal(
    columnFor({ ...pending, runtime: { type: "notLoaded" } }),
    "unknown",
  );
});
test("unread ambiguity remains unknown; multiple identities or hosts are never merged", () => {
  const state = (accounts: object) => ({
    "electron-thread-read-state-v1": { unreadByIdentity: accounts },
  });
  assert.deepEqual(
    [...parseUnread(state({ a: { "local:x": ["one"] } })).ids!],
    ["one"],
  );
  assert.equal(
    parseUnread(state({ a: { "local:x": [] }, b: { "local:y": [] } })).ids,
    null,
  );
  assert.equal(
    parseUnread(state({ a: { "local:x": [], "local:y": [] } })).ids,
    null,
  );
  assert.equal(parseUnread(state({ a: { "remote:x": [] } })).ids, null);
  assert.equal(parseUnread(state({ a: { "local:x": [8] } })).ids, null);
  const multiple = state({ a: { "local:x": ["one"], "local:y": ["two"] } });
  assert.deepEqual(
    [...parseUnread(multiple, JSON.stringify(["a", "local:y"])).ids!],
    ["two"],
  );
  assert.equal(
    parseUnread(multiple, JSON.stringify(["different-account", "local:y"])).ids,
    null,
  );
});
test("unread automatic selection reuses ordinary startup records and preserves explicit selections", () => {
  const ordinaryHost =
    "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c";
  const sharedHost =
    "local:7dc900dd6a290203089e04146af2bfd891d16d31297f87dd05c8ff68065a145f";
  const cases = [
    {
      ordinary: Array.from({ length: 118 }, (_, i) => `ordinary-${i}`),
      shared: [],
    },
    { ordinary: [], shared: ["shared-only"] },
    { ordinary: ["ordinary-only"], shared: ["shared-only"] },
  ];
  for (const { ordinary, shared } of cases) {
    const state = {
      "electron-thread-read-state-v1": {
        unreadByIdentity: {
          account: { [sharedHost]: shared, [ordinaryHost]: ordinary },
        },
      },
    };
    const automatic = parseUnread(state);
    assert.deepEqual([...automatic.ids!], ordinary);
    assert.deepEqual(
      automatic.options.map(({ count }) => count),
      [shared.length, ordinary.length],
    );
    assert.deepEqual(
      [...parseUnread(state, JSON.stringify(["account", sharedHost])).ids!],
      shared,
    );
    assert.equal(
      parseUnread(state, JSON.stringify(["account", "local:missing"])).ids,
      null,
    );
  }
});
test("ordinary startup unread records do not bypass account or format checks", () => {
  const ordinaryHost =
    "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c";
  const state = (accounts: object) => ({
    "electron-thread-read-state-v1": { unreadByIdentity: accounts },
  });
  assert.equal(
    parseUnread(
      state({ a: { [ordinaryHost]: ["one"] }, b: { "local:y": ["two"] } }),
    ).ids,
    null,
  );
  assert.equal(
    parseUnread(state({ a: { [ordinaryHost]: [8], "local:y": ["two"] } })).ids,
    null,
  );
});
test("unread idle conversations move to unread and return to idle when read", () => {
  const unread: Thread = { ...thread, unread: true, runtime: { type: "idle" } };
  assert.equal(belongsToColumn(unread, "unread"), true);
  assert.equal(belongsToColumn(unread, "idle"), false);
  const read = { ...unread, unread: false };
  assert.equal(belongsToColumn(read, "unread"), false);
  assert.equal(belongsToColumn(read, "idle"), true);
  assert.equal(belongsToColumn({ ...unread, unread: null }, "idle"), true);
  const unloaded = { ...unread, runtime: null };
  assert.equal(belongsToColumn(unloaded, "unread"), true);
  assert.equal(belongsToColumn(unloaded, "unknown"), false);
  assert.equal(
    belongsToColumn({ ...unloaded, unread: false }, "unknown"),
    true,
  );
});
test("waiting, running and error conversations keep priority over unread", () => {
  const cases: [NonNullable<Thread["runtime"]>, BoardColumn][] = [
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "waiting"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "waiting"],
    [{ type: "active", activeFlags: [] }, "running"],
    [{ type: "systemError" }, "error"],
  ];
  for (const [runtime, expected] of cases) {
    const value: Thread = { ...thread, unread: true, runtime };
    assert.equal(belongsToColumn(value, expected), true);
    assert.equal(belongsToColumn(value, "unread"), false);
  }
  const failed = {
    ...thread,
    unread: true,
    error: { message: "failed", at: "" },
  };
  assert.equal(belongsToColumn(failed, "error"), true);
  assert.equal(belongsToColumn(failed, "unread"), false);
});
test("every conversation belongs to exactly one board column", () => {
  const columns: BoardColumn[] = [
    "waiting",
    "running",
    "unread",
    "idle",
    "error",
    "unknown",
  ];
  const statuses: Thread["runtime"][] = [
    null,
    { type: "active", activeFlags: [] },
    { type: "active", activeFlags: ["waitingOnApproval"] },
    { type: "active", activeFlags: ["waitingOnUserInput"] },
    { type: "idle" },
    { type: "notLoaded" },
    { type: "systemError" },
  ];
  for (const unread of [true, false, null])
    for (const fresh of [true, false])
      for (const runtime of statuses)
        for (const error of [null, { message: "failed", at: "" }]) {
          const value = { ...thread, unread, fresh, runtime, error };
          assert.equal(
            columns.filter((column) => belongsToColumn(value, column)).length,
            1,
          );
        }
});
test("state observer refuses nonlocal endpoints and embedded credentials", () => {
  assert.equal(localEndpoint("ws://127.0.0.1:19429"), "ws://127.0.0.1:19429/");
  for (const endpoint of [
    "ws://example.com",
    "wss://127.0.0.1",
    "ws://user:pass@127.0.0.1",
    "ws://127.0.0.1/private",
    "ws://127.0.0.1/?token=secret",
  ])
    assert.throws(() => localEndpoint(endpoint));
});
