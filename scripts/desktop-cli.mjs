import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { approvalRelay } from "./approval-relay.mjs";

const cli = process.env.TASKBOARD_CODEX_CLI;
const args = process.argv.slice(2);
const serverIndex = args.indexOf("app-server");
const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
// 版本检查、启动配置检查及其他 CLI 命令必须原样执行。
const runtime =
  serverIndex >= 0 &&
  (!originator || originator === "Codex Desktop") &&
  !args.some((arg) =>
    ["--help", "-h", "--version", "--print-startup-config"].includes(arg),
  ) &&
  !["daemon", "proxy", "generate-ts", "generate-json-schema", "help"].includes(
    args[serverIndex + 1],
  );
const backendEnv = {
  ...process.env,
  CODEX_CLI_PATH: cli,
  CODEX_APP_RUNTIME_CLI_PATH: cli,
};

/** 转发桌面端 stdio，保留它提供的全部配置、工具管道和请求 ID。 */
async function relay() {
  const url = new URL(process.env.TASKBOARD_WS_URL ?? "ws://127.0.0.1:19429");
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.port ||
    Number(url.port) < 1024
  )
    throw new Error(
      "TASKBOARD_WS_URL must be ws://127.0.0.1:<port> (port >= 1024)",
    );
  const endpoint = url.origin;
  const child = spawn(cli, [...args, "--listen", endpoint], {
    env: backendEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const finished = once(child, "exit");
  let exitError;
  // 在等待 WebSocket 时也接收启动失败，避免留下未处理的 Promise。
  finished.catch((error) => {
    exitError = error;
  });
  let socket;
  let input;
  let approvals;
  let ended = false;
  let resolveEnd;
  const end = new Promise((ok) => {
    resolveEnd = ok;
  });
  const stop = () => {
    ended = true;
    resolveEnd();
  };
  const signals = ["SIGINT", "SIGHUP", "SIGTERM"];
  for (const signal of signals) process.on(signal, stop);
  process.stdin.once("end", stop);
  finished.then(stop, stop);
  try {
    const deadline = Date.now() + 10000;
    while (!ended && Date.now() < deadline) {
      // 只连接本次创建的进程，不能把桌面请求发给端口上的其他服务。
      let owner;
      try {
        owner = execFileSync(
          "/usr/sbin/lsof",
          ["-nP", "-t", `-iTCP:${url.port}`, "-sTCP:LISTEN"],
          { encoding: "utf8" },
        ).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      if (owner && owner !== String(child.pid))
        throw new Error(`Port ${url.port} is owned by another process`);
      if (owner) {
        socket = new WebSocket(endpoint);
        const opened = await new Promise((ok) => {
          socket.addEventListener("open", () => ok(true), { once: true });
          socket.addEventListener("error", () => ok(false), { once: true });
        });
        if (opened) break;
      }
      await new Promise((ok) => setTimeout(ok, 50));
    }
    if (ended) {
      if (exitError) throw exitError;
      if (child.exitCode !== null && child.exitCode !== 0)
        throw new Error(`Codex backend exited with code ${child.exitCode}`);
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN)
      throw new Error(
        "Codex backend did not open its WebSocket within 10 seconds",
      );
    approvals = approvalRelay(endpoint, (message) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    });
    // 确认转发不可用时保留桌面正常运行，原对话仍能处理所有请求。
    await approvals.start().catch((error) => {
      console.error(`看板确认转发不可用：${error.message}`);
    });
    socket.addEventListener("message", (event) => {
      try {
        approvals.observe(JSON.parse(String(event.data)));
      } catch {
        /* 原始消息仍交给桌面端。 */
      }
      process.stdout.write(String(event.data) + "\n");
    });
    socket.addEventListener("close", stop, { once: true });
    socket.addEventListener("error", stop, { once: true });
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      try {
        approvals.desktopResponse(JSON.parse(line));
      } catch {
        /* 保留原始转发行为。 */
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(line);
    });
    input.once("close", stop);
    await end;
    if (exitError) throw exitError;
    if (child.exitCode !== null && child.exitCode !== 0)
      throw new Error(`Codex backend exited with code ${child.exitCode}`);
  } finally {
    for (const signal of signals) process.off(signal, stop);
    process.stdin.off("end", stop);
    input?.close();
    approvals?.close();
    process.stdin.pause();
    socket?.close();
    // 桌面端关闭 stdio 后只清理本转发器创建的后端。
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      await finished.catch(() => {});
      clearTimeout(timeout);
    }
  }
}

try {
  if (!cli)
    throw new Error("TASKBOARD_CODEX_CLI must point to the real Codex CLI");
  if (runtime) await relay();
  else {
    const child = spawn(cli, args, { stdio: "inherit", env: backendEnv });
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
