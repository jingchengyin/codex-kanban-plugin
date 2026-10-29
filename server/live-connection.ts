import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** 打开插件自带的实时启动器，让用户在终端中完成共享启动。 */
export async function launchLiveConnection(): Promise<{
  launched: boolean;
  message: string;
}> {
  if (process.platform !== "darwin")
    throw new Error("实时启动器目前仅支持 macOS。");
  const path = fileURLToPath(
    new URL("../../scripts/Codex Kanban.command", import.meta.url),
  );
  await access(path);
  await promisify(execFile)("/usr/bin/open", ["-a", "Terminal", path]);
  return {
    launched: true,
    message:
      "已打开实时启动器。若 Codex 已运行，请在准备好后按 ⌘Q 完全退出，启动器会自动继续。",
  };
}
