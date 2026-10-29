import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = "/Applications/ChatGPT.app";
const cliDefault = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const wrapper = fileURLToPath(new URL("start-desktop-cli.sh", import.meta.url));
const relayPath = fileURLToPath(new URL("desktop-cli.mjs", import.meta.url));
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** 让桌面端生成完整启动配置，再通过转发器连接同一个后端。 */
export function sharedLaunchArgs(listenUrl, cli = cliDefault) {
  return [
    "-a",
    app,
    "--env",
    "CODEX_APP_SERVER_WS_URL",
    "--env",
    "CODEX_APP_SERVER_FORCE_CLI",
    "--env",
    `CODEX_CLI_PATH=${wrapper}`,
    "--env",
    `TASKBOARD_CODEX_CLI=${cli}`,
    "--env",
    `TASKBOARD_WS_URL=${listenUrl}`,
    ...(process.env.CODEX_HOME
      ? ["--env", `CODEX_HOME=${process.env.CODEX_HOME}`]
      : []),
    ...[
      "CODEX_APP_SERVER_USE_LOCAL_DAEMON",
      "CODEX_APP_TOOLS_PIPE_PATH",
      "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY",
      "CODEX_APP_TOOLS_CALLER_HOST_ID",
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
      "CODEX_TOOL_CALL_ID",
      "INTERNAL_ORIGINATOR_OVERRIDE",
    ].flatMap((key) => ["--env", key]),
  ];
}

export function macDesktop() {
  return {
    pids() {
      return execFileSync("/bin/ps", ["-axo", "pid=,comm="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((row) => row.trim().match(/^(\d+)\s+(.+)$/))
        .filter((row) => row && row[2] === `${app}/Contents/MacOS/ChatGPT`)
        .map((row) => Number(row[1]));
    },
    connected(pid, port) {
      // 桌面端使用 stdio；只有它的转发子进程连接 WebSocket。
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .filter(Boolean);
      const descendants = new Set([pid]);
      let size;
      do {
        size = descendants.size;
        for (const [, child, parent] of rows)
          if (descendants.has(Number(parent))) descendants.add(Number(child));
      } while (size !== descendants.size);
      const relays = rows
        .filter(
          ([, child, , command]) =>
            descendants.has(Number(child)) && command.includes(relayPath),
        )
        .map(([, child]) => Number(child));
      if (!relays.length) return false;
      try {
        return execFileSync(
          "/usr/sbin/lsof",
          [
            "-nP",
            "-a",
            "-p",
            relays.join(","),
            `-iTCP:${port}`,
            "-sTCP:ESTABLISHED",
          ],
          { encoding: "utf8" },
        ).includes(`->127.0.0.1:${port}`);
      } catch (error) {
        if (error.status === 1) return false;
        throw new Error("无法确认 Codex 的连接状态。", { cause: error });
      }
    },
    launch(listenUrl, cli) {
      execFileSync("/usr/bin/open", sharedLaunchArgs(listenUrl, cli), {
        stdio: "inherit",
      });
    },
  };
}

function listenerPid(port) {
  let output;
  try {
    output = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
  const pids = [...new Set(output.trim().split("\n").map(Number))];
  if (pids.length !== 1 || !pids[0])
    throw new Error(`端口 ${port} 的监听进程不唯一。`);
  return pids[0];
}

function verifyExistingBackend(pid, cli) {
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
  }).trim();
  try {
    if (realpathSync(command) === realpathSync(cli)) return;
  } catch {}
  throw new Error(`端口已被其他服务占用（PID ${pid}），不会停止或连接该服务。`);
}

/** 启动桌面端拥有的共享后端，保留定时任务等内置工具的初始化。 */
export async function runKanbanLauncher({
  desktop = macDesktop(),
  endpoint: address = process.env.TASKBOARD_WS_URL ?? "ws://127.0.0.1:19429",
  cli = process.env.TASKBOARD_CODEX_CLI ?? cliDefault,
  pollMs = 500,
} = {}) {
  if (!process.stdin.isTTY)
    throw new Error(
      "请双击 scripts/Codex Kanban.command，或在独立 Terminal 中运行 npm run codex-kanban-plugin",
    );
  const endpoint = new URL(address);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port ||
    Number(endpoint.port) < 1024
  )
    throw new Error("仅支持 ws://127.0.0.1:<port>，端口需在 1024 以上");
  const listenUrl = endpoint.origin;
  const port = Number(endpoint.port);
  await access(cli);
  await access(wrapper);
  const existingPid = listenerPid(port);
  if (existingPid) {
    verifyExistingBackend(existingPid, cli);
    if (desktop.pids().some((pid) => desktop.connected(pid, port))) {
      console.log(`Codex 已在共享模式运行：${listenUrl}。`);
      return;
    }
    // 旧启动器的独立后端缺少桌面工具配置，不能复用。
    throw new Error(
      `端口 ${port} 已有独立后端（PID ${existingPid}）。请退出旧共享会话并停止旧启动命令，再重试。`,
    );
  }

  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"];
  for (const signal of signals) process.on(signal, interrupt);
  try {
    if (desktop.pids().length) {
      console.log(
        "检测到 Codex 正在运行。请按 ⌘Q 完全退出；本命令会等待退出后自动以共享模式打开。",
      );
      while (desktop.pids().length && !interrupted) await pause(pollMs);
    }
    if (interrupted) return;
    if (listenerPid(port)) throw new Error(`端口 ${port} 已被占用，请重试。`);
    await desktop.launch(listenUrl, cli);
    console.log("正在以共享模式打开 Codex…");
    const deadline = Date.now() + 30000;
    let connectedPids = [];
    while (!interrupted && Date.now() < deadline) {
      const backendPid = listenerPid(port);
      if (backendPid) {
        verifyExistingBackend(backendPid, cli);
        connectedPids = desktop
          .pids()
          .filter((pid) => desktop.connected(pid, port));
        if (connectedPids.length) break;
      }
      await pause(pollMs);
    }
    if (interrupted) return;
    if (!connectedPids.length)
      throw new Error("Codex 尚未连接共享后端。请查看客户端启动日志后重试。");
    console.log(
      "Codex 共享启动成功，打开「对话看板」即可查看实时状态。\n后端由 Codex 管理；关闭本终端不影响客户端，退出 Codex 后会自动清理后端。\n以后直接点击 Codex 图标即为普通启动，无需恢复命令。",
    );
    while (
      !interrupted &&
      desktop.pids().some((pid) => connectedPids.includes(pid))
    )
      await pause(pollMs);
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
  }
}
