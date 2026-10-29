// 模拟桌面端的 stdio 连接，运行真实 CLI，但不打开或退出用户的客户端。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  runKanbanLauncher,
  sharedLaunchArgs,
} from "../scripts/kanban-launcher.mjs";

let normal = process.env.TASKBOARD_TEST_MODE === "normal";
let shared = false;
let socket;
let child;
let finished;
let launches = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes("quit")) {
    normal = false;
    shared = false;
    socket?.close();
    child?.stdin.end();
  }
  if (data.includes("interrupt")) process.kill(process.pid, "SIGINT");
});
try {
  if (process.env.TASKBOARD_TEST_MODE === "shared") {
    socket = new WebSocket(process.env.TASKBOARD_WS_URL);
    await new Promise((ok, fail) => {
      socket.addEventListener("open", ok, { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    shared = true;
  }
  await runKanbanLauncher({
    pollMs: 25,
    desktop: {
      pids: () => (normal ? [900001] : shared ? [900002] : []),
      connected: (pid) => pid === 900002 && shared,
      async launch(endpoint, cli) {
        if (normal) throw new Error("TEST: launch ran before desktop quit");
        launches++;
        console.log(
          "TEST_LAUNCH_ARGS:" + JSON.stringify(sharedLaunchArgs(endpoint, cli)),
        );
        child = spawn(
          "/bin/sh",
          [
            fileURLToPath(
              new URL("../scripts/start-desktop-cli.sh", import.meta.url),
            ),
            "app-server",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              TASKBOARD_CODEX_CLI: cli,
              TASKBOARD_WS_URL: endpoint,
            },
          },
        );
        child.stderr.pipe(process.stderr);
        finished = once(child, "exit").then(([code]) => {
          shared = false;
          return code;
        });
        await new Promise((ok, fail) => {
          const lines = createInterface({ input: child.stdout });
          lines.on("line", (line) => {
            const message = JSON.parse(line);
            if (message.id === "desktop-init") {
              if (message.error) fail(new Error(JSON.stringify(message.error)));
              else ok();
            }
          });
          finished.then(
            (code) => fail(new Error(`TEST: backend exited (${code})`)),
            fail,
          );
          child.stdin.write(
            JSON.stringify({
              id: "desktop-init",
              method: "initialize",
              params: {
                clientInfo: { name: "launcher_test_desktop", version: "1" },
                capabilities: { experimentalApi: true },
              },
            }) + "\n",
          );
        });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        shared = true;
      },
    },
  });
  console.log("TEST_LAUNCHER_RETURNED");
  console.log("TEST_LAUNCH_COUNT:" + launches);
  if (finished) {
    await finished;
    console.log("TEST_DESKTOP_BACKEND_STOPPED");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    child.stdin.end();
    await finished;
  }
  process.stdin.pause();
}
