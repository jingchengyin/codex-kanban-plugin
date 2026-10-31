import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasUnansweredInput,
  inputState,
  unansweredInput,
} from "../server/user-input";

const question = {
  type: "agentMessage",
  id: "question-item",
  questions: [{ title: "PRIVATE_QUESTION" }, { title: "PRIVATE_QUESTION_2" }],
};
const message = {
  type: "userMessage",
  content: [{ type: "text", text: "PRIVATE_USER_INPUT" }],
};
const nextQuestion = { ...question, id: "next-question" };

/** 使用桌面原生的逐题标识和回传正文，不连接真实对话。 */
const questionId = (index: number, itemId = question.id) =>
  JSON.stringify(["request_user_input_async", itemId, index]);
const replyText = (indices: number[], itemId = question.id) => {
  const replies = indices.map((index) => ({
    questionItemId: questionId(index, itemId),
    question: question.questions[index].title,
    answer: "PRIVATE_ANSWER",
  }));
  return `<send_user_message_question_reply>\n${JSON.stringify(indices.length === 1 ? replies[0] : replies)}\n</send_user_message_question_reply>`;
};

test("only messages after a question resolve it, and later questions need input again", () => {
  for (const [items, expected] of [
    [[question], true],
    [[question, message], false],
    [[message, question], true],
    [[question, message, nextQuestion], true],
    [[question, message, nextQuestion, message], false],
    [[{ type: "agentMessage", id: "ordinary", questions: [] }], false],
  ] as [any[], boolean][])
    assert.equal(hasUnansweredInput(inputState("turn", items)), expected);
  assert.equal(hasUnansweredInput(undefined), false);
});

test("ordinary user messages resolve all earlier questions without retaining their content", () => {
  for (const content of [
    message.content,
    [{ type: "image", url: "PRIVATE_IMAGE" }],
    [...message.content, { type: "localImage", path: "PRIVATE_PATH" }],
  ]) {
    const userMessage = { type: "userMessage", content };
    const pending = inputState("turn", [question]);
    const resolved = inputState("turn", [userMessage], pending);
    assert.equal(hasUnansweredInput(resolved), false);
    assert.equal(unansweredInput(resolved), null);
    assert.equal(resolved.pending.size, 0);
    assert.equal(
      hasUnansweredInput(inputState("turn", [question, userMessage])),
      false,
    );
    assert.equal(
      hasUnansweredInput(inputState("turn", [question], resolved)),
      false,
      "a repeated old question does not become pending again",
    );
    assert.equal(
      JSON.stringify([...resolved.questions, ...resolved.answered]).includes(
        "PRIVATE",
      ),
      false,
    );
  }
});

test("a structured reply resolves only its question and preserves other pending questions", () => {
  const pending = inputState("turn", [question]);
  const second = pending.pending.get(questionId(1))!;
  const reply = {
    type: "userMessage",
    content: [{ type: "text", text: replyText([0]) }],
  };
  for (const state of [
    inputState("turn", [reply], pending),
    inputState("turn", [question, reply]),
  ]) {
    assert.equal(hasUnansweredInput(state), true);
    assert.deepEqual([...state.answered], [questionId(0)]);
    assert.deepEqual([...state.pending.keys()], [questionId(1)]);
    assert.equal(unansweredInput(state)?.summary, "PRIVATE_QUESTION_2");
    assert.equal(
      JSON.stringify([...state.pending, ...state.answered]).includes(
        "PRIVATE_ANSWER",
      ),
      false,
    );
    const repeated = inputState("turn", [question], state);
    assert.deepEqual([...repeated.pending.keys()], [questionId(1)]);
  }
  const resolved = inputState("turn", [reply], pending);
  assert.equal(resolved.pending.get(questionId(1)), second);
  assert.equal(unansweredInput(resolved)?.since, second.since);
  assert.equal(inputState("turn", [reply], resolved), resolved);
});

test("batch replies resolve the named questions without clearing other question cards", () => {
  const pending = inputState("turn", [question, nextQuestion]);
  const reply = {
    type: "userMessage",
    content: [{ type: "text", text: replyText([0, 1]) }],
  };
  const resolved = inputState("turn", [reply], pending);
  assert.deepEqual([...resolved.answered], [questionId(0), questionId(1)]);
  assert.deepEqual(
    [...resolved.pending.keys()],
    [questionId(0, nextQuestion.id), questionId(1, nextQuestion.id)],
  );
  assert.equal(hasUnansweredInput(resolved), true);
  const completed = inputState(
    "turn",
    [
      {
        type: "userMessage",
        content: [{ type: "text", text: replyText([0, 1], nextQuestion.id) }],
      },
    ],
    resolved,
  );
  assert.equal(hasUnansweredInput(completed), false);
  assert.equal(unansweredInput(completed), null);
  assert.equal(completed.pending.size, 0);
  assert.equal(
    JSON.stringify([...completed.answered]).includes("PRIVATE_ANSWER"),
    false,
  );
});

test("structured replies work in user content and accepted steering input", () => {
  for (const reply of [
    {
      type: "userMessage",
      content: [{ type: "input_text", text: replyText([0]) }],
    },
    {
      type: "steeringUserMessage",
      status: "accepted",
      input: [{ type: "text", text: replyText([0]) }],
    },
    {
      type: "steeringUserMessage",
      status: "accepted",
      input: [{ type: "input_text", text: replyText([0]) }],
    },
  ]) {
    const resolved = inputState("turn", [question, reply]);
    assert.deepEqual([...resolved.answered], [questionId(0)]);
    assert.deepEqual([...resolved.pending.keys()], [questionId(1)]);
  }
});

test("pending and rejected steering messages cannot resolve a question", () => {
  const pending = inputState("turn", [question]);
  for (const status of ["pending", "rejected"]) {
    for (const text of [replyText([0, 1]), "PRIVATE_USER_INPUT"]) {
      const state = inputState(
        "turn",
        [
          {
            type: "steeringUserMessage",
            status,
            input: [{ type: "text", text }],
          },
        ],
        pending,
      );
      assert.equal(state, pending);
      assert.equal(state.pending.size, 2);
      assert.equal(state.answered.size, 0);
    }
  }
  const accepted = inputState(
    "turn",
    [
      {
        type: "steeringUserMessage",
        status: "accepted",
        input: [{ type: "text", text: "PRIVATE_USER_INPUT" }],
      },
    ],
    pending,
  );
  assert.equal(hasUnansweredInput(accepted), false);
});

test("a structured reply for an unrelated item leaves the pending questions intact", () => {
  const pending = inputState("turn", [question]);
  const resolved = inputState(
    "turn",
    [
      {
        type: "userMessage",
        content: [{ type: "text", text: replyText([0], "unrelated-item") }],
      },
    ],
    pending,
  );
  assert.deepEqual([...resolved.pending.keys()], [...pending.pending.keys()]);
  assert.equal(
    unansweredInput(resolved)?.since,
    unansweredInput(pending)?.since,
  );
});

test("pending summaries use question text, normalize whitespace and never include surrounding messages", () => {
  const state = inputState("turn", [
    {
      ...question,
      text: "PRIVATE_ASSISTANT_BODY",
      questions: [
        { title: "  请选择\n\t发布范围。  ", options: ["PRIVATE_OPTION"] },
        { title: "第二个待答问题" },
      ],
    },
  ]);
  assert.equal(unansweredInput(state)?.summary, "请选择 发布范围。");
  assert.ok(Number.isFinite(Date.parse(unansweredInput(state)!.since)));
  assert.equal(
    JSON.stringify([...state.pending.values()]).includes("PRIVATE"),
    false,
  );
  const answered = inputState("turn", [message], state);
  assert.equal(unansweredInput(answered), null);
  assert.equal(unansweredInput(inputState("turn", [question], answered)), null);
});

test("duplicate and completed question items preserve the wait start and can fill a missing summary", () => {
  const initial = { ...question, questions: [{}] };
  const state = inputState("turn", [initial]);
  const since = unansweredInput(state)!.since;
  assert.equal(unansweredInput(state)?.summary, null);
  assert.equal(inputState("turn", [initial], state), state);
  const completed = inputState(
    "turn",
    [{ ...initial, questions: [{ title: "选择运行环境" }] }],
    state,
  );
  assert.equal(unansweredInput(completed)?.summary, "选择运行环境");
  assert.equal(unansweredInput(completed)?.since, since);
  assert.equal(
    unansweredInput(inputState("turn", [initial], completed))?.summary,
    "选择运行环境",
  );
  assert.equal(
    unansweredInput(inputState("automatic-turn", [], completed))?.since,
    since,
  );
});

test("long Unicode question summaries are bounded without splitting characters", () => {
  const state = inputState("turn", [
    { ...question, questions: [{ title: "🟢".repeat(300) }] },
  ]);
  assert.equal(unansweredInput(state)?.summary, "🟢".repeat(280) + "…");
});

test("assistant final answers, commentary and tool items cannot resolve a question", () => {
  for (const item of [
    {
      type: "agentMessage",
      id: "final",
      phase: "final_answer",
      text: "PRIVATE_RESULT",
      questions: null,
    },
    {
      type: "agentMessage",
      id: "final-empty",
      phase: "final_answer",
      text: "",
    },
    {
      type: "agentMessage",
      id: "progress",
      phase: "commentary",
      text: "PRIVATE_PROGRESS",
    },
    { type: "commandExecution", id: "command" },
    { type: "hookPrompt", id: "hook", text: "PRIVATE_CONTEXT" },
  ]) {
    assert.equal(
      hasUnansweredInput(inputState("turn", [question, item])),
      true,
    );
    assert.equal(
      hasUnansweredInput(
        inputState("turn", [item], inputState("turn", [question])),
      ),
      true,
    );
  }
});

test("automatic turns retain pending questions until a user message arrives", () => {
  const pending = inputState("first-turn", [question]);
  const continued = inputState("automatic-turn", [], pending);
  assert.equal(continued.turnId, "automatic-turn");
  assert.equal(hasUnansweredInput(continued), true);
  const resolved = inputState("user-turn", [message], continued);
  assert.equal(hasUnansweredInput(resolved), false);
  assert.equal(
    hasUnansweredInput(inputState("user-turn", [nextQuestion], resolved)),
    true,
  );
});
