// Test adapter only: exercise a real backend without opening or quitting Codex.
import {
  runKanbanLauncher,
  sharedLaunchArgs,
} from "../scripts/kanban-launcher.mjs";
let normal = process.env.TASKBOARD_TEST_MODE === "normal";
let shared = false;
let socket;
let launches = 0;
async function connect(endpoint) {
  socket = new WebSocket(endpoint);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  shared = true;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes("quit")) {
    normal = false;
    shared = false;
    socket?.close();
  }
  if (data.includes("interrupt")) process.kill(process.pid, "SIGINT");
});
try {
  if (process.env.TASKBOARD_TEST_MODE === "shared")
    await connect(process.env.TASKBOARD_WS_URL);
  await runKanbanLauncher({
    pollMs: 25,
    desktop: {
      pids: () => (normal ? [900001] : shared ? [900002] : []),
      connected: (pid) => pid === 900002 && shared,
      async launch(endpoint) {
        if (normal)
          throw new Error("TEST: launch ran before the existing desktop quit");
        launches++;
        console.log(
          "TEST_LAUNCH_ARGS:" + JSON.stringify(sharedLaunchArgs(endpoint)),
        );
        await connect(endpoint);
      },
    },
  });
  console.log("TEST_LAUNCH_COUNT:" + launches);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  socket?.close();
  process.stdin.pause();
}
