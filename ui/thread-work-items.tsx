import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FolderPlus, Plus, X } from "lucide-react";
import type { Thread } from "../shared/types";
import type { WorkItem, WorkItemSaveResult } from "../shared/work-items";
import { addThreadToWorkItem, saveWorkItem } from "./client";
import { useI18n } from "./i18n";
import { Button } from "./vendor/affectui/button";
import "./thread-work-items.css";

type Props = {
  thread: Pick<Thread, "id" | "title">;
  items: WorkItem[];
  onAdd: () => void;
  onOpenItem: (id: string) => void;
};

/** 从对话卡片直接关联事项，并用标签返回该事项。 */
export function ThreadWorkItems({ thread, items, onAdd, onOpenItem }: Props) {
  const { t } = useI18n();
  const linked = items.filter((item) => item.threadIds.includes(thread.id));
  return (
    <div
      className="thread-work-items"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="thread-work-item-actions">
        {linked.map((item) => (
          <button
            key={item.id}
            type="button"
            className="thread-work-item-tag"
            title={item.title}
            aria-label={t("打开事项：{title}", { title: item.title })}
            onClick={() => onOpenItem(item.id)}
          >
            {item.title}
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          icon={<FolderPlus size={13} />}
          aria-label={t("将对话加入事项：{title}", { title: thread.title })}
          onClick={onAdd}
        >
          {t("加入事项")}
        </Button>
      </div>
    </div>
  );
}

/** 弹窗由看板统一挂载，卡片跨列后仍保留输入与保存状态。 */
export function ThreadWorkItemPicker({
  thread,
  items,
  onClose,
  onChanged,
}: {
  thread: Props["thread"];
  items: WorkItem[];
  onClose: () => void;
  onChanged: (data: WorkItemSaveResult) => void;
}) {
  const { t } = useI18n();
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState(thread.title.slice(0, 200));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    // 弹窗打开后直接搜索，避免先经过关闭按钮再进入输入框。
    element.querySelector<HTMLInputElement>("input")?.focus();
    return () => element.close();
  }, []);
  const displayed = items.filter((item) =>
    item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  /** 现有事项只追加关联；新事项复用既有保存接口和数据结构。 */
  async function save(id?: string) {
    if (busy || (!id && !title.trim())) return;
    setBusy(id ?? "new");
    setError("");
    try {
      const data = id
        ? await addThreadToWorkItem(id, thread.id)
        : await saveWorkItem({
            title: title.trim(),
            description: "",
            status: "planned",
            threadIds: [thread.id],
            checklist: [],
            links: [],
          });
      onChanged(data);
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "关联事项失败，请重试。",
      );
      setBusy(null);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="thread-work-item-dialog"
      aria-labelledby={heading}
      aria-busy={busy !== null}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="thread-work-item-dialog-heading">
        <h2 id={heading}>{t("加入事项")}</h2>
        <Button
          variant="ghost"
          icon={<X size={16} />}
          aria-label={t("关闭")}
          disabled={busy !== null}
          onClick={onClose}
        />
      </div>
      <p className="thread-work-item-source">{thread.title}</p>
      <label className="thread-work-item-field">
        {t("搜索已有事项")}
        <input
          className="workspace-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="thread-work-item-options">
        {displayed.map((item) => {
          const linked = item.threadIds.includes(thread.id);
          return (
            <button
              type="button"
              className="thread-work-item-option"
              key={item.id}
              disabled={linked || busy !== null}
              onClick={() => void save(item.id)}
            >
              <span>{item.title}</span>
              <small>
                {linked ? (
                  <>
                    <Check size={13} />
                    {t("已关联")}
                  </>
                ) : busy === item.id ? (
                  t("正在关联…")
                ) : (
                  t("加入")
                )}
              </small>
            </button>
          );
        })}
        {!displayed.length && (
          <p className="workspace-hint">
            {t(
              items.length
                ? "没有匹配的事项，可在下方新建。"
                : "还没有工作事项，可在下方新建。",
            )}
          </p>
        )}
      </div>
      <form
        className="thread-work-item-create"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="thread-work-item-field">
          {t("新事项名称")}
          <input
            className="workspace-input"
            value={title}
            maxLength={200}
            required
            onChange={(event) => setTitle(event.target.value)}
            disabled={busy !== null}
          />
        </label>
        <Button
          type="submit"
          icon={<Plus size={14} />}
          loading={busy === "new"}
          disabled={busy !== null || !title.trim()}
        >
          {t("新建并关联")}
        </Button>
      </form>
      {error && (
        <p className="thread-work-item-error" role="alert">
          {t(error)}
        </p>
      )}
    </dialog>,
    document.body,
  );
}
