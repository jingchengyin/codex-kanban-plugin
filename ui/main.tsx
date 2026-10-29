import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownWideNarrow,
  Bell,
  ChevronRight,
  Clock3,
  Cpu,
  Folder,
  Languages,
  LoaderCircle,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquareKanban,
  Timer,
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
  needsAttention,
  waitingLabel,
  compareByLastUserMessage,
  type BoardColumn,
  type BoardScope,
  type Snapshot,
  type Thread,
} from "../shared/types";
import {
  launchLiveConnection,
  openConversation,
  readSnapshot,
  readThreadArtifacts,
  readWorkspace,
} from "./client";
import type {
  ArtifactDiscovery,
  DetectedArtifact,
  WorkItem,
  WorkspaceData,
} from "../shared/work-items";
import { ThreadWorkItems, ThreadWorkItemPicker } from "./thread-work-items";
import { ThreadMonitoring } from "./thread-monitoring";
import { DetectedArtifacts } from "./detected-artifacts";
import { ArtifactRulesSettings } from "./artifact-rules";
import { WorkItems, WorkReviewPanel } from "./workspace";
import {
  DEFAULT_FILTERS,
  isColumnVisible,
  matchesFilters,
  matchesQuery,
  compareAttention,
  activeFilterCount,
} from "./board-filters";
import {
  PREFERENCE_KEY,
  readBoardPreferences,
  type BoardPreferences,
} from "./board-preferences";
import {
  elapsedMs,
  formatDuration,
  formatTokens,
  goalLabels,
  isCurrentTurn,
} from "./card-metrics";
import { LanguageProvider, translate, useI18n, type Language } from "./i18n";
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
function relativeTime(value: string, language: Language) {
  const t = (text: string, count?: number) =>
    translate(language, text, { count: count ?? 0 });
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return minutes < 1
    ? t("刚刚")
    : minutes < 60
      ? t("{count} 分钟前", minutes)
      : minutes < 1440
        ? t("{count} 小时前", Math.floor(minutes / 60))
        : t("{count} 天前", Math.floor(minutes / 1440));
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
  const { language, setLanguage, locale, t } = useI18n();
  const [preferences] = useState(() => readBoardPreferences(localStorage));
  const [view, setView] = useState<BoardPreferences["view"]>(preferences.view);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [discovery, setDiscovery] = useState<ArtifactDiscovery>({
    artifacts: [],
    unavailableThreadIds: [],
  });
  const [artifactError, setArtifactError] = useState("");
  const [artifactRevision, setArtifactRevision] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<BoardScope>(preferences.scope);
  const [filters, setFilters] = useState<FilterValue>(preferences.filters);
  const [readSource, setReadSource] = useState<string | null>(() =>
    preference("read-source", null),
  );
  const readSourceRef = useRef(readSource);
  const [sort, setSort] = useState<BoardPreferences["sort"]>(preferences.sort);
  const [layout, setLayout] = useState<BoardPreferences["layout"]>(
    preferences.layout,
  );
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const listLayout = layout === "list" || (layout === "auto" && narrow);
  const [addingThread, setAddingThread] = useState<Thread | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [launching, setLaunching] = useState(false);
  const inFlight = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const next = await readSnapshot(readSourceRef.current);
      // 元数据暂不可读时保留已展示的本地对话，并取消其运行状态认证。
      setSnapshot((previous) =>
        !next.sources.metadata && previous
          ? {
              ...next,
              threads: previous.threads.map((thread) => ({
                ...thread,
                fresh: false,
              })),
            }
          : next,
      );
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
    try {
      localStorage.setItem(
        PREFERENCE_KEY,
        JSON.stringify({ view, scope, filters, sort, layout }),
      );
    } catch {
      /* 存储不可用时仍可继续使用当前视图。 */
    }
  }, [view, scope, filters, sort, layout]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // 卡片和事项页共用最新关联结果，切回看板后重新读取持久化记录。
  useEffect(() => {
    if (view !== "board") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refreshItems = async () => {
      try {
        const data = await readWorkspace();
        if (!cancelled) {
          setWorkItems(data.items);
          setWorkspaceError("");
        }
      } catch (error) {
        if (!cancelled)
          setWorkspaceError(
            error instanceof Error ? error.message : "读取工作事项失败",
          );
      } finally {
        if (!cancelled) timer = setTimeout(() => void refreshItems(), 15000);
      }
    };
    void refreshItems();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, workspaceRevision]);
  const updateWorkspace = (data: WorkspaceData) => {
    setWorkItems(data.items);
    setWorkspaceError("");
    setWorkspaceRevision((value) => value + 1);
  };
  const openWorkItem = (id: string) => {
    setOpenItemId(id);
    setView("items");
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    const keys = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "k" &&
        viewRef.current === "board"
      ) {
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
  // 看板统计和项目选项也只包含普通对话。
  const boardThreads = useMemo(
    () => threads.filter((thread) => thread.kind === "user"),
    [threads],
  );
  const itemsByThread = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of workItems)
      for (const id of item.threadIds)
        map.set(id, [...(map.get(id) ?? []), item]);
    return map;
  }, [workItems]);
  const filtered = useMemo(
    () =>
      boardThreads.filter(
        (thread) =>
          matchesFilters(thread, filters) &&
          matchesQuery(
            thread,
            query,
            itemsByThread.get(thread.id)?.map((item) => item.title),
          ),
      ),
    [boardThreads, filters, query, itemsByThread],
  );
  const attentionCount = filtered.filter(needsAttention).length;
  const projects = [
    ...new Set(boardThreads.map((thread) => thread.project)),
  ].sort((a, b) => a.localeCompare(b, locale));
  const visibleColumns = columns
    .filter((column) => isColumnVisible(column.id, filters.state, scope))
    .filter(
      (column) =>
        column.id !== "unknown" ||
        filtered.some((thread) => columnFor(thread) === "unknown"),
    )
    .map((column) => ({
      ...column,
      label: t(column.label),
      detail: t(column.detail),
    }));
  const displayed = useMemo(
    () =>
      filtered
        .filter((thread) => scope !== "attention" || needsAttention(thread))
        .sort((a, b) =>
          sort === "title"
            ? a.title.localeCompare(b.title, locale)
            : sort === "priority"
              ? compareAttention(a, b)
              : compareByLastUserMessage(a, b),
        ),
    [filtered, scope, sort, locale],
  );
  // 相同对话集合共用一次批量读取，不随运行状态轮询或排序重启。
  const artifactThreadKey = JSON.stringify(
    displayed.map((thread) => thread.id).sort(),
  );
  useEffect(() => {
    if (view !== "board" || artifactThreadKey === "[]") return;
    const threadIds = JSON.parse(artifactThreadKey) as string[];
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 15000;
    const refreshArtifacts = async () => {
      if (cancelled || inFlight || document.hidden) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const data = await readThreadArtifacts(threadIds);
        if (cancelled) return;
        setDiscovery(data);
        setArtifactError("");
        delay = data.pendingThreadIds?.length ? 2500 : 15000;
      } catch (reason) {
        if (!cancelled)
          setArtifactError(
            reason instanceof Error ? reason.message : "读取成果失败",
          );
      } finally {
        inFlight = false;
        if (!cancelled)
          timer = setTimeout(() => void refreshArtifacts(), delay);
      }
    };
    const visible = () => {
      if (!document.hidden) void refreshArtifacts();
    };
    setArtifactError("");
    void refreshArtifacts();
    document.addEventListener("visibilitychange", visible);
    return () => {
      // 切换筛选或离开看板后，旧集合的响应不再覆盖当前成果。
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [artifactThreadKey, view, artifactRevision]);
  const artifactsByThread = useMemo(() => {
    const grouped = new Map<string, DetectedArtifact[]>();
    for (const artifact of discovery.artifacts) {
      const artifacts = grouped.get(artifact.threadId) ?? [];
      artifacts.push(artifact);
      grouped.set(artifact.threadId, artifacts);
    }
    return grouped;
  }, [discovery]);
  const pendingArtifacts = useMemo(
    () => new Set(discovery.pendingThreadIds ?? []),
    [discovery],
  );
  const live = snapshot?.connection.state === "connected" && !fetchError;
  const loading = !snapshot && !fetchError;
  const syncingThreads = snapshot?.syncingThreads === true && !fetchError;
  // 首次同步暂无可展示对话时复用加载占位，已有卡片保持可见。
  const loadingBoard = loading || (syncingThreads && !displayed.length);
  const activeFilters = activeFilterCount(filters);
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

  /** 打开独立启动入口，由用户按提示退出客户端后继续连接。 */
  async function launchLive() {
    setLaunching(true);
    try {
      const result = await launchLiveConnection();
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法打开实时启动器");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="app-shell">
      <main className="main">
        <header className="workspace-nav">
          <div
            className="workspace-nav-tabs"
            role="tablist"
            aria-label={t("工作台视图")}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const views = ["board", "items", "review"] as const;
              const index = views.indexOf(view);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + 3) % 3;
              setView(views[next]);
              document.getElementById(`workspace-tab-${views[next]}`)?.focus();
            }}
          >
            {(
              [
                ["board", "对话看板"],
                ["items", "工作事项"],
                ["review", "工作回顾"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`workspace-tab-${id}`}
                role="tab"
                aria-selected={view === id}
                aria-controls={`workspace-panel-${id}`}
                tabIndex={view === id ? 0 : -1}
                onClick={() => setView(id)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <label className="language-picker">
            <Languages size={14} aria-hidden="true" />
            <select
              aria-label="Language"
              value={language}
              onChange={(event) =>
                setLanguage(event.target.value === "CN" ? "CN" : "EN")
              }
            >
              <option value="EN" lang="en">
                EN
              </option>
              <option value="CN" lang="zh-CN">
                CN
              </option>
            </select>
          </label>
          <button
            className={`connection-pill ${live ? "is-live" : "is-offline"}`}
            onClick={() => setSettings(true)}
            aria-label={t("连接与数据源")}
            title={t("连接与数据源")}
          >
            {live ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>
              {live
                ? t("已连接")
                : snapshot?.connection.state === "connecting"
                  ? t("连接中")
                  : t("未连接")}
            </span>
            <span className="connection-dot" />
          </button>
        </header>
        <section
          className="board-section"
          id="workspace-panel-board"
          role="tabpanel"
          aria-labelledby="workspace-tab-board"
          hidden={view !== "board"}
        >
          <div className="board-toolbar">
            <SegmentedControl<BoardScope>
              options={[
                {
                  value: "all",
                  label: t("全部对话"),
                  count: filtered.length,
                },
                {
                  value: "attention",
                  label: t("需要关注"),
                  count: attentionCount,
                },
              ]}
              value={scope}
              onChange={setScope}
              size="sm"
              variant="underline"
              aria-label={t("对话范围")}
            />
            <div className="toolbar-actions">
              <label className="search">
                <Search size={15} />
                <input
                  ref={search}
                  aria-label={t("搜索对话")}
                  placeholder={t("搜索标题、输入或事项…")}
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
                {t("筛选")}
                {activeFilters ? ` ${activeFilters}` : ""}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={
                  <RefreshCw size={14} className={refreshing ? "spin" : ""} />
                }
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                {t("刷新")}
              </Button>
            </div>
          </div>
          {fetchError && (
            <div className="data-notice" role="alert">
              <Unplug size={14} /> {t(fetchError)}
              {t("。当前显示最后一次快照。")}
            </div>
          )}
          {artifactError && (
            <div className="data-notice" role="alert">
              {t("读取成果失败")} · {t(artifactError)}
            </div>
          )}
          {workspaceError && (
            <div className="data-notice" role="alert">
              {t(workspaceError)}
            </div>
          )}
          {snapshot && !snapshot.sources.metadata && (
            <div className="data-notice" role="alert">
              {snapshot.sources.metadataError &&
                t(snapshot.sources.metadataError)}
            </div>
          )}
          {filterOpen && (
            <div className="filter-area">
              <FilterMenu
                title={t("筛选对话")}
                hints={false}
                labels={{
                  clearAll: t("清除全部"),
                  remove: (label) => t("移除 {label}", { label }),
                  more: (count, labels) =>
                    t("另有 {count} 项：{labels}", { count, labels }),
                  selected: (count) => t("{count} 项筛选", { count }),
                }}
                groups={[
                  {
                    id: "state",
                    label: t("运行状态"),
                    options: columns
                      .filter((c) => c.id !== "unread")
                      .map((c) => ({ id: c.id, label: t(c.label) })),
                  },
                  {
                    id: "read",
                    label: t("阅读状态"),
                    options: [
                      { id: "unread", label: t("未读") },
                      { id: "read", label: t("已读") },
                      { id: "unknown", label: t("未知") },
                    ],
                  },
                  {
                    id: "project",
                    label: t("项目"),
                    options: projects.map((project) => ({
                      id: project,
                      label: project,
                    })),
                  },
                ]}
                value={filters}
                onChange={(next) => setFilters({ ...DEFAULT_FILTERS, ...next })}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<X size={14} />}
                onClick={() => setFilterOpen(false)}
              >
                {t("收起筛选")}
              </Button>
            </div>
          )}
          <div className="board-meta">
            <span>
              {syncingThreads && displayed.length > 0 ? (
                <ThinkingLoader
                  phases={[t("正在同步最近的对话状态…")]}
                  phase={0}
                  size="sm"
                  variant="plain"
                />
              ) : (
                <>
                  <span className={`tiny-dot ${live ? "green" : ""}`} />
                  {loading
                    ? t("正在读取本地对话")
                    : t("{count} 条对话", { count: displayed.length })}
                </>
              )}
            </span>
            <div className="board-meta-actions">
              {snapshot && (
                <span className="updated-at">
                  {t("更新于")}{" "}
                  {new Date(snapshot.generatedAt).toLocaleTimeString(locale, {
                    hour12: false,
                  })}
                </span>
              )}
              {!displayed.length && boardThreads.length > 0 && (
                <button
                  className="sort-button"
                  onClick={() => {
                    setQuery("");
                    setFilters(DEFAULT_FILTERS);
                    setScope("all");
                  }}
                >
                  {t("重置筛选")}
                </button>
              )}
              <label className="board-select">
                <ArrowDownWideNarrow size={13} aria-hidden="true" />
                <select
                  aria-label={t("排序方式")}
                  value={sort}
                  onChange={(e) =>
                    setSort(e.target.value as BoardPreferences["sort"])
                  }
                >
                  <option value="priority">{t("优先处理")}</option>
                  <option value="recent">{t("最近发消息")}</option>
                  <option value="title">{t("标题排序")}</option>
                </select>
              </label>
              <label className="board-select">
                <SquareKanban size={13} aria-hidden="true" />
                <select
                  aria-label={t("布局方式")}
                  value={layout}
                  onChange={(e) =>
                    setLayout(e.target.value as BoardPreferences["layout"])
                  }
                >
                  <option value="auto">{t("自动布局")}</option>
                  <option value="board">{t("看板")}</option>
                  <option value="list">{t("紧凑列表")}</option>
                </select>
              </label>
            </div>
          </div>
          {loadingBoard ? (
            <div className="loading-board">
              <ThinkingLoader
                phases={[
                  t(
                    syncingThreads
                      ? "正在同步最近的对话状态…"
                      : "正在读取本地对话",
                  ),
                ]}
                phase={0}
              />
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
          ) : !displayed.length ? (
            <div className="board-empty" role="status">
              <SquareKanban size={26} strokeWidth={1.3} />
              <p>
                {t(
                  scope === "attention"
                    ? "当前没有需要关注的对话"
                    : "没有匹配的对话",
                )}
              </p>
              <small>{t("可调整搜索或筛选条件。")}</small>
            </div>
          ) : listLayout ? (
            <ConversationList
              threads={displayed}
              onOpen={open}
              artifactsByThread={artifactsByThread}
              pendingArtifacts={pendingArtifacts}
              onArtifactError={setToast}
              workItems={workItems}
              onAddItem={setAddingThread}
              onOpenItem={openWorkItem}
            />
          ) : (
            <div
              className="kanban"
              aria-busy={syncingThreads}
              style={
                { "--lane-count": visibleColumns.length } as React.CSSProperties
              }
            >
              {visibleColumns.map((column) => (
                <Lane
                  key={column.id}
                  column={column}
                  threads={displayed.filter((thread) =>
                    belongsToColumn(thread, column.id, scope),
                  )}
                  onOpen={(thread) => void open(thread)}
                  unreadAvailable={snapshot?.sources.unread ?? false}
                  onConfigure={() => setSettings(true)}
                  artifactsByThread={artifactsByThread}
                  pendingArtifacts={pendingArtifacts}
                  onArtifactError={setToast}

                  workItems={workItems}
                  onAddItem={setAddingThread}
                  onOpenItem={openWorkItem}
                />
              ))}
            </div>
          )}
        </section>
        <div
          id="workspace-panel-items"
          role="tabpanel"
          aria-labelledby="workspace-tab-items"
          hidden={view !== "items"}
        >
          <WorkItems
            active={view === "items"}
            threads={threads}
            artifactRevision={artifactRevision}
            onChanged={updateWorkspace}
            openItem={workItems.find((item) => item.id === openItemId) ?? null}
            onItemOpened={() => setOpenItemId(null)}
          />
        </div>
        <div
          id="workspace-panel-review"
          role="tabpanel"
          aria-labelledby="workspace-tab-review"
          hidden={view !== "review"}
        >
          <WorkReviewPanel active={view === "review"} />
        </div>
      </main>
      {settings && (
        <Modal title={t("连接与数据源")} onClose={() => setSettings(false)}>
          <div className="source-status">
            <span className={live ? "source-icon live" : "source-icon"}>
              {live ? <Wifi size={22} /> : <WifiOff size={22} />}
            </span>
            <div>
              <h2>
                {live ? t("共享状态服务已连接") : t("实时状态服务未连接")}
              </h2>
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
              <span>{t("对话列表")}</span>
              <strong>
                {snapshot?.sources.metadata
                  ? t("本机 SQLite · 可用")
                  : t("不可用")}
              </strong>
            </div>
            <div>
              <span>{t("已读 / 未读")}</span>
              <strong>
                {snapshot?.sources.unread
                  ? t("客户端持久化记录 · 可用")
                  : t("不可用 / 身份不唯一")}
              </strong>
            </div>
            <div>
              <span>{t("实时运行状态")}</span>
              <strong>
                {live ? t("共享 App Server · 已连接") : t("等待共享后端")}
              </strong>
            </div>
          </div>
          <p className="settings-note">
            {t(snapshot?.sources.unreadReason ?? "正在检查数据源")}
            {t("。未读记录属于客户端内部格式，兼容性可能随版本变化。")}
          </p>
          <ArtifactRulesSettings
            onSaved={() => setArtifactRevision((current) => current + 1)}
          />
          <h3>{t("接入实时状态")}</h3>
          <div className="workspace-live-action">
            <Button
              icon={<Radio size={14} />}
              loading={launching}
              onClick={() => void launchLive()}
            >
              {t("打开实时启动器")}
            </Button>
          </div>
          <p className="settings-note">
            {t(
              "点击按钮即可打开启动器，无需输入命令。若 Codex 已打开，请按提示用 ⌘Q 完全退出，启动器会自动继续。",
            )}
          </p>
          <p className="settings-note">{t("也可在插件目录的独立终端运行：")}</p>
          <pre className="setup-command">npm run codex-kanban-plugin</pre>
          <p className="settings-note">
            {t(
              "关闭启动终端不会影响 Codex。退出 Codex 后，后端会自动停止；以后直接点击 Codex 图标即可普通启动。",
            )}
          </p>
          <p className="settings-note">
            {t(
              "仅观察共享后端上的本地对话。未加载、失去连接或没有数据的状态会显示为「状态待同步」，不会猜测任务已经完成。实时连接断开与单条对话执行失败分别显示。",
            )}
          </p>
          <div className="data-boundary">
            <ShieldCheck size={16} />
            <span>{t("仅展示本机数据 · 不处理审批 · 不修改 Codex 数据")}</span>
          </div>
        </Modal>
      )}
      {addingThread && (
        <ThreadWorkItemPicker
          thread={addingThread}
          items={workItems}
          onChanged={updateWorkspace}
          onClose={() => setAddingThread(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {t(toast)}
        </div>
      )}
    </div>
  );
}

type CardActions = {
  onOpen: (thread: Thread) => void;
  artifactsByThread: Map<string, DetectedArtifact[]>;
  pendingArtifacts: Set<string>;
  onArtifactError: (message: string) => void;
  workItems: WorkItem[];
  onAddItem: (thread: Thread) => void;
  onOpenItem: (id: string) => void;
};

/** 卡片在看板和紧凑列表中共用跳转、待处理信息和事项关联入口。 */
function ThreadCard({
  thread,
  compact = false,
  onOpen,
  artifactsByThread,
  pendingArtifacts,
  onArtifactError,
  workItems,
  onAddItem,
  onOpenItem,
}: CardActions & { thread: Thread; compact?: boolean }) {
  const { language, locale, t } = useI18n();
  const state = columnFor(thread);
  const metrics = (
    <>
      <span className="card-model-info">
        <span className="model-tag" title={t("当前模型")}>
          {thread.model ?? t("模型未知")}
        </span>
        <span className="effort-tag" title={t("思考等级")}>
          {t("思考")} · {thread.reasoningEffort ?? t("未知")}
        </span>
        <span
          className={`mode-tag ${thread.collaborationMode === "plan" ? "is-plan" : ""}`}
          title={t("当前或最近一轮的协作模式")}
        >
          {thread.collaborationMode === "plan"
            ? t("计划模式")
            : thread.collaborationMode === "default"
              ? t("默认模式")
              : t("模式未知")}
        </span>
        <span
          className={`goal-tag ${thread.goalStatus === "active" ? "is-active" : ""}`}
        >
          {thread.goalStatus
            ? t(goalLabels[thread.goalStatus])
            : t("目标状态未知")}
        </span>
      </span>
      <span className="card-usage">
        <span className="usage-scope">
          {isCurrentTurn(thread)
            ? t("本轮")
            : thread.turnUsage?.status === "inProgress" || !thread.turnUsage
              ? t("最近一轮")
              : t("上轮")}
        </span>
        <span
          title={
            thread.turnUsage?.tokens != null
              ? t("本轮累计 {count} tokens，包含输入、缓存输入和输出", {
                  count: thread.turnUsage.tokens.toLocaleString(locale),
                })
              : t("本轮累计 token 数据不可用")
          }
        >
          <Cpu size={11} />
          {formatTokens(thread.turnUsage?.tokens ?? null, language)}
        </span>
        <span
          title={t(
            "这一轮从开始到结束的累计耗时；运行时持续更新，断线后暂停计时",
          )}
        >
          <Timer size={11} />
          {formatDuration(elapsedMs(thread), language)}
        </span>
      </span>
    </>
  );
  return (
    <article className={`thread-card ${compact ? "is-compact" : ""}`}>
      <button
        className="thread-card-open"
        onClick={() => onOpen(thread)}
        title={t("打开对话：{title}", { title: thread.title })}
        aria-label={t("打开对话：{title}", { title: thread.title })}
        aria-describedby={`thread-input-${thread.id}`}
      >
        <span className="card-top">
          <span className="card-project">
            <Folder size={12} />
            {thread.project}
          </span>
          {thread.unread === true && (
            <span
              className="unread-marker"
              title={t("未读")}
              aria-label={t("未读")}
            />
          )}
          {thread.unread === null && (
            <span className="read-unknown" title={t("阅读状态未知")}>
              ?
            </span>
          )}
        </span>
        <h3>{thread.title}</h3>
        {state === "waiting" && (
          <span className="card-attention">
            <span className="card-attention-label">
              {t(waitingLabel(thread))}
            </span>
            {thread.waitingQuestion && (
              <span className="card-attention-text">
                {thread.waitingQuestion}
              </span>
            )}
            {thread.waitingSince && (
              <span
                className="card-wait-duration"
                title={t(
                  "从本次连接首次观察到等待开始计时，不代表问题实际发出时间。",
                )}
              >
                {t("已观察到等待 {duration}", {
                  duration: formatDuration(
                    Math.max(0, Date.now() - Date.parse(thread.waitingSince)),
                    language,
                  ),
                })}
              </span>
            )}
          </span>
        )}
        {state === "error" && (
          <span className="card-attention is-error">
            <span className="card-attention-label">{t("执行异常")}</span>
            <span className="card-attention-text">
              {thread.error?.message || t("打开原对话查看异常并处理。")}
            </span>
          </span>
        )}
        <span className="card-input">
          <span className="card-input-label">
            {isCurrentTurn(thread)
              ? t("本轮输入")
              : thread.turnUsage?.status === "inProgress" || !thread.turnUsage
                ? t("最近一轮输入")
                : t("上轮输入")}
          </span>
          <span className="card-input-text" id={`thread-input-${thread.id}`}>
            {thread.turnUsage?.userInput === ""
              ? t("未输入文字")
              : (thread.turnUsage?.userInput ?? t("未获取到用户输入"))}
          </span>
        </span>
        {!compact && metrics}
        <span className="card-bottom">
          <span
            className={`card-state ${columns.find((c) => c.id === columnFor(thread))?.color}`}
          >
            {columnFor(thread) === "running" ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <span className="card-state-dot" />
            )}
            {columnFor(thread) === "unknown"
              ? thread.runtime?.type === "notLoaded" && thread.fresh
                ? t("对话尚未加载")
                : t("实时状态未知")
              : t(labelFor(thread))}
          </span>
          <span className="card-time" title={t("最近一次用户发消息的时间")}>
            <Clock3 size={11} />
            {thread.lastUserMessageAt
              ? relativeTime(thread.lastUserMessageAt, language)
              : t("发消息时间未知")}
          </span>
        </span>
      </button>
      <ThreadMonitoring thread={thread} onError={onArtifactError} />
      {compact && (
        <details className="card-run-details">
          <summary>{t("运行详情")}</summary>
          {metrics}
        </details>
      )}
      {(artifactsByThread.has(thread.id) ||
        pendingArtifacts.has(thread.id)) && (
        <div
          className="card-artifacts"
          aria-busy={pendingArtifacts.has(thread.id)}
        >
          <span className="card-artifacts-label">{t("成果")}</span>
          <DetectedArtifacts
            artifacts={artifactsByThread.get(thread.id) ?? []}
            threads={[thread]}
            showSource={false}
            onError={onArtifactError}
          />
          {pendingArtifacts.has(thread.id) && (
            <ThinkingLoader
              phases={[t("正在识别成果…")]}
              phase={0}
              size="sm"
              variant="plain"
            />
          )}
        </div>
      )}
      <ThreadWorkItems
        thread={thread}
        items={workItems}
        onAdd={() => onAddItem(thread)}
        onOpenItem={onOpenItem}
      />
    </article>
  );
}

/** 列表分页限制首屏渲染数量，窄窗口内保持单向滚动。 */
function ConversationList({
  threads,
  ...cardActions
}: CardActions & { threads: Thread[] }) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(40);
  useEffect(
    () => setLimit(40),
    [
      threads
        .map((thread) => thread.id)
        .sort()
        .join("|"),
    ],
  );
  return (
    <div className="conversation-list">
      {threads.slice(0, limit).map((thread) => (
        <ThreadCard key={thread.id} thread={thread} compact {...cardActions} />
      ))}
      {threads.length > limit && (
        <button
          className="load-more"
          onClick={() => setLimit((value) => value + 40)}
        >
          {t("再显示 {count} 条", {
            count: Math.min(40, threads.length - limit),
          })}
          <ChevronRight size={12} />
        </button>
      )}
    </div>
  );
}

/** 宽屏看板继续按状态分列，卡片操作由两种布局共用。 */
function Lane({
  column,
  threads,
  unreadAvailable,
  onConfigure,
  ...cardActions
}: CardActions & {
  column: (typeof columns)[number];
  threads: Thread[];
  unreadAvailable: boolean;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
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
          <ThreadCard key={thread.id} thread={thread} {...cardActions} />
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
                ? t("未读来源待选择")
                : column.id === "unread"
                  ? t("暂无未读对话")
                  : t("暂无对话")}
            </span>
            <small>
              {unreadUnknown ? t("选择当前客户端对应的记录") : column.detail}
            </small>
            {unreadUnknown && (
              <button className="source-link" onClick={onConfigure}>
                {t("选择未读来源")}
                <ChevronRight size={12} />
              </button>
            )}
          </div>
        )}
        {threads.length > limit && (
          <button className="load-more" onClick={() => setLimit(limit + 20)}>
            {t("再显示 {count} 条", {
              count: Math.min(20, threads.length - limit),
            })}
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
  const { t } = useI18n();
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
          <button
            className="icon-button"
            aria-label={t("关闭")}
            onClick={onClose}
          >
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
  const { t } = useI18n();
  return (
    <label className="read-source-picker">
      {t("未读记录来源")}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t("自动（优先普通启动记录）")}</option>
        {sources?.unreadOptions?.map((option) => (
          <option key={option.key} value={option.key}>
            {t(option.label).replace(/^本地记录/, t("本地记录"))} ·{" "}
            {t("{count} 条未读", { count: option.count })}
          </option>
        ))}
      </select>
      <span>
        {t(
          "自动优先复用普通启动记录，未读数只统计看板中的普通对话。来源无法自动确定时，请手动选择。",
        )}
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

createRoot(document.getElementById("root")!).render(
  <LanguageProvider>
    <Board />
  </LanguageProvider>,
);
