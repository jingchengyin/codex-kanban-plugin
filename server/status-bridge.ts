import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readLocalData } from "./local-data.js";
import { DesktopIpc, type DesktopConversation } from "./desktop-ipc.js";
import { DesktopConfirmations } from "./desktop-confirmations.js";
import { readConfirmations, replyToConfirmation } from "./confirmations.js";
import type { ConfirmationReply } from "../shared/confirmations.js";
import {
  hasUnansweredInput,
  inputState,
  unansweredInput,
} from "./user-input.js";
import { columnFor, compareByLastUserMessage } from "../shared/types.js";
import type {
  ConnectionState,
  RuntimeStatus,
  Snapshot,
  Thread,
} from "../shared/types.js";

const now = () => new Date().toISOString();
export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "TASKBOARD_WS_URL 仅支持无凭据、路径或查询参数的本机 loopback ws:// 地址",
    );
  }
  return url.toString();
}
/** 同步本机对话运行状态和待答标记，首次打开时加载最近的待同步对话。 */
export class StatusBridge {
  private desktop?: DesktopIpc;
  private desktopConfirmations?: DesktopConfirmations;
  private observationLease?: ReturnType<typeof setTimeout>;
  private socket?: WebSocket;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private hydration?: ReturnType<typeof setInterval>;
  private requestId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private runtime = new Map<
    string,
    {
      status: RuntimeStatus;
      at: string;
      error: Thread["error"];
      waitingSince: string | null;
    }
  >();
  private ephemeral = new Map<string, Thread>();
  private userInput = new Map<string, ReturnType<typeof inputState>>();
  private inputEpoch = new Map<string, number>();
  private modes = new Map<
    string,
    Partial<Pick<Thread, "collaborationMode" | "goalStatus">>
  >();
  private connection: Snapshot["connection"];
  private cache?: {
    at: number;
    selection: string | null;
    data: Awaited<ReturnType<typeof readLocalData>>;
  };
  private refreshing?: Promise<void>;
  private initialSyncRequested = false;
  private initialSync?: Promise<void>;
  private initialSyncComplete = false;
  readonly endpoint: string;
  readonly home: string;

  constructor(options: { endpoint?: string; home?: string } = {}) {
    this.home = options.home ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`;
    const websocket = options.endpoint ?? process.env.TASKBOARD_WS_URL;
    this.endpoint = websocket
      ? localEndpoint(websocket)
      : `ipc://${join(this.home, "ipc", "ipc.sock")}`;
    this.connection = {
      state: "connecting",
      endpoint: this.endpoint,
      since: null,
      message: null,
    };
    if (!websocket) {
      this.desktop = new DesktopIpc({
        home: this.home,
        onState: (state, message) => {
          this.state(state, message ?? null);
          if (state === "connected") this.initialSyncComplete = true;
        },
        onConversation: (id, value) => this.rememberDesktop(id, value),
        onUnavailable: (id) => {
          this.userInput.delete(id);
          this.modes.delete(id);
          const runtime = this.runtime.get(id);
          if (runtime) runtime.waitingSince = null;
          this.desktopConfirmations?.remove(id);
        },
      });
      this.desktopConfirmations = new DesktopConfirmations(this.desktop);
    }
  }
  start() {
    this.stopped = false;
    if (this.desktop) this.desktop.start();
    else this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.hydration);
    clearTimeout(this.observationLease);
    this.desktop?.stop();
    this.desktopConfirmations?.clear();
    this.socket?.close();
    this.failPending();
  }
  /** UI 心跳续租当前观察集合，宿主直接销毁面板后也会自动退订。 */
  private observeDesktop(threadIds: string[]) {
    if (!this.desktop) return;
    this.desktop.watch(threadIds);
    clearTimeout(this.observationLease);
    if (threadIds.length) {
      this.observationLease = setTimeout(() => this.desktop?.watch([]), 15000);
      this.observationLease.unref();
    }
  }

  /** 从原窗口快照恢复状态与提问，历史索引继续由本地读取提供。 */
  private rememberDesktop(id: string, value: DesktopConversation) {
    const state = value.state;
    this.remember({
      id,
      title: state.title,
      cwd: state.cwd,
      source: state.source,
      // 桌面状态使用毫秒，复用 App Server 映射前转回秒。
      updatedAt:
        typeof state.updatedAt === "number"
          ? state.updatedAt / 1000
          : undefined,
      status: state.threadRuntimeStatus,
    });
    const collaboration =
      state.latestCollaborationMode?.mode ?? state.latestCollaborationMode;
    const goal = state.threadGoal?.status ?? "none";
    this.modes.set(id, {
      collaborationMode: ["plan", "default"].includes(collaboration)
        ? collaboration
        : null,
      goalStatus: [
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete",
        "none",
      ].includes(goal)
        ? goal
        : null,
    });
    // canonical 历史与普通 turns 使用同一批消息，保持原生异步提问的判定。
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
      // 当前回合可能只带较短的实时尾部，按消息 ID 补全 canonical 中已有内容。
      const items = new Map<unknown, any>();
      for (const item of [...(previous?.items ?? []), ...(turn.items ?? [])])
        items.set(item?.id ?? item, item);
      byId.set(key, { ...previous, ...turn, items: [...items.values()] });
    }
    const nativeTurns = [...byId.values()];
    const items = nativeTurns
      .flatMap((turn: any) => turn.items ?? [])
      .map((item: any) =>
        // 桌面会把已接收的续写消息折叠为 steering，仍应视作用户已回复。
        item?.type === "steeringUserMessage" && item.status === "accepted"
          ? { ...item, type: "userMessage" }
          : item,
      );
    const previous = this.userInput.get(id);
    this.userInput.set(id, inputState("desktop", items));
    const current = this.userInput.get(id)!;
    for (const [key, question] of current.pending) {
      const known = previous?.pending.get(key);
      if (known) question.since = known.since;
    }
    const runtime = this.runtime.get(id);
    const latestTurn: any = nativeTurns.at(-1);
    if (runtime)
      runtime.error =
        latestTurn?.status === "failed"
          ? { message: "本轮执行失败，请在原对话查看详情。", at: runtime.at }
          : null;
    this.desktopConfirmations?.update(id, value);
  }
  private state(state: ConnectionState, message: string | null = null) {
    this.connection = { state, endpoint: this.endpoint, since: now(), message };
  }
  private failPending() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("共享状态连接已断开"));
    }
    this.pending.clear();
  }
  private connect() {
    if (this.stopped) return;
    this.state("connecting");
    const socket = (this.socket = new WebSocket(this.endpoint));
    let disconnected = false;
    const lose = () => {
      if (disconnected || this.socket !== socket) return;
      disconnected = true;
      clearInterval(this.hydration);
      this.failPending();
      if (!this.stopped) {
        this.state("disconnected", "未连接共享状态服务，实时状态暂不可用。");
        this.retry = setTimeout(() => this.connect(), 4000);
      }
    };
    const timeout = setTimeout(() => {
      socket.close();
      lose();
    }, 6000);
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      lose();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      lose();
    });
    socket.addEventListener("message", (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending && !message.method) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error("状态查询失败"));
        else pending.resolve(message.result);
      } else if (message.method && message.id === undefined)
        this.notification(message.method, message.params ?? {});
      // Server requests (including approvals) belong to Codex; never answer them.
    });
    socket.addEventListener("open", async () => {
      clearTimeout(timeout);
      try {
        await this.request("initialize", {
          clientInfo: { name: "codex_taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        if (this.socket !== socket || disconnected) return;
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        // A new connection cannot certify the freshness of an old runtime cache.
        this.runtime.clear();
        this.ephemeral.clear();
        this.userInput.clear();
        this.inputEpoch.clear();
        this.modes.clear();
        this.state("connected");
        await this.hydrate();
        this.beginInitialSync();
        this.hydration = setInterval(() => {
          void this.hydrate().catch(() => {
            this.state("disconnected", "实时状态查询失败，正在重新连接。");
            socket.close();
          });
        }, 10000);
      } catch {
        socket.close();
        lose();
      }
    });
  }
  private request(method: string, params: object): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("未连接共享状态服务"));
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("状态查询超时"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 更新原生状态，只在首次进入等待时记录起点，定期读取不会重置。 */
  private rememberStatus(threadId: string, status: RuntimeStatus) {
    const previous = this.runtime.get(threadId);
    const at = now();
    const waiting =
      status.type === "active" &&
      status.activeFlags?.some(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      );
    this.runtime.set(threadId, {
      status,
      at,
      error: previous?.error ?? null,
      waitingSince: waiting ? (previous?.waitingSince ?? at) : null,
    });
    if (!["active", "idle"].includes(status.type))
      this.userInput.delete(threadId);
  }
  private remember(thread: any) {
    if (!thread || typeof thread.id !== "string") return;
    if (
      thread.status &&
      ["active", "idle", "notLoaded", "systemError"].includes(
        thread.status.type,
      )
    )
      this.rememberStatus(thread.id, thread.status);
    this.ephemeral.set(thread.id, {
      id: thread.id,
      title:
        typeof thread.name === "string"
          ? thread.name
          : typeof thread.title === "string"
            ? thread.title
            : "未命名对话",
      cwd: thread.cwd ?? "",
      project: basename(thread.cwd ?? "") || "未归属项目",
      updatedAt:
        typeof thread.updatedAt === "number"
          ? new Date(thread.updatedAt * 1000).toISOString()
          : now(),
      lastUserMessageAt: null,
      kind:
        typeof thread.source === "object" && thread.source?.subAgent
          ? "agent"
          : "unknown",
      unread: null,
      model: null,
      reasoningEffort: null,
      collaborationMode: null,
      goalStatus: null,
      turnUsage: null,
      runtime: null,
      runtimeAt: null,
      fresh: false,
      error: null,
    });
  }
  private notification(method: string, params: any) {
    if (
      method === "thread/settings/updated" &&
      typeof params.threadId === "string"
    ) {
      const mode = params.threadSettings?.collaborationMode?.mode;
      if (mode === "plan" || mode === "default")
        this.modes.set(params.threadId, {
          ...this.modes.get(params.threadId),
          collaborationMode: mode,
        });
    }
    if (
      method === "thread/goal/updated" &&
      typeof params.threadId === "string"
    ) {
      const status = params.goal?.status;
      if (
        [
          "active",
          "paused",
          "blocked",
          "usageLimited",
          "budgetLimited",
          "complete",
        ].includes(status)
      )
        this.modes.set(params.threadId, {
          ...this.modes.get(params.threadId),
          goalStatus: status,
        });
    }
    if (method === "thread/goal/cleared" && typeof params.threadId === "string")
      this.modes.set(params.threadId, {
        ...this.modes.get(params.threadId),
        goalStatus: "none",
      });
    if (
      ["turn/started", "turn/completed", "thread/closed"].includes(method) &&
      typeof params.threadId === "string"
    )
      this.inputEpoch.set(
        params.threadId,
        (this.inputEpoch.get(params.threadId) ?? 0) + 1,
      );
    if (method === "thread/started") this.remember(params.thread);
    if (
      method === "thread/status/changed" &&
      typeof params.threadId === "string" &&
      ["active", "idle", "notLoaded", "systemError"].includes(
        params.status?.type,
      )
    )
      this.rememberStatus(params.threadId, params.status);
    if (method === "turn/started" && typeof params.threadId === "string") {
      const old = this.runtime.get(params.threadId);
      if (old) old.error = null;
      if (typeof params.turn?.id === "string")
        this.userInput.set(
          params.threadId,
          inputState(params.turn.id, [], this.userInput.get(params.threadId)),
        );
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      typeof params.threadId === "string" &&
      typeof params.turnId === "string" &&
      ["active", "idle"].includes(
        this.runtime.get(params.threadId)?.status.type ?? "",
      )
    ) {
      const previous = this.userInput.get(params.threadId);
      if (!previous || previous.turnId === params.turnId)
        this.userInput.set(
          params.threadId,
          inputState(params.turnId, [params.item], previous),
        );
    }
    // 本轮结束和自动续跑均不代表用户已回复，待答状态由用户消息解除。
    if (method === "thread/closed") this.userInput.delete(params.threadId);
    if (
      method === "turn/completed" &&
      params.turn?.status === "failed" &&
      typeof params.threadId === "string"
    ) {
      const old = this.runtime.get(params.threadId);
      if (old)
        old.error = {
          message: "本轮执行失败，请在原对话查看详情。",
          at: now(),
        };
    }
  }
  private async hydrate() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const loaded = await this.request("thread/loaded/list", {});
      const ids: string[] = Array.isArray(loaded.data)
        ? loaded.data.filter((id: unknown) => typeof id === "string")
        : [];
      const loadedIds = new Set(ids);
      for (const [id, state] of this.runtime)
        if (!loadedIds.has(id)) {
          this.userInput.delete(id);
          this.runtime.set(id, {
            ...state,
            status: { type: "notLoaded" },
            at: now(),
            waitingSince: null,
          });
        }
      // Idle threads can still have unanswered dialogs in their latest turn.
      for (let offset = 0; offset < ids.length; offset += 8) {
        await Promise.all(
          ids.slice(offset, offset + 8).map(async (id) => {
            try {
              const read = await this.request("thread/read", {
                threadId: id,
                includeTurns: false,
              });
              this.remember(read.thread);
              if (["active", "idle"].includes(read.thread?.status?.type))
                await this.hydrateUserInput(id);
            } catch {
              // A thread can unload between list and read. This is not a host
              // disconnection; transport close is handled independently.
              this.runtime.delete(id);
              this.userInput.delete(id);
            }
          }),
        );
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  /** 从最近的用户消息或异步提问恢复待答状态，跳过纯助手续跑轮次。 */
  private async hydrateUserInput(threadId: string) {
    const previous = this.userInput.get(threadId);
    const epoch = this.inputEpoch.get(threadId);
    try {
      let cursor: string | undefined;
      let latestTurnId: string | undefined;
      do {
        // 自动续跑可能只有助手消息，向前查到最近含用户消息或提问的一轮即可。
        const result = await this.request("thread/turns/list", {
          threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        });
        // 实时消息或回合切换优先于尚未完成的历史读取。
        if (
          this.userInput.get(threadId) !== previous ||
          this.inputEpoch.get(threadId) !== epoch ||
          !["active", "idle"].includes(
            this.runtime.get(threadId)?.status.type ?? "",
          )
        )
          return;
        const turn = result.data?.[0];
        if (typeof turn?.id !== "string" || !Array.isArray(turn.items)) {
          this.userInput.delete(threadId);
          return;
        }
        latestTurnId ??= turn.id;
        const state = inputState(latestTurnId!, turn.items);
        // 历史回读重新计算待答集合，但同一问题沿用本次连接的首次观察时间。
        for (const [id, question] of state.pending) {
          const known = previous?.pending.get(id);
          if (known) question.since = known.since;
        }
        cursor = result.nextCursor ?? undefined;
        if (
          state.questions.size > 0 ||
          turn.items.some((item: any) => item?.type === "userMessage") ||
          !cursor
        ) {
          this.userInput.set(threadId, state);
          return;
        }
      } while (cursor);
    } catch {
      // Older servers may not support turn pagination. Keep native flags and
      // any questions already observed on this connection.
    }
  }

  /** 首次打开登记一次同步意图；连接尚未就绪时由连接完成后接续。 */
  async open(
    selection: string | null = null,
    observedThreadIds?: string[],
  ): Promise<Snapshot> {
    this.initialSyncRequested = true;
    const data = await this.snapshot(selection, observedThreadIds);
    if (this.desktop && observedThreadIds === undefined)
      this.observeDesktop(
        data.threads
          .filter((thread) => thread.kind === "user")
          .slice(0, 15)
          .map((thread) => thread.id),
      );
    else this.beginInitialSync();
    return data;
  }

  /** 每个看板服务只同步一批，定时快照和重连不会继续加载下一批。 */
  private beginInitialSync() {
    if (
      !this.initialSyncRequested ||
      this.desktop ||
      this.initialSync ||
      this.connection.state !== "connected"
    )
      return;
    this.initialSync = this.syncInitialThreads()
      .catch(() => {
        // 断连沿用连接状态提示，不让首次同步影响后续快照读取。
      })
      .finally(() => {
        this.initialSyncComplete = true;
      });
  }

  /** 最近十五条普通对话按用户消息时间排序，分批加载并读取真实状态。 */
  private async syncInitialThreads(): Promise<void> {
    // 先完成已加载对话的状态读取，避免让它们占用首次同步名额。
    await this.hydrate();
    const data = await this.snapshot();
    const threads = data.threads
      .filter(
        (thread) => thread.kind === "user" && columnFor(thread) === "unknown",
      )
      .sort(compareByLastUserMessage)
      .slice(0, 15);
    for (let offset = 0; offset < threads.length; offset += 3) {
      if (this.connection.state !== "connected") return;
      await Promise.all(
        threads.slice(offset, offset + 3).map(async ({ id }) => {
          try {
            let read = await this.request("thread/read", {
              threadId: id,
              includeTurns: false,
            });
            if (read.thread?.status?.type === "notLoaded")
              // 仅加载运行态，不发送消息，不请求执行回合，也不覆盖会话配置。
              read = await this.request("thread/resume", {
                threadId: id,
                excludeTurns: true,
              });
            this.remember(read.thread);
            if (["active", "idle"].includes(read.thread?.status?.type))
              await this.hydrateUserInput(id);
          } catch {
            // 单条不可加载时仍保留待同步，其余对话继续，且不追加下一批。
          }
        }),
      );
    }
  }

  async snapshot(
    selection: string | null = null,
    observedThreadIds?: string[],
  ): Promise<Snapshot> {
    if (observedThreadIds !== undefined) this.observeDesktop(observedThreadIds);
    const cached = this.cache;
    const hit =
      cached && cached.selection === selection && Date.now() - cached.at < 1000;
    const local = hit ? cached.data : await readLocalData(this.home, selection);
    if (!hit) this.cache = { at: Date.now(), selection, data: local };
    const threads = new Map(this.ephemeral);
    for (const thread of local.threads) threads.set(thread.id, thread);
    if (this.connection.state === "connected")
      for (const [id, mode] of this.modes) {
        const thread = threads.get(id);
        if (thread) threads.set(id, { ...thread, ...mode });
      }
    for (const [id, value] of this.runtime) {
      const thread = threads.get(id);
      if (thread) {
        const pending = unansweredInput(this.userInput.get(id));
        const merged: Thread = {
          ...thread,
          runtime: value.status,
          pendingUserInput: hasUnansweredInput(this.userInput.get(id)),
          runtimeAt: value.at,
          fresh:
            this.connection.state === "connected" &&
            (!this.desktop || !!this.desktop.get(id)),
          error: value.error,
        };
        const waiting = columnFor(merged) === "waiting";
        threads.set(id, {
          ...merged,
          // 断线、卸载和异常仍保留运行快照，但不展示旧问题为当前待处理事项。
          waitingSince: waiting
            ? ([value.waitingSince, pending?.since]
                .filter((at): at is string => typeof at === "string")
                .sort()[0] ?? null)
            : null,
          waitingQuestion: waiting ? (pending?.summary ?? null) : null,
        });
      }
    }
    const confirmations =
      this.connection.state === "connected"
        ? (this.desktopConfirmations?.read() ??
          (await readConfirmations(this.endpoint)))
        : { available: false, requests: [] };
    if (this.desktop && this.connection.state === "connected")
      for (const [id, thread] of threads) {
        const state = this.desktop.get(id)?.state;
        if (!state) continue;
        const confirmation = confirmations.requests.find(
          (request) => request.threadId === id,
        );
        threads.set(id, {
          ...thread,
          model:
            typeof state.latestModel === "string"
              ? state.latestModel
              : thread.model,
          reasoningEffort:
            typeof state.latestReasoningEffort === "string"
              ? state.latestReasoningEffort
              : thread.reasoningEffort,
          unread:
            selection === null && typeof state.hasUnreadTurn === "boolean"
              ? state.hasUnreadTurn
              : thread.unread,
          waitingQuestion:
            thread.waitingQuestion ??
            confirmation?.questions[0]?.question ??
            null,
        });
      }
    return {
      schemaVersion: 1,
      generatedAt: now(),
      syncingThreads:
        this.initialSyncRequested &&
        !this.initialSyncComplete &&
        this.connection.state !== "disconnected",
      threads: [...threads.values()].sort(compareByLastUserMessage),
      confirmations,
      connection: { ...this.connection },
      sources: {
        metadata: local.metadata,
        unread: local.unread,
        unreadReason: local.unreadReason,
        metadataError: local.metadataError,
        unreadOptions: local.unreadOptions,
        unreadSelection: selection,
      },
    };
  }

  /** 用户提交前检查当前连接，原请求是否有效由桌面转发器最终核对。 */
  async replyToConfirmation(input: ConfirmationReply) {
    if (this.connection.state !== "connected")
      throw new Error("实时状态连接已断开，请重新连接后重试。");
    return this.desktopConfirmations
      ? this.desktopConfirmations.reply(input)
      : replyToConfirmation(this.endpoint, input);
  }
}
