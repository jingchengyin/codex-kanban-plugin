import { homedir } from "node:os";
import { basename } from "node:path";
import { readLocalData } from "./local-data.js";
import { hasUnansweredInput, inputState } from "./user-input.js";
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
export class StatusBridge {
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
    { status: RuntimeStatus; at: string; error: Thread["error"] }
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
  readonly endpoint: string;
  readonly home: string;

  constructor(options: { endpoint?: string; home?: string } = {}) {
    this.endpoint = localEndpoint(
      options.endpoint ??
        process.env.TASKBOARD_WS_URL ??
        "ws://127.0.0.1:19429",
    );
    this.home = options.home ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`;
    this.connection = {
      state: "connecting",
      endpoint: this.endpoint,
      since: null,
      message: null,
    };
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.hydration);
    this.socket?.close();
    this.failPending();
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
  private remember(thread: any) {
    if (!thread || typeof thread.id !== "string") return;
    if (
      thread.status &&
      ["active", "idle", "notLoaded", "systemError"].includes(
        thread.status.type,
      )
    ) {
      const previous = this.runtime.get(thread.id);
      this.runtime.set(thread.id, {
        status: thread.status,
        at: now(),
        error: previous?.error ?? null,
      });
      if (thread.status.type !== "active") this.userInput.delete(thread.id);
    }
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
    ) {
      this.runtime.set(params.threadId, {
        status: params.status,
        at: now(),
        error: this.runtime.get(params.threadId)?.error ?? null,
      });
      if (params.status.type !== "active")
        this.userInput.delete(params.threadId);
    }
    if (method === "turn/started" && typeof params.threadId === "string") {
      const old = this.runtime.get(params.threadId);
      if (old) old.error = null;
      if (typeof params.turn?.id === "string")
        this.userInput.set(params.threadId, inputState(params.turn.id, []));
      else this.userInput.delete(params.threadId);
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      typeof params.threadId === "string" &&
      typeof params.turnId === "string" &&
      this.runtime.get(params.threadId)?.status.type === "active"
    ) {
      const previous = this.userInput.get(params.threadId);
      if (!previous || previous.turnId === params.turnId)
        this.userInput.set(
          params.threadId,
          inputState(params.turnId, [params.item], previous),
        );
    }
    if (method === "turn/completed" || method === "thread/closed") {
      const previous = this.userInput.get(params.threadId);
      if (!params.turn?.id || previous?.turnId === params.turn.id)
        this.userInput.delete(params.threadId);
    }
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
          });
        }
      // Bound concurrency without resuming any conversation. Only active
      // threads need the latest turn to recover pending async questions.
      for (let offset = 0; offset < ids.length; offset += 8) {
        await Promise.all(
          ids.slice(offset, offset + 8).map(async (id) => {
            try {
              const read = await this.request("thread/read", {
                threadId: id,
                includeTurns: false,
              });
              this.remember(read.thread);
              if (read.thread?.status?.type === "active")
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
  private async hydrateUserInput(threadId: string) {
    const previous = this.userInput.get(threadId);
    const epoch = this.inputEpoch.get(threadId);
    try {
      // Async questions are omitted from summary views. Read only the latest
      // active turn and discard all content after extracting question IDs.
      const result = await this.request("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      });
      // Live item events or a turn transition take precedence over this read.
      if (
        this.userInput.get(threadId) !== previous ||
        this.inputEpoch.get(threadId) !== epoch ||
        this.runtime.get(threadId)?.status.type !== "active"
      )
        return;
      const turn = result.data?.[0];
      if (
        turn?.status === "inProgress" &&
        typeof turn.id === "string" &&
        Array.isArray(turn.items)
      )
        this.userInput.set(threadId, inputState(turn.id, turn.items));
      else this.userInput.delete(threadId);
    } catch {
      // Older servers may not support turn pagination. Keep native flags and
      // any questions already observed on this connection.
    }
  }
  async snapshot(selection: string | null = null): Promise<Snapshot> {
    const cached = this.cache;
    const hit =
      cached && cached.selection === selection && Date.now() - cached.at < 2000;
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
      if (thread)
        threads.set(id, {
          ...thread,
          runtime:
            value.status.type === "active" &&
            hasUnansweredInput(this.userInput.get(id))
              ? {
                  ...value.status,
                  activeFlags: [
                    ...new Set([
                      ...(value.status.activeFlags ?? []),
                      "waitingOnUserInput",
                    ]),
                  ],
                }
              : value.status,
          runtimeAt: value.at,
          fresh: this.connection.state === "connected",
          error: value.error,
        });
    }
    return {
      schemaVersion: 1,
      generatedAt: now(),
      threads: [...threads.values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
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
}
