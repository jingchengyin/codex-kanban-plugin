import { spawn, execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = "/Applications/ChatGPT.app";
const cliDefault = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function sharedLaunchArgs(listenUrl) {
  return [
    "-a",
    app,
    "--env",
    `CODEX_APP_SERVER_WS_URL=${listenUrl}`,
    "--env",
    `TASKBOARD_WS_URL=${listenUrl}`,
    ...(process.env.CODEX_HOME
      ? ["--env", `CODEX_HOME=${process.env.CODEX_HOME}`]
      : []),
    ...[
      "CODEX_APP_SERVER_FORCE_CLI",
      "CODEX_APP_SERVER_USE_LOCAL_DAEMON",
      "CODEX_CLI_PATH",
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
      try {
        return execFileSync(
          "/usr/sbin/lsof",
          [
            "-nP",
            "-a",
            "-p",
            String(pid),
            `-iTCP:${port}`,
            "-sTCP:ESTABLISHED",
          ],
          { encoding: "utf8" },
        ).includes(`->127.0.0.1:${port}`);
      } catch (error) {
        if (error.status === 1) return false;
        throw new Error("无法确认 Codex 的连接状态，保留现有后端。", {
          cause: error,
        });
      }
    },
    launch(listenUrl) {
      // Per-launch environment only. No launchctl, profile, or app settings writes.
      execFileSync("/usr/bin/open", sharedLaunchArgs(listenUrl), {
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

export async function runKanbanLauncher({
  desktop = macDesktop(),
  endpoint: address = process.env.TASKBOARD_WS_URL ?? "ws://127.0.0.1:19429",
  cli = process.env.TASKBOARD_CODEX_CLI ?? cliDefault,
  pollMs = 500,
} = {}) {
  if (!process.stdin.isTTY)
    throw new Error("请在独立 Terminal 中运行 npm run codex-kanban-plugin");
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
  // URL.toString() adds '/', which the CLI --listen parser rejects.
  const listenUrl = endpoint.origin;
  const port = Number(endpoint.port);
  await access(cli);
  let existingPid = listenerPid(port);
  if (existingPid) verifyExistingBackend(existingPid, cli);

  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"];
  for (const signal of signals) process.on(signal, interrupt);
  let server;
  let exited = false;
  let exitReason = "启动超时";
  let logPath;
  let exitPromise;
  let launchRequested = false;
  let sharedPids = [];
  try {
    const pids = desktop.pids();
    if (existingPid && pids.some((pid) => desktop.connected(pid, port))) {
      console.log(
        `Codex 已在共享模式运行：${listenUrl}（后端 PID ${existingPid}）。`,
      );
      return;
    }
    if (pids.length) {
      console.log(
        "检测到 Codex 正在运行。请按 ⌘Q 完全退出；本命令会等待退出后自动以共享模式打开。",
      );
      while (desktop.pids().length && !interrupted) await pause(pollMs);
    }
    if (interrupted) return;

    // Another launcher may have started a backend while waiting for the app to quit.
    existingPid = listenerPid(port);
    if (existingPid) {
      verifyExistingBackend(existingPid, cli);
      console.log(
        `复用共享后端：${listenUrl}，PID ${existingPid}（本命令不会停止已有服务）。`,
      );
    } else {
      const cleanEnv = Object.fromEntries(
        [
          "HOME",
          "USER",
          "LOGNAME",
          "PATH",
          "SHELL",
          "TMPDIR",
          "LANG",
          "CODEX_HOME",
        ]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      );
      logPath = join(
        mkdtempSync(join(tmpdir(), "codex-taskboard-live-")),
        "backend.log",
      );
      const fd = openSync(logPath, "wx", 0o600);
      try {
        server = spawn(
          cli,
          [
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            listenUrl,
          ],
          {
            env: cleanEnv,
            stdio: ["ignore", fd, fd],
            detached: true,
          },
        );
      } finally {
        closeSync(fd);
      }
      exitPromise = new Promise((ok) => {
        server.once("error", (error) => {
          exited = true;
          exitReason = error.message;
          ok();
        });
        server.once("exit", (code, signal) => {
          exited = true;
          exitReason = signal ? `信号 ${signal}` : `退出码 ${code}`;
          ok();
        });
      });
      const deadline = Date.now() + 10000;
      let ready = false;
      while (!ready && !exited && !interrupted && Date.now() < deadline) {
        ready = await new Promise((ok) => {
          const socket = net.connect(port, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            ok(true);
          });
          socket.once("error", () => ok(false));
        });
        if (!ready) await pause(100);
      }
      if (interrupted) return;
      if (!ready) {
        const diagnostics = readFileSync(logPath, "utf8").trim().slice(-3000);
        throw new Error(
          `共享后端没有启动成功（${exitReason}）。\n后端日志：${logPath}${diagnostics ? `\n${diagnostics}` : ""}`,
        );
      }
      if (exited || listenerPid(port) !== server.pid)
        throw new Error("监听端口不属于本次共享后端，已停止启动。");
      console.log(
        `共享后端已启动：${listenUrl}，专用 PID ${server.pid}。\n后端日志：${logPath}`,
      );
    }

    if (interrupted) return;
    launchRequested = true;
    await desktop.launch(listenUrl);
    console.log("正在以共享模式打开 Codex…");
    const deadline = Date.now() + 30000;
    let connectedPids = [];
    while (!interrupted && Date.now() < deadline) {
      if (server && exited)
        throw new Error(
          `共享后端已退出（${exitReason}）。后端日志：${logPath}`,
        );
      connectedPids = desktop
        .pids()
        .filter((pid) => desktop.connected(pid, port));
      if (connectedPids.length) break;
      await pause(pollMs);
    }
    if (interrupted) return;
    if (!connectedPids.length)
      throw new Error(
        "Codex 尚未连接共享后端。请完全退出 Codex，再运行 npm run codex-kanban-plugin。",
      );
    sharedPids = connectedPids;
    console.log(
      "Codex 共享启动成功，打开「对话看板」即可查看实时状态。\n保持本终端运行；退出本次 Codex 后会自动清理本命令创建的后端。\n以后直接点击 Codex 图标即为普通启动，无需恢复命令。",
    );
    while (
      !interrupted &&
      desktop.pids().some((pid) => connectedPids.includes(pid))
    ) {
      if (server && exited)
        throw new Error(
          `共享后端已退出（${exitReason}）。后端日志：${logPath}`,
        );
      await pause(pollMs);
    }
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
    if (server && !exited) {
      let inUse = true;
      try {
        const active = desktop.pids();
        inUse =
          active.some(
            (pid) => sharedPids.includes(pid) || desktop.connected(pid, port),
          ) ||
          (launchRequested && !sharedPids.length && active.length > 0);
      } catch {}
      if (inUse) {
        server.unref();
        console.log(
          `Codex 仍可能使用共享后端，已保留 PID ${server.pid}。下次运行命令会复用它。`,
        );
      } else {
        server.kill("SIGTERM");
        const forceStop = setTimeout(() => server.kill("SIGKILL"), 5000);
        await exitPromise;
        clearTimeout(forceStop);
        console.log(
          "本次共享后端已停止。下次直接点击 Codex 图标即可普通启动。",
        );
      }
    }
  }
}
