import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUnansweredInput, inputState } from "../server/user-input";

const question = {
  type: "agentMessage",
  id: "question-item",
  questions: [{ title: "PRIVATE_QUESTION" }, { title: "PRIVATE_QUESTION_2" }],
};
const questionId = (index: number) =>
  JSON.stringify(["request_user_input_async", question.id, index]);
const reply = (value: unknown) => ({
  type: "userMessage",
  content: [
    {
      type: "text",
      text: `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`,
    },
  ],
});
const answer = (index: number) => ({
  questionItemId: questionId(index),
  question: "PRIVATE_QUESTION",
  answer: "PRIVATE_ANSWER",
});

test("async questions require a submitted reply for each question, including empty answers, without retaining content", () => {
  const pending = inputState("turn", [question]);
  assert.equal(hasUnansweredInput(pending), true);
  const partial = inputState("turn", [reply(answer(0))], pending);
  assert.equal(hasUnansweredInput(partial), true);
  const resolved = inputState(
    "turn",
    [reply({ ...answer(1), answer: "" })],
    partial,
  );
  assert.equal(hasUnansweredInput(resolved), false);
  assert.equal(
    hasUnansweredInput(inputState("turn", [question], resolved)),
    false,
  );
  assert.deepEqual([...resolved.questions], [questionId(0), questionId(1)]);
  assert.equal(
    JSON.stringify([...resolved.questions, ...resolved.answered]).includes(
      "PRIVATE",
    ),
    false,
  );
  assert.equal(hasUnansweredInput(undefined), false);
});

test("hydration handles reply arrays and out-of-order items; unrelated or malformed messages cannot clear questions", () => {
  assert.equal(
    hasUnansweredInput(
      inputState("turn", [reply([answer(0), answer(1)]), question]),
    ),
    false,
  );
  for (const item of [
    { type: "userMessage", content: [{ type: "text", text: "普通回复" }] },
    reply({ ...answer(0), questionItemId: "another-question" }),
    reply({ ...answer(0), answer: null }),
    {
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "<send_user_message_question_reply>invalid</send_user_message_question_reply>",
        },
      ],
    },
  ])
    assert.equal(
      hasUnansweredInput(inputState("turn", [question, item])),
      true,
    );
  assert.equal(
    hasUnansweredInput(
      inputState("turn", [
        { type: "agentMessage", id: "ordinary", questions: [] },
      ]),
    ),
    false,
  );
});
