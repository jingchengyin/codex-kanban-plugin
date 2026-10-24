import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { Snapshot } from "../shared/types";

let app: App | null = null;
let ready: Promise<void> | null = null;
let initial: Snapshot | null = null;
export function connect(): Promise<void> {
  if (ready) return ready;
  if (window.parent === window) return (ready = Promise.resolve());
  app = new App({ name: "Codex Taskboard", version: "0.1.0" });
  new OpenAIExtensions(app);
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
): Promise<Snapshot> {
  await connect();
  if (initial && !unreadSelection) {
    const value = initial;
    initial = null;
    return value;
  }
  let value: unknown;
  if (app) {
    const result = await app.callServerTool({
      name: "taskboard_snapshot",
      arguments: { unreadSelection },
    });
    if (result.isError) throw new Error("插件状态服务暂不可用");
    value = result.structuredContent;
  } else {
    const response = await fetch(
      `/api/snapshot${unreadSelection ? `?unreadSelection=${encodeURIComponent(unreadSelection)}` : ""}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("本地状态服务暂不可用");
    value = await response.json();
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
