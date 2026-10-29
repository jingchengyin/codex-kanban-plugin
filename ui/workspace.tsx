import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCheck,
  ClipboardList,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Thread } from "../shared/types";
import { columnFor, waitingLabel } from "../shared/types";
import type {
  ArtifactDiscovery,
  DetectedArtifact,
  WorkItem,
  WorkItemInput,
  WorkspaceData,
} from "../shared/work-items";
import type { WorkReview, WorkSummary } from "../shared/work-review";
import {
  randomWorkItemIcon,
  resolveWorkItemIcon,
} from "../shared/work-item-icons";
import {
  deleteWorkItem,
  openArtifactLink,
  openConversation,
  readWorkReview,
  readWorkspace,
  saveWorkItem,
} from "./client";
import { formatDuration, formatTokens } from "./card-metrics";
import { DetectedArtifacts } from "./detected-artifacts";
import { useI18n } from "./i18n";
import { WorkItemIcon, WorkItemIconPicker } from "./work-item-icon";
import {
  reconcileWorkItemDraft,
  workItemSaveInput as saveInput,
} from "./work-item-draft";
import { Button } from "./vendor/affectui/button";
import { ThinkingLoader } from "./vendor/affectui/thinking-loader";
import "./workspace.css";

const statuses = {
  planned: "待开始",
  active: "进行中",
  review: "待验收",
  done: "已验收",
} as const;
const runtimeLabels = {
  running: "正在运行",
  waiting: "需要你处理",
  idle: "暂时空闲",
  error: "执行异常",
  unknown: "状态待同步",
} as const;
const blankItem = (): WorkItemInput => ({
  title: "",
  icon: randomWorkItemIcon(),
  description: "",
  status: "planned",
  threadIds: [],
  checklist: [],
  links: [],
});
const emptyDiscovery: ArtifactDiscovery = {
  artifacts: [],
  unavailableThreadIds: [],
};

/** 同一事项中的相同成果只显示一次，并保留手工补充的链接。 */
function itemArtifacts(
  discovery: ArtifactDiscovery,
  item: WorkItemInput,
): DetectedArtifact[] {
  const targets = new Set(
    item.links.map((link) => link.url.split(/[?#]/, 1)[0]),
  );
  return discovery.artifacts.filter((artifact) => {
    if (!item.threadIds.includes(artifact.threadId)) return false;
    const target = artifact.kind === "planFile" ? artifact.path : artifact.url;
    if (targets.has(target)) return false;
    targets.add(target);
    return true;
  });
}

/** 输入未完成时保留草稿，避免把无效内容发给保存接口。 */
function draftProblem(input: WorkItemInput): string {
  if (!input.title.trim()) return "请填写事项名称后自动保存。";
  for (const link of input.links) {
    if (!link.label.trim()) return "请补全成果名称后自动保存。";
    try {
      if (!["http:", "https:", "codex:"].includes(new URL(link.url).protocol))
        return "请填写有效的成果地址后自动保存。";
    } catch {
      return "请填写有效的成果地址后自动保存。";
    }
  }
  return "";
}
const emptySummary: WorkSummary = {
  turns: 0,
  completed: 0,
  interrupted: 0,
  inProgress: 0,
  tokens: 0,
  unknownTokens: 0,
  durationMs: 0,
  unknownDuration: 0,
};

/** 管理插件自己的事项、对话关联和验收记录。 */
export function WorkItems({
  active,
  threads,
  artifactRevision = 0,
  onChanged,
  openItem,
  onItemOpened,
}: {
  active: boolean;
  threads: Thread[];
  artifactRevision?: number;
  onChanged?: (data: WorkspaceData) => void;
  openItem?: WorkItem | null;
  onItemOpened?: () => void;
}) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [discovery, setDiscovery] = useState<ArtifactDiscovery>(emptyDiscovery);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<WorkItemInput | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [saveState, setSaveState] = useState<
    "idle" | "pending" | "saving" | "saved" | "invalid" | "error"
  >("idle");
  const [saveProblem, setSaveProblem] = useState("");
  const currentDraft = useRef<WorkItemInput | null>(null);
  const savedDraft = useRef("");
  const saveTask = useRef<Promise<boolean> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const byId = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 15000;
    const refresh = (background = false) => {
      if (refreshing) return;
      if (background && saveTask.current) {
        timer = setTimeout(() => refresh(true), 2500);
        return;
      }
      refreshing = true;
      // 刷新时保留已有事项和成果，只更新读取状态。
      setLoading(true);
      if (!background) {
        setError("");
      }
      void readWorkspace()
        .then((data) => {
          if (!cancelled) {
            delay = data.discovery?.pendingThreadIds?.length ? 2500 : 15000;
            const current = currentDraft.current;
            const latest = data.items.find((item) => item.id === current?.id);
            if (current && latest && !saveTask.current) {
              const updated = reconcileWorkItemDraft(
                current,
                savedDraft.current,
                latest,
              );
              if (updated) {
                currentDraft.current = updated.draft;
                savedDraft.current = updated.saved;
                setDraft(updated.draft);
              }
            }
            setItems(data.items);
            onChanged?.(data);
            setDiscovery(data.discovery ?? emptyDiscovery);
            setLoaded(true);
          }
        })
        .catch((reason) => {
          if (!cancelled)
            setError(
              reason instanceof Error ? reason.message : "读取工作事项失败",
            );
        })
        .finally(() => {
          refreshing = false;
          if (!cancelled) {
            setLoading(false);
            timer = setTimeout(() => refresh(true), delay);
          }
        });
    };
    refresh();
    // 刷新同步外部追加的关联，保留编辑中的正文和用户主动调整的关联。
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, revision, artifactRevision]);

  /** 串行保存最新草稿，保存期间继续输入也不会被旧响应覆盖。 */
  function save(): Promise<boolean> {
    clearTimeout(saveTimer.current);
    if (saveTask.current) return saveTask.current;
    const task = (async () => {
      while (currentDraft.current) {
        const input = saveInput(currentDraft.current);
        const serialized = JSON.stringify(input);
        if (serialized === savedDraft.current) {
          setSaveState(input.id ? "saved" : "idle");
          return true;
        }
        const problem = draftProblem(input);
        if (problem) {
          setSaveProblem(problem);
          setSaveState("invalid");
          return false;
        }
        setSaveState("saving");
        setSaveProblem("");
        try {
          const data = await saveWorkItem(input);
          setItems(data.items);
          onChanged?.(data);
          setDiscovery(data.discovery ?? emptyDiscovery);
          setLoaded(true);
          savedDraft.current = JSON.stringify({ ...input, id: data.item.id });
          // 首次创建后只补入 ID，保留请求期间用户继续输入的内容。
          if (!input.id && currentDraft.current) {
            currentDraft.current = {
              ...currentDraft.current,
              id: data.item.id,
            };
            setDraft(currentDraft.current);
          }
        } catch (reason) {
          setSaveProblem(
            reason instanceof Error ? reason.message : "保存工作事项失败",
          );
          setSaveState("error");
          return false;
        }
      }
      return true;
    })();
    saveTask.current = task;
    void task.finally(() => {
      saveTask.current = null;
    });
    return task;
  }

  /** 合并连续文本输入；离开字段或关闭面板时立即提交。 */
  function updateDraft(next: WorkItemInput) {
    currentDraft.current = next;
    setDraft(next);
    setSaveState("pending");
    setSaveProblem("");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 300);
  }

  /** 切换前完成当前保存；保存失败时保留原草稿和面板。 */
  async function openEditor(item: WorkItemInput | null) {
    if (!(await save())) return;
    const next = item ? structuredClone(item) : null;
    currentDraft.current = next;
    savedDraft.current = next ? JSON.stringify(saveInput(next)) : "";
    setDraft(next);
    setEditorKey((value) => value + 1);
    setSaveState("idle");
    setSaveProblem("");
    setNotice("");
  }

  // 从对话卡片的事项标签进入时，直接打开对应事项，不要求重新搜索。
  useEffect(() => {
    if (active && openItem)
      void openEditor(openItem).then(() => onItemOpened?.());
  }, [active, openItem?.id]);

  /** 删除事项时保留原对话，只更新插件中的组织记录。 */
  async function remove(id: string) {
    if (!(await save())) return;
    setDeleting(id);
    setError("");
    try {
      const data = await deleteWorkItem(id);
      setItems(data.items);
      onChanged?.(data);
      setDiscovery(data.discovery ?? emptyDiscovery);
      setLoaded(true);
      if (currentDraft.current?.id === id) {
        currentDraft.current = null;
        setDraft(null);
      }
      setConfirmDelete(null);
      setNotice("工作事项已删除");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除工作事项失败");
    } finally {
      setDeleting(null);
    }
  }

  const displayed = items.filter(
    (item) =>
      (!stateFilter || item.status === stateFilter) &&
      `${item.title} ${item.description}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section className="workspace-panel" aria-label={t("工作事项")}>
      <div className="workspace-heading">
        <div>
          <h1>{t("工作事项")}</h1>
          <p>{t("把相关对话放在一起，记录验收清单和成果。")}</p>
        </div>
        <div className="workspace-actions">
          <Button
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => setRevision(revision + 1)}
            loading={loading}
            disabled={loading}
          >
            {t("刷新")}
          </Button>
          <Button
            icon={<Plus size={14} />}
            onClick={() => void openEditor(blankItem())}
            disabled={draft !== null}
          >
            {t("新建事项")}
          </Button>
        </div>
      </div>
      {error && (
        <div className="data-notice" role="alert">
          {t(error)}
        </div>
      )}
      {notice && (
        <p className="workspace-notice" role="status">
          {t(notice)}
        </p>
      )}
      <div className={`workspace-grid ${draft ? "has-editor" : ""}`}>
        <div className="work-list" aria-busy={loading}>
          <div className="workspace-filters">
            <input
              className="workspace-input"
              aria-label={t("搜索事项")}
              placeholder={t("搜索事项…")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="workspace-input"
              aria-label={t("事项状态")}
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="">{t("全部状态")}</option>
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </select>
          </div>
          {!loaded ? (
            <div className="workspace-empty">
              {loading ? (
                <ThinkingLoader
                  phases={[t("正在读取工作事项与关联成果…")]}
                  phase={0}
                />
              ) : (
                <p>{t("请刷新后重试。")}</p>
              )}
            </div>
          ) : !displayed.length ? (
            <div className="workspace-empty">
              <ClipboardList size={30} />
              <h2>
                {t(items.length ? "没有匹配的事项" : "创建第一个工作事项")}
              </h2>
              <p>
                {t(
                  items.length
                    ? "调整搜索或状态筛选。"
                    : "例如，把实现、测试和发布说明的对话关联到同一次发布。",
                )}
              </p>
            </div>
          ) : (
            displayed.map((item) => {
              const linked = item.threadIds
                .map((id) => byId.get(id))
                .filter((thread): thread is Thread => !!thread);
              const running = linked.filter(
                (thread) => columnFor(thread) === "running",
              ).length;
              const waiting = linked.filter(
                (thread) => columnFor(thread) === "waiting",
              ).length;
              const done = item.checklist.filter((check) => check.done).length;
              return (
                <article
                  className="work-card"
                  key={item.id}
                  tabIndex={0}
                  aria-label={t("编辑事项：{title}", { title: item.title })}
                  aria-current={draft?.id === item.id ? "true" : undefined}
                  onClick={(event) => {
                    if ((event.target as Element).closest("button, a")) return;
                    if (currentDraft.current?.id !== item.id)
                      void openEditor(item);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      if (currentDraft.current?.id !== item.id)
                        void openEditor(item);
                    }
                  }}
                >
                  <div className="work-card-heading">
                    <h2 className="work-item-title">
                      <WorkItemIcon
                        icon={item.icon}
                        itemId={item.id}
                        size={18}
                      />
                      <span>{item.title}</span>
                    </h2>
                    <span className={`work-status work-status--${item.status}`}>
                      {t(statuses[item.status])}
                    </span>
                  </div>
                  {item.description && (
                    <p className="work-description">{item.description}</p>
                  )}
                  <div className="work-card-meta">
                    <span>
                      {t("{count} 条关联对话", {
                        count: item.threadIds.length,
                      })}
                    </span>
                    {running > 0 && (
                      <span>{t("{count} 条运行中", { count: running })}</span>
                    )}
                    {waiting > 0 && (
                      <span className="work-waiting">
                        {t("{count} 条待处理", { count: waiting })}
                      </span>
                    )}
                    <span>
                      <CheckCheck size={13} />{" "}
                      {t("验收 {done}/{total}", {
                        done,
                        total: item.checklist.length,
                      })}
                    </span>
                  </div>
                  {item.threadIds.length > 0 && (
                    <div className="work-thread-links">
                      {item.threadIds.slice(0, 4).map((id) => {
                        const thread = byId.get(id);
                        return (
                          <button
                            key={id}
                            onClick={() =>
                              void openConversation(id).catch((reason) =>
                                setError(
                                  reason instanceof Error
                                    ? reason.message
                                    : "无法打开对话",
                                ),
                              )
                            }
                          >
                            <span>
                              {thread?.title ?? t("未加载的关联对话")}
                            </span>
                            <small>
                              {thread
                                ? t(
                                    columnFor(thread) === "waiting"
                                      ? waitingLabel(thread)
                                      : runtimeLabels[columnFor(thread)],
                                  )
                                : id.slice(0, 8)}
                            </small>
                            <ExternalLink size={12} />
                          </button>
                        );
                      })}
                      {item.threadIds.length > 4 && (
                        <p className="workspace-hint">
                          {t("另有 {count} 条关联对话", {
                            count: item.threadIds.length - 4,
                          })}
                        </p>
                      )}
                    </div>
                  )}
                  {item.links.length > 0 && (
                    <div className="work-artifacts">
                      {item.links.map((link, index) => (
                        <a
                          key={`${link.url}-${index}`}
                          href={link.url}
                          onClick={(event) => {
                            event.preventDefault();
                            void openArtifactLink(link.url).catch((reason) =>
                              setError(
                                reason instanceof Error
                                  ? reason.message
                                  : "无法打开成果链接",
                              ),
                            );
                          }}
                        >
                          <ExternalLink size={12} />
                          {link.label || link.url}
                        </a>
                      ))}
                    </div>
                  )}
                  <DetectedArtifacts
                    artifacts={itemArtifacts(discovery, item)}
                    threads={threads}
                    onError={setError}
                  />
                  <div className="work-card-footer">
                    <small>
                      {t("更新于")}{" "}
                      {new Date(item.updatedAt).toLocaleDateString(locale)}
                    </small>
                    <div className="workspace-actions">
                      {confirmDelete === item.id ? (
                        <>
                          <span className="workspace-hint">
                            {t("确认删除事项？")}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDelete(null)}
                          >
                            {t("取消")}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            loading={deleting === item.id}
                            onClick={() => void remove(item.id)}
                          >
                            {t("确认删除")}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Trash2 size={13} />}
                            aria-label={t("删除事项：{title}", {
                              title: item.title,
                            })}
                            disabled={deleting !== null}
                            onClick={() => setConfirmDelete(item.id)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
        {draft && (
          <ItemEditor
            key={editorKey}
            draft={draft}
            setDraft={updateDraft}
            threads={threads}
            artifacts={itemArtifacts(discovery, draft)}
            artifactsLoading={
              draft.threadIds.length > 0 &&
              (loading ||
                draft.threadIds.some((id) =>
                  discovery.pendingThreadIds?.includes(id),
                ) ||
                saveState === "pending" ||
                saveState === "saving" ||
                deleting !== null)
            }
            unavailableArtifacts={
              draft.threadIds.filter((id) =>
                discovery.unavailableThreadIds.includes(id),
              ).length
            }
            onArtifactError={setError}
            saveState={saveState}
            saveProblem={saveProblem}
            onSave={save}
            onClose={() => void openEditor(null)}
          />
        )}
      </div>
    </section>
  );
}

/** 编辑事项及关联记录，保留当前快照中暂未加载的对话。 */
function ItemEditor({
  draft,
  setDraft,
  threads,
  artifacts,
  artifactsLoading,
  unavailableArtifacts,
  onArtifactError,
  saveState,
  saveProblem,
  onSave,
  onClose,
}: {
  draft: WorkItemInput;
  setDraft: (draft: WorkItemInput) => void;
  threads: Thread[];
  artifacts: DetectedArtifact[];
  artifactsLoading: boolean;
  unavailableArtifacts: number;
  onArtifactError: (message: string) => void;
  saveState: "idle" | "pending" | "saving" | "saved" | "invalid" | "error";
  saveProblem: string;
  onSave: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [threadQuery, setThreadQuery] = useState("");
  const [checkText, setCheckText] = useState("");
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const selected = new Set(draft.threadIds);
  const options = threads.filter((thread) =>
    `${thread.title} ${thread.project}`
      .toLocaleLowerCase()
      .includes(threadQuery.trim().toLocaleLowerCase()),
  );
  const missing = draft.threadIds.filter((id) => !byId.has(id));
  const update = (patch: Partial<WorkItemInput>) =>
    setDraft({ ...draft, ...patch });
  function addCheck() {
    if (!checkText.trim()) return;
    update({
      checklist: [
        ...draft.checklist,
        { id: crypto.randomUUID(), text: checkText.trim(), done: false },
      ],
    });
    setCheckText("");
  }
  return (
    <aside
      className="work-editor"
      aria-label={t(draft.id ? "编辑事项" : "新建事项")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
        onBlur={() => void onSave()}
      >
        <div className="work-card-heading">
          <h2>{t(draft.id ? "编辑事项" : "新建事项")}</h2>
          <Button
            variant="ghost"
            icon={<X size={15} />}
            aria-label={t("关闭编辑")}
            onClick={onClose}
          />
        </div>
        <fieldset className="editor-fields">
          <WorkItemIconPicker
            value={resolveWorkItemIcon(draft)}
            onChange={(icon) => update({ icon })}
          />
          <label>
            {t("事项名称")}
            <input
              className="workspace-input"
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              placeholder={t("例如：发布插件新版本")}
              autoFocus
            />
          </label>
          <label>
            {t("预期结果与说明")}
            <textarea
              className="workspace-input"
              rows={3}
              maxLength={10000}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </label>
          <label>
            {t("事项状态")}
            <select
              className="workspace-input"
              value={draft.status}
              onChange={(event) =>
                update({ status: event.target.value as WorkItem["status"] })
              }
            >
              {Object.entries(statuses).map(([value, text]) => (
                <option key={value} value={value}>
                  {t(text)}
                </option>
              ))}
            </select>
          </label>
          <p className="workspace-hint">
            {t("事项状态由你更新；对话空闲不代表已经验收。")}
          </p>
          <div className="editor-section">
            <h3>
              {t("关联对话")} <small>{draft.threadIds.length}</small>
            </h3>
            <input
              className="workspace-input"
              aria-label={t("搜索可关联的对话")}
              placeholder={t("搜索标题或项目…")}
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
            />
            <div className="thread-picker">
              {missing.map((id) => (
                <label className="thread-option" key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      update({
                        threadIds: draft.threadIds.filter(
                          (value) => value !== id,
                        ),
                      })
                    }
                  />
                  <span>
                    {t("未加载的关联对话")}
                    <small>{id}</small>
                  </span>
                </label>
              ))}
              {options.slice(0, 100).map((thread) => (
                <label className="thread-option" key={thread.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(thread.id)}
                    onChange={(event) =>
                      update({
                        threadIds: event.target.checked
                          ? [...draft.threadIds, thread.id]
                          : draft.threadIds.filter(
                              (value) => value !== thread.id,
                            ),
                      })
                    }
                  />
                  <span>
                    {thread.title}
                    <small>{thread.project}</small>
                  </span>
                </label>
              ))}
              {!options.length && !missing.length && (
                <p className="workspace-hint">{t("没有匹配的对话")}</p>
              )}
              {options.length > 100 && (
                <p className="workspace-hint">{t("请搜索以缩小对话范围。")}</p>
              )}
            </div>
          </div>
          <div className="editor-section">
            <h3>{t("验收清单")}</h3>
            {draft.checklist.map((check) => (
              <div className="check-row" key={check.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={check.done}
                    onChange={(event) =>
                      update({
                        checklist: draft.checklist.map((value) =>
                          value.id === check.id
                            ? { ...value, done: event.target.checked }
                            : value,
                        ),
                      })
                    }
                  />
                  <span>{check.text}</span>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X size={13} />}
                  aria-label={t("移除验收项：{text}", { text: check.text })}
                  onClick={() =>
                    update({
                      checklist: draft.checklist.filter(
                        (value) => value.id !== check.id,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <div className="workspace-inline">
              <input
                className="workspace-input"
                aria-label={t("新验收项")}
                placeholder={t("添加验收条件…")}
                maxLength={1000}
                value={checkText}
                onChange={(event) => setCheckText(event.target.value)}
                onBlur={addCheck}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addCheck();
                  }
                }}
              />
              <Button
                variant="secondary"
                icon={<Plus size={14} />}
                aria-label={t("添加验收项")}
                onClick={addCheck}
                disabled={!checkText.trim()}
              />
            </div>
          </div>
          <div className="editor-section" aria-busy={artifactsLoading}>
            <h3 className="artifact-heading">
              {t("成果")}
              {artifactsLoading ? (
                <ThinkingLoader
                  phases={[t("正在更新关联成果…")]}
                  phase={0}
                  size="sm"
                  variant="plain"
                />
              ) : (
                <small>{t("自动识别")}</small>
              )}
            </h3>
            <p className="workspace-hint">
              {t("从关联对话的最终答复中识别 MR、PR 和本机方案文件。")}
            </p>
            <DetectedArtifacts
              artifacts={artifacts}
              threads={threads}
              onError={onArtifactError}
            />
            {!artifactsLoading && !artifacts.length && (
              <p className="workspace-hint artifact-empty">
                {t(
                  draft.threadIds.length
                    ? "暂未发现自动成果；对话产生新的最终答复后会自动更新。"
                    : "关联对话后，会自动查找其中的 MR、PR 和方案文件。",
                )}
              </p>
            )}
            {!artifactsLoading && unavailableArtifacts > 0 && (
              <p className="workspace-hint artifact-empty">
                {t("{count} 条关联对话的成果暂不可读。", {
                  count: unavailableArtifacts,
                })}
              </p>
            )}
            <details className="manual-artifacts">
              <summary>
                {t("补充链接")}
                {draft.links.length > 0 ? ` · ${draft.links.length}` : ""}
              </summary>
              {draft.links.map((link, index) => (
                <div className="artifact-editor" key={index}>
                  <input
                    className="workspace-input"
                    aria-label={t("成果名称 {count}", { count: index + 1 })}
                    placeholder={t("成果名称")}
                    maxLength={200}
                    required
                    value={link.label}
                    onChange={(event) =>
                      update({
                        links: draft.links.map((value, i) =>
                          i === index
                            ? { ...value, label: event.target.value }
                            : value,
                        ),
                      })
                    }
                  />
                  <div className="workspace-inline">
                    <input
                      className="workspace-input"
                      type="url"
                      required
                      aria-label={t("成果地址 {count}", { count: index + 1 })}
                      placeholder="https://…"
                      maxLength={4000}
                      value={link.url}
                      onChange={(event) =>
                        update({
                          links: draft.links.map((value, i) =>
                            i === index
                              ? { ...value, url: event.target.value }
                              : value,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      icon={<X size={14} />}
                      aria-label={t("移除成果链接 {count}", {
                        count: index + 1,
                      })}
                      onClick={() =>
                        update({
                          links: draft.links.filter((_, i) => i !== index),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() =>
                  update({ links: [...draft.links, { label: "", url: "" }] })
                }
              >
                {t("添加成果链接")}
              </Button>
            </details>
          </div>
        </fieldset>
        <div className="editor-footer">
          <p
            className={`workspace-hint ${saveState === "error" ? "autosave-error" : ""}`}
            role={saveState === "error" ? "alert" : "status"}
          >
            {t(
              saveState === "error"
                ? "自动保存失败，修改仍保留在此处。"
                : saveState === "invalid"
                  ? saveProblem
                  : saveState === "saving" || saveState === "pending"
                    ? "正在保存…"
                    : saveState === "saved"
                      ? "已自动保存"
                      : "修改后自动保存",
            )}
          </p>
          {saveState === "error" && (
            <Button variant="secondary" size="sm" onClick={() => void onSave()}>
              {t("重试")}
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}

/** 按当地日历天展示历史回合，明确区分已知用量与缺失数据。 */
export function WorkReviewPanel({ active }: { active: boolean }) {
  const { t, locale, language } = useI18n();
  const [days, setDays] = useState(7);
  const [project, setProject] = useState<string | null>(null);
  const [review, setReview] = useState<WorkReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    // 范围切换或读取失败时，不能把旧范围统计显示成当前结果。
    setReview(null);
    readWorkReview(
      { days, timezone, project: project ?? undefined, offset: 0, limit: 50 },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setReview(data);
          setProject((current) =>
            current !== null &&
            !data.projects.some((value) => value.cwd === current)
              ? null
              : current,
          );
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "读取工作回顾失败",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      // 同时取消首屏和后续分页，防止旧筛选结果回写到新范围。
      request.current?.abort();
    };
  }, [active, days, timezone, project, revision]);
  /** 只请求下一页记录，汇总仍使用服务端对整个时间范围的统计。 */
  async function loadMore() {
    if (!review || loadingMore) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const data = await readWorkReview(
        {
          days,
          timezone,
          project: project ?? undefined,
          offset: review.records.length,
          limit: 50,
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setReview((current) =>
          current
            ? { ...data, records: [...current.records, ...data.records] }
            : data,
        );
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "读取工作回顾失败");
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }
  const records = review?.records ?? [];
  const summary =
    project !== null
      ? (review?.projects.find((value) => value.cwd === project) ??
        emptySummary)
      : (review?.summary ?? emptySummary);
  const number = (value: number) => value.toLocaleString(locale);
  const knownTokens = summary.turns - summary.unknownTokens;
  const knownDuration = summary.turns - summary.unknownDuration;
  return (
    <section className="workspace-panel" aria-label={t("工作回顾")}>
      <div className="workspace-heading">
        <div>
          <h1>{t("工作回顾")}</h1>
          <p>{t("只统计有用户输入记录的主对话回合，包含已归档对话。")}</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} />}
          disabled={loading}
          onClick={() => setRevision(revision + 1)}
        >
          {t("刷新")}
        </Button>
      </div>
      <div className="workspace-filters review-filters">
        <label>
          {t("时间范围")}
          <select
            className="workspace-input"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={1}>{t("今天")}</option>
            <option value={7}>{t("最近 7 天")}</option>
            <option value={30}>{t("最近 30 天")}</option>
          </select>
        </label>
        <label>
          {t("项目")}
          <select
            className="workspace-input"
            value={project === null ? "all" : `cwd:${project}`}
            onChange={(event) => {
              setProject(
                event.target.value === "all"
                  ? null
                  : event.target.value.slice(4),
              );
            }}
          >
            <option value="all">{t("全部项目")}</option>
            {!review && project !== null && (
              <option value={`cwd:${project}`}>
                {project || t("未归属项目")}
              </option>
            )}
            {review?.projects.map((value) => (
              <option key={value.cwd} value={`cwd:${value.cwd}`}>
                {value.project} · {value.cwd || t("未归属项目")}
              </option>
            ))}
          </select>
        </label>
        <span className="workspace-hint">{timezone}</span>
      </div>
      {error && (
        <div className="data-notice" role="alert">
          {t(error)}
        </div>
      )}
      {review?.sources.message && (
        <div className="data-notice" role="status">
          {t(review.sources.message)}
        </div>
      )}
      {loading ? (
        <p className="workspace-empty" role="status">
          {t("正在读取历史回合…")}
        </p>
      ) : (
        review?.sources.metadata && (
          <>
            <div className="review-summary">
              <div>
                <span>{t("历史回合")}</span>
                <strong>{number(summary.turns)}</strong>
                <small>
                  {t("{count} 轮已结束", { count: summary.completed })}
                </small>
              </div>
              <div>
                <span>{t("已知 Token 用量")}</span>
                <strong>{knownTokens ? number(summary.tokens) : "—"}</strong>
                <small>
                  {t("{count} 轮用量缺失", { count: summary.unknownTokens })}
                </small>
              </div>
              <div>
                <span>{t("回合累计耗时")}</span>
                <strong>
                  {knownDuration
                    ? formatDuration(summary.durationMs, language)
                    : "—"}
                </strong>
                <small>
                  {t("{count} 轮耗时缺失", { count: summary.unknownDuration })}
                </small>
              </div>
              <div>
                <span>{t("中断回合")}</span>
                <strong>{number(summary.interrupted)}</strong>
                <small>
                  {t("{count} 轮记录未结束", { count: summary.inProgress })}
                </small>
              </div>
            </div>
            <p className="workspace-hint review-explanation">
              {t("展示用户输入、运行状态和用量。")}{" "}
              {t(
                "Token 包含输入、缓存输入和输出，不代表账单费用。耗时为各回合相加，并行回合会重叠。",
              )}
            </p>
            {review.sources.unavailableLogs > 0 && (
              <p className="workspace-hint">
                {t("{count} 条对话的历史日志不可读，统计可能不完整。", {
                  count: review.sources.unavailableLogs,
                })}
              </p>
            )}
            {records.length ? (
              <div className="review-records">
                {records.map((record) => (
                  <article
                    className="review-record"
                    key={`${record.threadId}:${record.id}`}
                  >
                    <div className="review-record-main">
                      <button
                        title={t("打开来源对话，不定位到具体回合。")}
                        aria-label={t(
                          "打开来源对话：{title}，不定位到具体回合。",
                          {
                            title: record.title,
                          },
                        )}
                        onClick={() =>
                          void openConversation(record.threadId).catch(
                            (reason) =>
                              setError(
                                reason instanceof Error
                                  ? reason.message
                                  : "无法打开对话",
                              ),
                          )
                        }
                      >
                        <span title={record.userInput ?? undefined}>
                          {record.userInput === ""
                            ? t("未输入文字")
                            : (record.userInput ?? t("未获取到用户输入"))}
                        </span>
                        <ExternalLink size={12} />
                      </button>
                      <p>{record.title}</p>
                      <div className="work-card-meta">
                        <span title={record.cwd}>{record.project}</span>
                        <span>
                          {new Date(
                            record.startedAt ?? record.updatedAt,
                          ).toLocaleString(locale, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: timezone,
                          })}
                        </span>
                        {record.model && <span>{record.model}</span>}
                        {record.archived && <span>{t("已归档")}</span>}
                      </div>
                    </div>
                    <div className="review-record-metrics">
                      <span
                        className={`record-status record-status--${record.status}`}
                      >
                        {t(
                          record.status === "completed"
                            ? "本轮已结束"
                            : record.status === "interrupted"
                              ? "已中断"
                              : "记录未结束",
                        )}
                      </span>
                      <span
                        title={
                          record.tokens === null
                            ? t("Token 未知")
                            : number(record.tokens)
                        }
                      >
                        {formatTokens(record.tokens, language)}
                      </span>
                      <span>{formatDuration(record.durationMs, language)}</span>
                    </div>
                  </article>
                ))}
                {records.length < review.totalRecords && (
                  <Button
                    variant="secondary"
                    loading={loadingMore}
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {t("再显示 {count} 条", {
                      count: Math.min(50, review.totalRecords - records.length),
                    })}
                  </Button>
                )}
              </div>
            ) : (
              <div className="workspace-empty">
                <ClipboardList size={30} />
                <h2>{t("这段时间没有回合记录")}</h2>
                <p>{t("尝试扩大时间范围或选择其他项目。")}</p>
              </div>
            )}
            <p className="workspace-hint review-footnote">
              {t("已检查 {count} 条对话", {
                count: review.sources.scannedThreads,
              })}{" "}
              · {t("更新于")}{" "}
              {new Date(review.generatedAt).toLocaleTimeString(locale)}
            </p>
          </>
        )
      )}
    </section>
  );
}
