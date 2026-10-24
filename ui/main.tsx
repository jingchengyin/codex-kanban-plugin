import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownWideNarrow,
  Bell,
  ChevronRight,
  Clock3,
  Folder,
  LoaderCircle,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquareKanban,
  Unplug,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "./vendor/affectui/button";
import { SegmentedControl } from "./vendor/affectui/segmented-control";
import { FilterMenu, type FilterValue } from "./vendor/affectui/filter-menu";
import { ThinkingLoader } from "./vendor/affectui/thinking-loader";
import {
  columnFor,
  belongsToColumn,
  waitingLabel,
  type BoardColumn,
  type Snapshot,
  type Thread,
} from "../shared/types";
import { openConversation, readSnapshot } from "./client";
import "./style.css";

const columns: {
  id: BoardColumn;
  label: string;
  color: string;
  detail: string;
}[] = [
  {
    id: "waiting",
    label: "需要你处理",
    color: "amber",
    detail: "等待确认或回复",
  },
  {
    id: "running",
    label: "正在运行",
    color: "green",
    detail: "任务正在进行",
  },
  {
    id: "unread",
    label: "未读",
    color: "blue",
    detail: "未读对话会显示在这里",
  },
  {
    id: "idle",
    label: "暂时空闲",
    color: "gray",
    detail: "当前没有运行中的回合",
  },
  { id: "error", label: "执行异常", color: "red", detail: "查看原对话处理" },
  {
    id: "unknown",
    label: "状态待同步",
    color: "muted",
    detail: "未加载或实时状态不可用",
  },
];
const labelFor = (thread: Thread) =>
  columnFor(thread) === "waiting"
    ? waitingLabel(thread)
    : columns.find((c) => c.id === columnFor(thread))!.label;
function relativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
}
function preference<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`taskboard:${key}`);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function Board() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [filters, setFilters] = useState<FilterValue>({ kind: ["user"] });
  const [readSource, setReadSource] = useState<string | null>(() =>
    preference("read-source", null),
  );
  const readSourceRef = useRef(readSource);
  const [sort, setSort] = useState<"recent" | "title">("recent");
  const [settings, setSettings] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const inFlight = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      setSnapshot(await readSnapshot(readSourceRef.current));
      setFetchError(null);
    } catch (error) {
      setFetchError(
        error instanceof Error ? error.message : "暂时无法刷新状态",
      );
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2500);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape") {
        setSettings(false);
        setFilterOpen(false);
      }
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("keydown", keys);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("keydown", keys);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  const threads = useMemo(
    () =>
      (snapshot?.threads ?? []).map((thread) =>
        fetchError ? { ...thread, fresh: false } : thread,
      ),
    [snapshot, fetchError],
  );
  const totals = useMemo(
    () =>
      Object.fromEntries(
        columns.map((column) => [
          column.id,
          threads.filter((thread) => belongsToColumn(thread, column.id)).length,
        ]),
      ) as Record<BoardColumn, number>,
    [threads],
  );
  const unreadCount = threads.filter((thread) => thread.unread === true).length;
  const projects = [...new Set(threads.map((thread) => thread.project))].sort(
    (a, b) => a.localeCompare(b, "zh"),
  );
  const displayed = useMemo(
    () =>
      threads
        .filter((thread) => {
          const column = columnFor(thread);
          if (scope === "unread" && thread.unread !== true) return false;
          if (
            scope === "attention" &&
            column !== "waiting" &&
            column !== "error"
          )
            return false;
          if (
            filters.project?.length &&
            !filters.project.includes(thread.project)
          )
            return false;
          if (filters.kind?.length && !filters.kind.includes(thread.kind))
            return false;
          if (
            filters.read?.length &&
            !filters.read.includes(
              thread.unread === null
                ? "unknown"
                : thread.unread
                  ? "unread"
                  : "read",
            )
          )
            return false;
          if (filters.state?.length && !filters.state.includes(column))
            return false;
          return `${thread.title} ${thread.project} ${thread.id}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase());
        })
        .sort((a, b) =>
          sort === "title"
            ? a.title.localeCompare(b.title, "zh")
            : b.updatedAt.localeCompare(a.updatedAt),
        ),
    [threads, scope, filters, query, sort],
  );
  const live = snapshot?.connection.state === "connected" && !fetchError;
  const loading = !snapshot && !fetchError;
  const activeFilters = Object.values(filters).reduce(
    (n, a) => n + a.length,
    0,
  );
  const selectReadSource = (value: string | null) => {
    readSourceRef.current = value;
    setReadSource(value);
    try {
      localStorage.setItem("taskboard:read-source", JSON.stringify(value));
    } catch {
      /* No persistent preference. */
    }
    void refresh();
  };
  const open = async (thread: Thread) => {
    try {
      await openConversation(thread.id);
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  return (
    <div className="app-shell">
      <main className="main">
        <section className="board-section" aria-label="对话看板">
          <div className="board-toolbar">
            <SegmentedControl
              options={[
                { value: "all", label: "全部对话", count: threads.length },
                {
                  value: "attention",
                  label: "需要关注",
                  count: totals.waiting + totals.error,
                },
                {
                  value: "unread",
                  label: "未读",
                  count: snapshot?.sources.unread ? unreadCount : "—",
                },
              ]}
              value={scope}
              onChange={setScope}
              size="sm"
              variant="underline"
              aria-label="对话范围"
            />
            <div className="toolbar-actions">
              <label className="search">
                <Search size={15} />
                <input
                  ref={search}
                  aria-label="搜索对话"
                  placeholder="搜索对话…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>⌘ K</kbd>
              </label>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={filterOpen}
                icon={<SlidersHorizontal size={14} />}
                onClick={() => setFilterOpen(!filterOpen)}
              >
                筛选{activeFilters ? ` ${activeFilters}` : ""}
              </Button>
              <button
                className={`connection-pill ${live ? "is-live" : ""}`}
                onClick={() => setSettings(true)}
                aria-label="连接与数据源"
                title="连接与数据源"
              >
                {live ? <Wifi size={14} /> : <WifiOff size={14} />}
                <span>
                  {live
                    ? "已连接"
                    : snapshot?.connection.state === "connecting"
                      ? "连接中"
                      : "未连接"}
                </span>
                <span className="connection-dot" />
              </button>
              <Button
                variant="secondary"
                size="sm"
                icon={
                  <RefreshCw size={14} className={refreshing ? "spin" : ""} />
                }
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                刷新
              </Button>
            </div>
          </div>
          {fetchError && (
            <div className="data-notice" role="alert">
              <Unplug size={14} /> {fetchError}。当前显示最后一次快照。
            </div>
          )}
          {snapshot && !snapshot.sources.metadata && (
            <div className="data-notice" role="alert">
              {snapshot.sources.metadataError}
            </div>
          )}
          {filterOpen && (
            <div className="filter-area">
              <FilterMenu
                title="筛选对话"
                hints={false}
                groups={[
                  {
                    id: "state",
                    label: "运行状态",
                    options: columns
                      .filter((c) => c.id !== "unread")
                      .map((c) => ({ id: c.id, label: c.label })),
                  },
                  {
                    id: "read",
                    label: "阅读状态",
                    options: [
                      { id: "unread", label: "未读" },
                      { id: "read", label: "已读" },
                      { id: "unknown", label: "未知" },
                    ],
                  },
                  {
                    id: "project",
                    label: "项目",
                    options: projects.map((project) => ({
                      id: project,
                      label: project,
                    })),
                  },
                  {
                    id: "kind",
                    label: "对话类型",
                    options: [
                      { id: "user", label: "普通对话" },
                      { id: "agent", label: "子 Agent" },
                      { id: "unknown", label: "其他 / 未知" },
                    ],
                  },
                ]}
                value={filters}
                onChange={setFilters}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<X size={14} />}
                onClick={() => setFilterOpen(false)}
              >
                收起筛选
              </Button>
            </div>
          )}
          <div className="board-meta">
            <span>
              <span className={`tiny-dot ${live ? "green" : ""}`} />
              {loading ? "正在读取本地对话" : `${displayed.length} 条对话`}
            </span>
            <div className="board-meta-actions">
              {snapshot && (
                <span className="updated-at">
                  更新于{" "}
                  {new Date(snapshot.generatedAt).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </span>
              )}
              {!displayed.length && threads.length > 0 && (
                <button
                  className="sort-button"
                  onClick={() => {
                    setQuery("");
                    setFilters({});
                    setScope("all");
                  }}
                >
                  重置筛选
                </button>
              )}
              <button
                className="sort-button"
                onClick={() => setSort(sort === "recent" ? "title" : "recent")}
              >
                <ArrowDownWideNarrow size={13} />
                {sort === "recent" ? "最近更新" : "标题排序"}
              </button>
            </div>
          </div>
          {loading ? (
            <div className="loading-board">
              <ThinkingLoader phases={["正在读取本地对话"]} phase={0} />
              <div className="skeleton-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div className="skeleton-card" key={i}>
                    <span />
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="kanban">
              {columns.map((column) => (
                <Lane
                  key={column.id}
                  column={column}
                  threads={displayed.filter((thread) =>
                    belongsToColumn(thread, column.id),
                  )}
                  onOpen={(thread) => void open(thread)}
                  unreadAvailable={snapshot?.sources.unread ?? false}
                  onConfigure={() => setSettings(true)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
      {settings && (
        <Modal title="连接与数据源" onClose={() => setSettings(false)}>
          <div className="source-status">
            <span className={live ? "source-icon live" : "source-icon"}>
              {live ? <Wifi size={22} /> : <WifiOff size={22} />}
            </span>
            <div>
              <h2>{live ? "共享状态服务已连接" : "实时状态服务未连接"}</h2>
              <p>{snapshot?.connection.endpoint ?? "ws://127.0.0.1:19429"}</p>
            </div>
          </div>
          <ReadSourcePicker
            sources={snapshot?.sources}
            value={readSource}
            onChange={selectReadSource}
          />
          <div className="source-list">
            <div>
              <span>对话列表</span>
              <strong>
                {snapshot?.sources.metadata ? "本机 SQLite · 可用" : "不可用"}
              </strong>
            </div>
            <div>
              <span>已读 / 未读</span>
              <strong>
                {snapshot?.sources.unread
                  ? "客户端持久化记录 · 可用"
                  : "不可用 / 身份不唯一"}
              </strong>
            </div>
            <div>
              <span>实时运行状态</span>
              <strong>
                {live ? "共享 App Server · 已连接" : "等待共享后端"}
              </strong>
            </div>
          </div>
          <p className="settings-note">
            {snapshot?.sources.unreadReason ?? "正在检查数据源"}
            。未读记录属于客户端内部格式，兼容性可能随版本变化。
          </p>
          <h3>接入实时状态</h3>
          <p className="settings-note">
            在本项目目录的独立终端运行以下命令，会自动以共享模式打开 Codex。若
            Codex 已打开，按提示退出即可，命令会继续启动。保持终端运行。
          </p>
          <pre className="setup-command">npm run codex-kanban-plugin</pre>
          <p className="settings-note">
            退出本次 Codex 后，命令会自动清理自己创建的后端。以后直接点击 Codex
            图标即可普通启动，无需恢复命令。
          </p>
          <p className="settings-note">
            仅观察共享后端上的本地对话。未加载、失去连接或没有数据的状态会显示为「状态待同步」，不会猜测任务已经完成。实时连接断开与单条对话执行失败分别显示。
          </p>
          <div className="data-boundary">
            <ShieldCheck size={16} />
            <span>不读取对话正文 · 不处理审批 · 不修改 Codex 数据</span>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function Lane({
  column,
  threads,
  onOpen,
  unreadAvailable,
  onConfigure,
}: {
  column: (typeof columns)[number];
  threads: Thread[];
  onOpen: (thread: Thread) => void;
  unreadAvailable: boolean;
  onConfigure: () => void;
}) {
  const [limit, setLimit] = useState(20);
  const unreadUnknown = column.id === "unread" && !unreadAvailable;
  return (
    <section className={`lane lane--${column.color}`} aria-label={column.label}>
      <div className="lane-heading">
        <div>
          <span className={`tiny-dot ${column.color}`} />
          <h2>{column.label}</h2>
          <span className="lane-count">
            {unreadUnknown ? "—" : threads.length}
          </span>
        </div>
      </div>
      <div className="lane-cards">
        {threads.slice(0, limit).map((thread) => (
          <button
            className="thread-card"
            key={thread.id}
            onClick={() => onOpen(thread)}
            title={`打开对话：${thread.title}`}
            aria-label={`打开对话：${thread.title}`}
          >
            <span className="card-top">
              <span className="card-project">
                <Folder size={12} />
                {thread.project}
              </span>
              {thread.unread === true && (
                <span
                  className="unread-marker"
                  title="未读"
                  aria-label="未读"
                />
              )}
              {thread.unread === null && (
                <span className="read-unknown" title="阅读状态未知">
                  ?
                </span>
              )}
            </span>
            <h3>{thread.title}</h3>
            <span className="card-model-info">
              <span className="model-tag" title="当前模型">
                {thread.model ?? "模型未知"}
              </span>
              <span className="effort-tag" title="思考等级">
                思考 · {thread.reasoningEffort ?? "未知"}
              </span>
            </span>
            <span className="card-bottom">
              <span
                className={`card-state ${columns.find((c) => c.id === columnFor(thread))?.color}`}
              >
                {columnFor(thread) === "running" ? (
                  <LoaderCircle size={11} className="spin" />
                ) : (
                  <span className="card-state-dot" />
                )}
                {column.id === "unread"
                  ? labelFor(thread)
                  : columnFor(thread) === "waiting"
                    ? waitingLabel(thread)
                    : thread.kind === "agent"
                      ? "子 Agent"
                      : columnFor(thread) === "unknown"
                        ? thread.runtime?.type === "notLoaded" && thread.fresh
                          ? "对话尚未加载"
                          : "实时状态未知"
                        : "本地对话"}
              </span>
              <span className="card-time">
                <Clock3 size={11} />
                {relativeTime(thread.updatedAt)}
              </span>
            </span>
          </button>
        ))}
        {!threads.length && (
          <div className="lane-empty">
            <span className="empty-lane-icon">
              {column.id === "waiting" ? (
                <Bell size={21} strokeWidth={1.2} />
              ) : column.id === "running" ? (
                <Activity size={21} strokeWidth={1.2} />
              ) : column.id === "unread" ? (
                <Radio size={21} strokeWidth={1.2} />
              ) : column.id === "error" ? (
                <ShieldCheck size={21} strokeWidth={1.2} />
              ) : (
                <SquareKanban size={21} strokeWidth={1.2} />
              )}
            </span>
            <span>
              {unreadUnknown
                ? "未读来源待选择"
                : column.id === "unread"
                  ? "暂无未读对话"
                  : "暂无对话"}
            </span>
            <small>
              {unreadUnknown ? "选择当前客户端对应的记录" : column.detail}
            </small>
            {unreadUnknown && (
              <button className="source-link" onClick={onConfigure}>
                选择未读来源
                <ChevronRight size={12} />
              </button>
            )}
          </div>
        )}
        {threads.length > limit && (
          <button className="load-more" onClick={() => setLimit(limit + 20)}>
            再显示 {Math.min(20, threads.length - limit)} 条
            <ChevronRight size={12} />
          </button>
        )}
      </div>
    </section>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <header className="modal-heading">
          <span>{title}</span>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}

function ReadSourcePicker({
  sources,
  value,
  onChange,
}: {
  sources?: Snapshot["sources"];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="read-source-picker">
      未读记录来源
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">自动（仅有唯一记录时启用）</option>
        {sources?.unreadOptions?.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label} · {option.count} 条未读
          </option>
        ))}
      </select>
      <span>
        多份本地记录时，请选择与你当前客户端对应的记录；无法确认时保持自动，未读将显示为未知。
      </span>
    </label>
  );
}

if (window.parent === window) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = media.matches ? "dark" : "light";
    document.documentElement.classList.toggle("dark", media.matches);
  };
  apply();
  media.addEventListener("change", apply);
}

createRoot(document.getElementById("root")!).render(<Board />);
