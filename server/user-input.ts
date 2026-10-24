type InputState = {
  turnId: string;
  questions: Set<string>;
  answered: Set<string>;
};

// Retain only question identifiers, never question text or user answers.
export function inputState(
  turnId: string,
  items: any[],
  previous?: InputState,
): InputState {
  if (previous?.turnId !== turnId) previous = undefined;
  const state = {
    turnId,
    questions: new Set(previous?.questions),
    answered: new Set(previous?.answered),
  };
  for (const item of items) {
    if (
      item?.type === "agentMessage" &&
      typeof item.id === "string" &&
      Array.isArray(item.questions)
    )
      item.questions.forEach((_: unknown, index: number) =>
        state.questions.add(
          JSON.stringify(["request_user_input_async", item.id, index]),
        ),
      );
    if (item?.type !== "userMessage" || item.content?.length !== 1) continue;
    const content = item.content[0];
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    const text = content.text.trim();
    const start = "<send_user_message_question_reply>";
    const end = "</send_user_message_question_reply>";
    if (!text.startsWith(start) || !text.endsWith(end)) continue;
    try {
      const value = JSON.parse(text.slice(start.length, -end.length));
      const replies = Array.isArray(value) ? value : [value];
      if (
        replies.every(
          (reply) =>
            typeof reply?.questionItemId === "string" &&
            typeof reply.question === "string" &&
            typeof reply.answer === "string",
        )
      )
        for (const reply of replies) state.answered.add(reply.questionItemId);
    } catch {
      // Ordinary messages and malformed reply envelopes cannot resolve a question.
    }
  }
  return previous &&
    state.questions.size === previous.questions.size &&
    state.answered.size === previous.answered.size
    ? previous
    : state;
}

export function hasUnansweredInput(state: InputState | undefined): boolean {
  return !!state && [...state.questions].some((id) => !state.answered.has(id));
}
