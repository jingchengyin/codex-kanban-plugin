import type { WorkItem, WorkItemInput } from "../shared/work-items";

/** 全空的新增链接仅作为输入占位，不写入事项。 */
export function workItemSaveInput(draft: WorkItemInput): WorkItemInput {
  return {
    ...draft,
    links: draft.links.filter((link) => link.label.trim() || link.url.trim()),
  };
}

/** 刷新草稿中的外部关联变化，同时保留尚未保存的正文和主动关联选择。 */
export function reconcileWorkItemDraft(
  draft: WorkItemInput,
  saved: string,
  latest: WorkItem,
): { draft: WorkItemInput; saved: string } | null {
  if (!draft.id || draft.id !== latest.id || !saved) return null;
  const latestSaved = JSON.stringify(workItemSaveInput(latest));
  if (JSON.stringify(workItemSaveInput(draft)) === saved) {
    if (latestSaved === saved) return null;
    return { draft: structuredClone(latest), saved: latestSaved };
  }
  const baseline = JSON.parse(saved) as WorkItemInput;
  // 用户改过关联时不覆盖选择；未改关联时接收卡片入口追加的对话。
  if (
    JSON.stringify(draft.threadIds) !== JSON.stringify(baseline.threadIds) ||
    JSON.stringify(draft.threadIds) === JSON.stringify(latest.threadIds)
  )
    return null;
  return {
    draft: { ...draft, threadIds: [...latest.threadIds] },
    saved: JSON.stringify({ ...baseline, threadIds: [...latest.threadIds] }),
  };
}
