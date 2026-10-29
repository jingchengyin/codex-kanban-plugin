type InputState = {
  turnId: string;
  questions: Set<string>;
  answered: Set<string>;
  pending: Map<string, { summary: string | null; since: string }>;
};

/** 提取结构化问题的简短原文，不使用助手正文、选项或用户答案。 */
function questionSummary(question: any): string | null {
  if (typeof question?.title !== "string") return null;
  const text = question.title.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > 280
    ? characters.slice(0, 280).join("") + "…"
    : text || null;
}

/** 按消息顺序保留未答问题摘要；用户回复后立即清除摘要，保留已答标识。 */
export function inputState(
  turnId: string,
  items: any[],
  previous?: InputState,
): InputState {
  const state = {
    turnId,
    questions: new Set(previous?.questions),
    answered: new Set(previous?.answered),
    pending: new Map(previous?.pending),
  };
  for (const item of items) {
    if (
      item?.type === "agentMessage" &&
      typeof item.id === "string" &&
      Array.isArray(item.questions)
    )
      item.questions.forEach((question: unknown, index: number) => {
        const id = JSON.stringify(["request_user_input_async", item.id, index]);
        state.questions.add(id);
        if (state.answered.has(id)) return;
        const known = state.pending.get(id);
        const summary = questionSummary(question) ?? known?.summary ?? null;
        if (!known || known.summary !== summary)
          state.pending.set(id, {
            summary,
            since: known?.since ?? new Date().toISOString(),
          });
      });
    // 用户发出任意消息后，此前问题不再待答；助手消息不能清除待答状态。
    if (item?.type === "userMessage") {
      for (const id of state.questions) state.answered.add(id);
      state.pending.clear();
    }
  }
  return previous &&
    previous.turnId === turnId &&
    state.questions.size === previous.questions.size &&
    state.answered.size === previous.answered.size &&
    state.pending.size === previous.pending.size &&
    [...state.pending].every(
      ([id, value]) => previous.pending.get(id) === value,
    )
    ? previous
    : state;
}

/** 返回最早未答问题的观察时间和第一条可读摘要。 */
export function unansweredInput(state: InputState | undefined): {
  since: string;
  summary: string | null;
} | null {
  const pending = [...(state?.pending.values() ?? [])];
  if (!pending.length) return null;
  return {
    since: pending.map((question) => question.since).sort()[0],
    summary: pending.find((question) => question.summary)?.summary ?? null,
  };
}

/** 判断是否仍有晚于最近用户消息的异步提问。 */
export function hasUnansweredInput(state: InputState | undefined): boolean {
  return !!state && [...state.questions].some((id) => !state.answered.has(id));
}
