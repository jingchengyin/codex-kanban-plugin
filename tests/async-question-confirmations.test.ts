import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopConfirmations } from "../server/desktop-confirmations";
import type { DesktopConversation } from "../server/desktop-ipc";
import type { ConfirmationReply } from "../shared/confirmations";

const item = {
  id: "async-question-item",
  type: "agentMessage",
  questions: [
    {
      title: "What would you like help with?",
      options: ["Fix a bug", "Explore"],
    },
    { title: "What result would you like?" },
  ],
};
const questionId = (index: number) =>
  JSON.stringify(["request_user_input_async", item.id, index]);
const answers = {
  [questionId(0)]: { answers: ["Add async clarification replies"] },
  [questionId(1)]: { answers: ["Working code\nwith regression tests"] },
};

/** 构造原生问题回复正文，作为回传与桌面回显的独立协议样本。 */
function replyText(indices = [0, 1]) {
  return `<send_user_message_question_reply>\n${JSON.stringify(
    indices.map((index) => ({
      questionItemId: questionId(index),
      question: item.questions[index].title,
      answer: answers[questionId(index)].answers[0],
    })),
  )}\n</send_user_message_question_reply>`;
}

/** 隔离桌面 owner 与消息回显，不连接实际桌面或启动模型回合。 */
function fixture(state: any = {}) {
  const conversation: DesktopConversation = {
    ownerClientId: "original-owner",
    revision: 1,
    state: {
      cwd: "/work/kanban",
      requests: [],
      threadRuntimeStatus: { type: "idle" },
      turns: [{ turnId: "question-turn", status: "completed", items: [item] }],
      ...state,
    },
  };
  const conversations = new Map([["thread", conversation]]);
  const sent: { threadId: string; method: string; params: any }[] = [];
  let onSend = async () => ({ ok: true });
  const confirmations = new DesktopConfirmations(
    {
      get: (id: string) => conversations.get(id),
      requestOwner: async (
        threadId: string,
        method: string,
        params: object,
      ) => {
        sent.push({ threadId, method, params });
        return onSend();
      },
    },
    50,
  );
  confirmations.update("thread", conversation);
  return {
    confirmations,
    conversation,
    conversations,
    sent,
    onSend: (next: typeof onSend) => {
      onSend = next;
    },
    first: () => confirmations.read().requests[0],
    echo(type = "userMessage", status?: string, text = replyText()) {
      conversation.state.turns.push({
        turnId: "reply-turn",
        items: [
          {
            id: "reply-message",
            type,
            ...(status ? { status } : {}),
            [type === "steeringUserMessage" ? "input" : "content"]: [
              { type: "text", text },
            ],
          },
        ],
      });
      conversation.revision++;
    },
  };
}

test("async clarification cards combine questions and preserve IDs, options and free answers", () => {
  const f = fixture();
  const pending = f.first();
  assert.ok(pending, "An unanswered async clarification needs an answer form");
  assert.equal(pending.kind, "asyncUserInput");
  assert.equal(f.confirmations.read().requests.length, 1);
  assert.equal(f.first().id, pending.id);
  assert.match(pending.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(pending.decisions, []);
  assert.deepEqual(pending.questions, [
    {
      id: questionId(0),
      question: item.questions[0].title,
      isSecret: false,
      allowOther: true,
      options: [
        { label: "Fix a bug", description: "" },
        { label: "Explore", description: "" },
      ],
    },
    {
      id: questionId(1),
      question: item.questions[1].title,
      isSecret: false,
      allowOther: true,
      options: [],
    },
  ]);
  assert.equal(f.sent.length, 0);
});

test("async questions merge ordered canonical history with sparse live turns", () => {
  const f = fixture({
    turnHistory: {
      kind: "canonical",
      history: {
        entitiesByKey: {
          first: { turnId: "question-turn", items: [item] },
        },
        islands: [{ entries: [{ value: "first" }] }],
      },
    },
    turns: [
      {
        turnId: "question-turn",
        status: "completed",
        items: [{ id: "assistant-tail", type: "agentMessage", text: "Ready." }],
      },
    ],
  });
  assert.ok(f.first());
  assert.deepEqual(
    f.first().questions.map((question) => question.id),
    [questionId(0), questionId(1)],
  );
  f.echo();
  assert.deepEqual(f.confirmations.read().requests, []);
});

test("async answers require every question but allow custom multiline text with options", async () => {
  const f = fixture();
  const pending = f.first();
  assert.ok(pending);
  for (const invalid of [
    { [questionId(0)]: answers[questionId(0)] },
    { ...answers, [questionId(1)]: { answers: [" \n "] } },
    { ...answers, unrelated: { answers: ["extra"] } },
  ]) {
    await assert.rejects(
      f.confirmations.reply({
        id: pending.id,
        threadId: "thread",
        answers: invalid,
      }),
      /内容无效/,
    );
  }
  await assert.rejects(
    f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      decision: "accept",
    }),
    /内容无效/,
  );
  assert.equal(f.sent.length, 0);
  f.onSend(async () => {
    f.echo();
    return { ok: true };
  });
  assert.deepEqual(
    await f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      answers,
    }),
    { submitted: true },
  );
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].threadId, "thread");
  assert.equal(f.sent[0].method, "thread-follower-start-turn");
  const sent = f.sent[0].params;
  assert.equal(sent.conversationId, "thread");
  assert.equal(sent.turnStart.request.threadId, "thread");
  assert.equal(
    sent.turnStart.request.turnTrigger,
    "send_user_message_async_question",
  );
  assert.deepEqual(sent.turnStart.request.input, [
    { type: "text", text: replyText(), text_elements: [] },
  ]);
  assert.equal(sent.turnStart.context.inheritThreadSettings, true);
  assert.deepEqual(f.confirmations.read().requests, []);
  await assert.rejects(
    f.confirmations.reply({ id: pending.id, threadId: "thread", answers }),
    /已处理或已失效/,
  );
});

test("desktop answers, owner changes and changed questions invalidate async card submissions", async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.echo(),
    (f: ReturnType<typeof fixture>) => {
      f.conversation.ownerClientId = "replacement-owner";
    },
    (f: ReturnType<typeof fixture>) => {
      f.conversation.state.turns[0].items = [
        { ...item, questions: [{ title: "A different question" }] },
      ];
    },
    (f: ReturnType<typeof fixture>) => {
      f.conversations.delete("thread");
    },
  ]) {
    const f = fixture();
    const pending = f.first();
    assert.ok(pending);
    invalidate(f);
    await assert.rejects(
      f.confirmations.reply({ id: pending.id, threadId: "thread", answers }),
      /已处理或已失效/,
    );
    assert.equal(f.sent.length, 0);
  }
});

test("async routing acknowledgement alone neither confirms delivery nor allows a duplicate", async () => {
  const f = fixture();
  const pending = f.first();
  assert.ok(pending);
  const input: ConfirmationReply = {
    id: pending.id,
    threadId: "thread",
    answers,
  };
  const sending = f.confirmations.reply(input);
  await assert.rejects(f.confirmations.reply(input), /已处理或已失效/);
  await assert.rejects(sending, /结果尚未同步/);
  await assert.rejects(f.confirmations.reply(input), /已处理或已失效/);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.confirmations.read().requests, []);
});

test("a partial question reply cannot confirm that every submitted answer was received", async () => {
  for (const [type, status] of [
    ["userMessage", undefined],
    ["steeringUserMessage", "accepted"],
  ]) {
    const f = fixture();
    const pending = f.first();
    assert.ok(pending);
    f.onSend(async () => {
      f.echo(type, status, replyText([0]));
      return { ok: true };
    });
    await assert.rejects(
      f.confirmations.reply({
        id: pending.id,
        threadId: "thread",
        answers,
      }),
      /结果尚未同步/,
    );
    assert.equal(f.sent.length, 1);
    assert.deepEqual(
      f.first().questions.map((question) => question.id),
      [questionId(1)],
    );
  }
});

test("async answers steer an active original turn without starting another turn", async () => {
  const f = fixture({
    threadRuntimeStatus: { type: "active", activeFlags: [] },
  });
  const pending = f.first();
  assert.ok(pending);
  f.onSend(async () => {
    f.echo("steeringUserMessage", "accepted");
    return { ok: true };
  });
  assert.deepEqual(
    await f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      answers,
    }),
    { submitted: true },
  );
  assert.equal(f.sent.length, 1);
  const sent = f.sent[0];
  assert.equal(sent.method, "thread-follower-steer-turn");
  assert.equal(sent.params.conversationId, "thread");
  assert.deepEqual(sent.params.input, [
    { type: "text", text: replyText(), text_elements: [] },
  ]);
});

test("async answers wait for accepted steering instead of an unaccepted pending message", async () => {
  const f = fixture();
  const pending = f.first();
  assert.ok(pending);
  f.echo("steeringUserMessage", "pending");
  assert.equal(f.first().id, pending.id);
  f.onSend(async () => {
    setTimeout(() => {
      f.conversation.state.turns[1].items[0].status = "accepted";
      f.conversation.revision++;
    }, 5);
    return { ok: true };
  });
  assert.deepEqual(
    await f.confirmations.reply({
      id: pending.id,
      threadId: "thread",
      answers,
    }),
    { submitted: true },
  );
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.confirmations.read().requests, []);
});
