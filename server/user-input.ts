type InputState = {
  turnId: string;
  questions: Set<string>;
  answered: Set<string>;
  pending: Map<string, { summary: string | null; since: string }>;
};

/** 合并桌面历史与实时尾部，保持回合及消息顺序。 */
export function desktopTurns(state: any): any[] {
  const turns: any[] = Array.isArray(state.turns) ? state.turns : [];
  const history = state.turnHistory?.history;
  const ordered: any[] = Array.isArray(history?.islands)
    ? history.islands.flatMap((island: any) =>
        (island.entries ?? [])
          .map((entry: any) => history.entitiesByKey?.[entry.value])
          .filter(Boolean),
      )
    : [];
  const byId = new Map<string, any>();
  for (const turn of [...ordered, ...turns]) {
    const key = turn?.turnId ?? turn?.id;
    if (typeof key !== "string") continue;
    const previous = byId.get(key);
    // 实时尾部可能缺少早先的问题，按消息 ID 补齐 canonical 中已有内容。
    const items = new Map<unknown, any>();
    for (const item of [...(previous?.items ?? []), ...(turn.items ?? [])])
      items.set(item?.id ?? item, item);
    byId.set(key, { ...previous, ...turn, items: [...items.values()] });
  }
  return [...byId.values()];
}

/** 提取结构化问题的简短原文，不使用助手正文、选项或用户答案。 */
function questionSummary(question: any): string | null {
  if (typeof question?.title !== "string") return null;
  const text = question.title.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > 280
    ? characters.slice(0, 280).join("") + "…"
    : text || null;
}

/** 只提取桌面结构化回复中的问题标识，不保存用户答案正文。 */
function repliedQuestionIds(item: any): Set<string> | null {
  const content =
    item.type === "steeringUserMessage" ? item.input : item.content;
  const ids = new Set<string>();
  for (const part of Array.isArray(content) ? content : []) {
    if (typeof part?.text !== "string") continue;
    const match =
      /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(
        part.text,
      );
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      const replies = Array.isArray(value) ? value : [value];
      if (
        replies.length &&
        replies.every(
          (reply) =>
            typeof reply?.questionItemId === "string" &&
            typeof reply.question === "string" &&
            typeof reply.answer === "string",
        )
      )
        for (const reply of replies) ids.add(reply.questionItemId);
    } catch {
      // 非结构化正文继续按普通用户消息处理。
    }
  }
  return ids.size ? ids : null;
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
    // 结构化答案逐题解除；普通新消息沿用现有整组解除规则。
    if (
      item?.type === "userMessage" ||
      (item?.type === "steeringUserMessage" && item.status === "accepted")
    ) {
      const answered = repliedQuestionIds(item) ?? state.questions;
      for (const id of answered) {
        if (!state.questions.has(id)) continue;
        state.answered.add(id);
        state.pending.delete(id);
      }
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
