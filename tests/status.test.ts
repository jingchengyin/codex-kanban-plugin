import { test } from "node:test";
import assert from "node:assert/strict";
import {
  belongsToColumn,
  columnFor,
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
