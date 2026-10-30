import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { Snapshot } from "../shared/types";
import type { ConfirmationReply } from "../shared/confirmations";
import type {
  WorkItemInput,
  WorkItemSaveResult,
  WorkspaceData,
  ArtifactDiscovery,
  ArtifactRules,
} from "../shared/work-items";
import type { WorkReview, WorkReviewOptions } from "../shared/work-review";
import { cachedSnapshot } from "./snapshot-cache";

let app: App | null = null;
let extensions: OpenAIExtensions | null = null;
let ready: Promise<void> | null = null;
let initial: Snapshot | null = null;
let previewOpened = false;
export function connect(): Promise<void> {
  if (ready) return ready;
  if (window.parent === window) return (ready = Promise.resolve());
  app = new App({ name: "Codex Taskboard", version: "0.2.0" });
  extensions = new OpenAIExtensions(app);
  app.ontoolresult = (result) => {
    if (validSnapshot(result.structuredContent))
      initial = result.structuredContent;
  };
  const theme = () => {
    const context = app!.getHostContext();
    if (context?.theme) {
      applyDocumentTheme(context.theme);
      document.documentElement.dataset.theme = context.theme;
      document.documentElement.classList.toggle(
        "dark",
        context.theme === "dark",
      );
    }
    if (context?.styles?.variables)
      applyHostStyleVariables(context.styles.variables);
    const insets = context?.safeAreaInsets;
    if (insets)
      for (const edge of ["top", "bottom", "left", "right"] as const)
        document.documentElement.style.setProperty(
          `--safe-${edge}`,
          `${insets[edge] ?? 0}px`,
        );
  };
  app.addEventListener("hostcontextchanged", theme);
  return (ready = app.connect().then(theme));
}
export function validSnapshot(value: unknown): value is Snapshot {
  const data = value as Partial<Snapshot> | null;
  return (
    !!data &&
    data.schemaVersion === 1 &&
    Array.isArray(data.threads) &&
    !!data.connection &&
    !!data.sources
  );
}
export async function readSnapshot(
  unreadSelection: string | null = null,
  observedThreadIds?: string[],
): Promise<Snapshot> {
  await connect();
  if (initial && !unreadSelection) {
    const value = initial;
    initial = null;
    // 宿主携带的列表立即用于首屏；下一次轮询重新核对状态并登记观察。
    return cachedSnapshot(value);
  }
  let value: unknown;
  if (app) {
    const result = await app.callServerTool({
      name: "taskboard_snapshot",
      arguments: {
        unreadSelection,
        ...(observedThreadIds === undefined ? {} : { observedThreadIds }),
      },
    });
    if (result.isError) throw new Error("插件状态服务暂不可用");
    value = result.structuredContent;
  } else {
    // 观察集合通过正文传输，避免分页卡片的 ID 超出 HTTP 请求行长度。
    const opening = !previewOpened;
    const observing = opening || observedThreadIds !== undefined;
    const response = await fetch(
      opening
        ? "/api/board/open"
        : `/api/snapshot${!observing && unreadSelection ? `?unreadSelection=${encodeURIComponent(unreadSelection)}` : ""}`,
      {
        cache: "no-store",
        ...(observing
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ unreadSelection, observedThreadIds }),
            }
          : {}),
      },
    );
    if (!response.ok) throw new Error("本地状态服务暂不可用");
    value = await response.json();
    previewOpened = true;
  }
  if (!validSnapshot(value)) throw new Error("收到的状态数据格式不受支持");
  return value;
}
export async function openConversation(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("对话 ID 格式无效");
  const url = `codex://threads/${id}`;
  if (app) {
    const result = await app.openLink({ url });
    if (result.isError)
      throw new Error("宿主未允许跳转，请通过 Codex 对话列表打开。");
  } else window.location.href = url;
}

/** 成果链接交给宿主打开，避免在看板的 iframe 内导航。 */
export async function openArtifactLink(url: string) {
  if (!["http:", "https:", "codex:"].includes(new URL(url).protocol))
    throw new Error("成果链接需使用 HTTP、HTTPS 或 Codex 地址。");
  await connect();
  if (app) {
    const result = await app.openLink({ url });
    if (result.isError) throw new Error("宿主未允许打开成果链接。");
  } else window.open(url, "_blank", "noopener,noreferrer");
}

/** 复用宿主 MCP 或本地预览接口，保持两种入口的工作台行为一致。 */
async function workspaceRequest<T>(
  tool: string,
  path: string,
  args: Record<string, unknown> = {},
  write = false,
  signal?: AbortSignal,
): Promise<T> {
  await connect();
  signal?.throwIfAborted();
  if (app) {
    const result = await app.callServerTool(
      { name: tool, arguments: args },
      { signal },
    );
    if (result.isError) {
      const message = result.content?.find((item) => item.type === "text");
      throw new Error(
        message && "text" in message
          ? String(message.text)
          : "工作台服务暂不可用",
      );
    }
    return result.structuredContent as T;
  }
  const query = new URLSearchParams();
  if (!write)
    for (const [key, value] of Object.entries(args))
      if (value !== undefined) query.set(key, String(value));
  const response = await fetch(`${path}${query.size ? `?${query}` : ""}`, {
    cache: "no-store",
    signal,
    ...(write
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        }
      : {}),
  });
  if (!response.ok)
    throw new Error((await response.text()) || "工作台服务暂不可用");
  return response.json() as Promise<T>;
}

export const readWorkspace = () =>
  workspaceRequest<WorkspaceData>("taskboard_workspace", "/api/workspace");
/** 确认按钮复用现有界面工具通道，不发送普通聊天消息。 */
export const replyToConfirmation = (input: ConfirmationReply) =>
  workspaceRequest<{ submitted: boolean }>(
    "taskboard_confirmation_reply",
    "/api/confirmations/respond",
    input,
    true,
  );
/** 规则统一存储在本机服务，供看板和工作事项共用。 */
export const readArtifactRules = () =>
  workspaceRequest<ArtifactRules>(
    "taskboard_artifact_rules",
    "/api/artifact-rules",
  );
export const saveArtifactRules = (rules: ArtifactRules) =>
  workspaceRequest<ArtifactRules>(
    "taskboard_artifact_rules_save",
    "/api/artifact-rules",
    rules,
    true,
  );
/** 卡片与事项复用按对话维护的成果结果，批量 ID 通过 JSON 正文传输。 */
export const readThreadArtifacts = (threadIds: string[]) =>
  workspaceRequest<ArtifactDiscovery>(
    "taskboard_thread_artifacts",
    "/api/thread-artifacts",
    { threadIds },
    true,
  );
export const saveWorkItem = (input: WorkItemInput) =>
  workspaceRequest<WorkItemSaveResult>(
    "taskboard_work_item_save",
    "/api/work-items/save",
    input,
    true,
  );
/** 关联操作只提交事项与对话 ID，保留服务端最新的其他字段。 */
export const addThreadToWorkItem = (id: string, threadId: string) =>
  workspaceRequest<WorkItemSaveResult>(
    "taskboard_work_item_add_thread",
    "/api/work-items/add-thread",
    { id, threadId },
    true,
  );
export const deleteWorkItem = (id: string) =>
  workspaceRequest<WorkspaceData>(
    "taskboard_work_item_delete",
    "/api/work-items/delete",
    { id },
    true,
  );
/** 已发现的本机方案直接交给 Codex 原生查看器，不调用系统默认应用。 */
export async function openDetectedFile(path: string): Promise<void> {
  await connect();
  const files = extensions?.files;
  if (!files)
    throw new Error("当前入口不支持 Codex 文件预览，请从来源对话查看文件。");
  await files.open(path);
}
/** 回顾请求可随筛选切换取消，并在 30 秒后给出可重试的错误。 */
export async function readWorkReview(
  input: WorkReviewOptions,
  signal?: AbortSignal,
): Promise<WorkReview> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error("读取工作回顾超时，请重试。")),
    30000,
  );
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    // 宿主握手也计入超时，避免连接未完成时一直停留在加载状态。
    return await Promise.race([
      workspaceRequest<WorkReview>(
        "taskboard_work_review",
        "/api/work-review",
        input,
        false,
        controller.signal,
      ),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
  }
}
export const launchLiveConnection = () =>
  workspaceRequest<{ launched: boolean; message: string }>(
    "taskboard_live_launch",
    "/api/live/launch",
    {},
    true,
  );
