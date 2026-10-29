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

test("any user message resolves all earlier questions without retaining its content", () => {
  for (const content of [
    message.content,
    [{ type: "image", url: "PRIVATE_IMAGE" }],
    [...message.content, { type: "localImage", path: "PRIVATE_PATH" }],
    [
      {
        type: "text",
        text: `<send_user_message_question_reply>${JSON.stringify({
          questionItemId: JSON.stringify([
            "request_user_input_async",
            question.id,
            0,
          ]),
          question: "PRIVATE_QUESTION",
          answer: "PRIVATE_ANSWER",
        })}</send_user_message_question_reply>`,
      },
    ],
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
