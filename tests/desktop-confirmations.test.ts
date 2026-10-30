import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopConfirmations } from "../server/desktop-confirmations";
import type { DesktopConversation } from "../server/desktop-ipc";
import type { ConfirmationReply } from "../shared/confirmations";

const params = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  command: "printf ready",
  cwd: "/work",
  reason: "Check the selected command",
};
const command = (id: number | string = 0, extra = {}) => ({
  method: "item/commandExecution/requestApproval",
  id,
  params: { ...params, ...extra },
});

/** 隔离的原 owner 缓存，测试不连接真实桌面或执行任何命令。 */
function fixture(requests: any[], state = {}) {
  const conversations = new Map<string, DesktopConversation>([
    [
      "thread",
      { ownerClientId: "owner", revision: 1, state: { requests, ...state } },
    ],
  ]);
  const sent: { threadId: string; method: string; params: any }[] = [];
  let onSend = async () => {
    conversations.get("thread")!.state.requests = [];
    return { ok: true };
  };
  const ipc = {
    get: (threadId: string) => conversations.get(threadId),
    requestOwner: async (threadId: string, method: string, input: object) => {
      sent.push({ threadId, method, params: input });
      return onSend();
    },
  };
  const confirmations = new DesktopConfirmations(ipc, 40);
  confirmations.update("thread", conversations.get("thread")!);
  return {
    confirmations,
    conversations,
    sent,
    onSend: (action: typeof onSend) => {
      onSend = action;
    },
    first: () => confirmations.read().requests[0],
  };
}

test("native command replies preserve original ID zero, offered choices and stable UI IDs", async () => {
  const f = fixture([
    command(0, {
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: {} },
        "decline",
      ],
    }),
  ]);
  const pending = f.first();
  assert.equal(f.first().id, pending.id);
  assert.match(pending.id, /^[0-9a-f-]{36}$/);
  assert.equal(pending.command, "printf ready");
  assert.deepEqual(pending.decisions, ["accept", "decline"]);
  assert.deepEqual(f.sent, []);
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "cancel",
    }),
    /内容无效/,
  );
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "other",
      decision: "accept",
    }),
    /已处理或已失效/,
  );
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "acceptForSession",
    } as unknown as ConfirmationReply),
  );
  assert.deepEqual(
    await f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "accept",
    }),
    { submitted: true },
  );
  assert.deepEqual(f.sent, [
    {
      threadId: "thread",
      method: "thread-follower-command-approval-decision",
      params: { conversationId: "thread", requestId: 0, decision: "accept" },
    },
  ]);
  assert.equal(f.confirmations.read().requests.length, 0);
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "accept",
    }),
    /已处理或已失效/,
  );
});

test("desktop removal, changed requests and owner changes immediately invalidate old buttons", async () => {
  for (const invalidate of [
    (state: DesktopConversation) => {
      state.state.requests = [];
    },
    (state: DesktopConversation) => {
      state.ownerClientId = "replacement";
    },
    (state: DesktopConversation) => {
      state.state.requests[0].params.command = "printf changed";
    },
  ]) {
    const f = fixture([command()]);
    const pending = f.first();
    invalidate(f.conversations.get("thread")!);
    await assert.rejects(
      f.confirmations.reply({
        id: pending.id,
        threadId: "thread",
        decision: "accept",
      }),
      /已处理或已失效/,
    );
    assert.deepEqual(f.sent, []);
  }
  const f = fixture([command()]);
  const pending = f.first();
  f.conversations.delete("thread");
  assert.equal(f.confirmations.read().available, false);
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "decline",
    }),
    /已处理或已失效/,
  );
});

test("file previews work with normal and canonical history and block acceptance without a diff", async () => {
  const turn = {
    turnId: "turn",
    items: [
      {
        id: "item",
        type: "fileChange",
        changes: [{ path: "/work/file.ts", diff: "-old\n+new" }],
      },
    ],
  };
  for (const history of [
    { turns: [turn] },
    {
      turns: [],
      turnHistory: {
        kind: "canonical",
        history: { entitiesByKey: { "turn:turn": turn } },
      },
    },
  ]) {
    const f = fixture(
      [{ method: "item/fileChange/requestApproval", id: "file", params }],
      history,
    );
    const pending = f.first();
    assert.match(pending.details!, /\/work\/file.ts\n-old\n\+new/);
    assert.ok(pending.decisions.includes("accept"));
    await f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "decline",
    });
    assert.equal(f.sent[0].method, "thread-follower-file-approval-decision");
    assert.equal(f.sent[0].params.requestId, "file");
  }
  const f = fixture([
    { method: "item/fileChange/requestApproval", id: "file", params },
  ]);
  assert.equal(f.first().decisions.includes("accept"), false);
  await assert.rejects(
    f.confirmations.reply({
      id: f.first().id,
      threadId: "thread",
      decision: "accept",
    }),
    /内容无效/,
  );
  assert.deepEqual(f.sent, []);
});

test("native structured answers require all questions and offered options", async () => {
  const f = fixture([
    {
      id: "questions",
      method: "item/tool/requestUserInput",
      params: {
        ...params,
        questions: [
          {
            id: "a",
            question: "Where?",
            options: [{ label: "Local", description: "Current machine" }],
          },
          { id: "b", question: "Name?", isSecret: true, options: null },
        ],
      },
    },
  ]);
  const pending = f.first();
  assert.equal(pending.questions[1].isSecret, true);
  assert.equal(pending.questions[1].allowOther, true);
  const invalidAnswers: Record<string, { answers: string[] }>[] = [
    { a: { answers: ["Local"] } },
    { a: { answers: ["Unknown"] }, b: { answers: ["v1"] } },
    { a: { answers: ["Local"] }, b: { answers: [" "] } },
  ];
  for (const answers of invalidAnswers)
    await assert.rejects(
      f.confirmations.reply({ id: pending.id, threadId: "thread", answers }),
      /内容无效/,
    );
  const answers = { a: { answers: ["Local"] }, b: { answers: ["v1"] } };
  await f.confirmations.reply({ id: pending.id, threadId: "thread", answers });
  assert.deepEqual(f.sent, [
    {
      threadId: "thread",
      method: "thread-follower-submit-user-input",
      params: {
        conversationId: "thread",
        requestId: "questions",
        response: { answers },
      },
    },
  ]);
});

test("routing acknowledgement alone cannot mark a request submitted or allow a second send", async () => {
  const f = fixture([command()]);
  f.onSend(async () => ({ ok: true }));
  const pending = f.first();
  const input = {
    id: pending.id,
    threadId: "thread",
    decision: "accept",
  } as const;
  const sending = f.confirmations.reply(input);
  await assert.rejects(f.confirmations.reply(input), /已处理或已失效/);
  await assert.rejects(sending, /结果尚未同步/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.confirmations.read().requests.length, 0);
});

test("wait for a later removal and reject disconnect, replacement owner or routing failure", async () => {
  const f = fixture([command()]);
  f.onSend(async () => {
    setTimeout(() => {
      f.conversations.get("thread")!.state.requests = [];
    }, 5);
    return { ok: true };
  });
  assert.deepEqual(
    await f.confirmations.reply({
      id: f.first().id,
      threadId: "thread",
      decision: "accept",
    }),
    { submitted: true },
  );
  for (const change of [
    (g: ReturnType<typeof fixture>) => {
      g.conversations.delete("thread");
    },
    (g: ReturnType<typeof fixture>) => {
      g.conversations.get("thread")!.ownerClientId = "new-owner";
    },
    (g: ReturnType<typeof fixture>) => {
      g.confirmations.remove("thread");
    },
  ]) {
    const g = fixture([command()]);
    g.onSend(async () => {
      change(g);
      return { ok: true };
    });
    await assert.rejects(
      g.confirmations.reply({
        id: g.first().id,
        threadId: "thread",
        decision: "decline",
      }),
      /已处理或已失效/,
    );
  }
  const g = fixture([command()]);
  g.onSend(async () => {
    throw new Error("Disconnected");
  });
  const pending = g.first();
  await assert.rejects(
    g.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "accept",
    }),
    /核对结果/,
  );
  await assert.rejects(
    g.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "accept",
    }),
    /已处理或已失效/,
  );
  assert.equal(g.sent.length, 1);
});

test("unsupported requests stay in the original conversation and clearing invalidates all IDs", () => {
  const f = fixture([
    { method: "item/permissions/requestApproval", id: 2, params },
    command(3, { kind: "writeStdin" }),
    command(4, { threadId: "other" }),
  ]);
  assert.deepEqual(f.confirmations.read(), { available: true, requests: [] });
  f.confirmations.clear();
  assert.deepEqual(f.confirmations.read(), { available: false, requests: [] });
});
