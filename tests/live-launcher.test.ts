import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli =
  process.env.TASKBOARD_CODEX_CLI ??
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function available(t: TestContext) {
  if (process.platform !== "darwin") {
    t.skip("macOS desktop launcher");
    return false;
  }
  try {
    await access(cli);
    return true;
  } catch {
    t.skip("bundled Codex CLI not installed");
    return false;
  }
}
async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}
async function fixture(port: number, mode = "closed", command = cli) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-launcher-test-"));
  const child = spawn(
    "python3",
    [
      resolve("tests/tty-runner.py"),
      process.execPath,
      resolve("tests/launcher-desktop-fixture.mjs"),
    ],
    {
      env: {
        ...process.env,
        CODEX_HOME: home,
        TASKBOARD_CODEX_CLI: command,
        TASKBOARD_WS_URL: `ws://127.0.0.1:${port}/`,
        TASKBOARD_TEST_MODE: mode,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  let exited = false;
  const finished = once(child, "exit").then(([code]) => {
    exited = true;
    return code;
  });
  return {
    child,
    finished,
    output: () => output,
    async until(text: string) {
      const deadline = Date.now() + 12000;
      while (!output.includes(text) && !exited && Date.now() < deadline)
        await pause(30);
      assert.ok(output.includes(text), output);
    },
    async dispose() {
      if (!exited) {
        child.stdin.write("quit\ninterrupt\n");
        await finished;
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}
async function websocket(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((ok, fail) => {
    socket.addEventListener("open", () => ok(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error("backend WebSocket failed")),
      { once: true },
    );
  });
  socket.close();
}

test(
  "shared command waits for an existing desktop to quit, launches once, and cleans up only its backend",
  { timeout: 20000 },
  async (t) => {
    if (!(await available(t))) return;
    const port = await reservePort();
    const run = await fixture(port, "normal");
    try {
      await run.until("请按 ⌘Q 完全退出");
      assert.equal(run.output().includes("共享后端已启动"), false);
      run.child.stdin.write("quit\n");
      await run.until("Codex 共享启动成功");
      const endpoint = `ws://127.0.0.1:${port}`;
      const args = JSON.parse(run.output().match(/TEST_LAUNCH_ARGS:(.+)/)![1]);
      assert.ok(args.includes("CODEX_APP_SERVER_WS_URL"));
      assert.ok(args.includes("CODEX_APP_SERVER_FORCE_CLI"));
      assert.equal(args.includes("CODEX_APP_SERVER_FORCE_CLI=1"), false);
      assert.ok(
        args.some(
          (arg: string) =>
            arg.startsWith("CODEX_CLI_PATH=") &&
            arg.endsWith("/start-desktop-cli.sh"),
        ),
      );
      assert.ok(args.includes("CODEX_APP_TOOLS_PIPE_PATH"));
      assert.ok(args.includes(`TASKBOARD_WS_URL=${endpoint}`));
      assert.equal(
        args.includes(`CODEX_APP_SERVER_WS_URL=${endpoint}/`),
        false,
      );
      assert.equal(args.includes("-n"), false);
      assert.match(run.output(), /后端由 Codex 管理/);
      assert.equal(run.output().includes("恢复普通启动："), false);
      await websocket(port);
      run.child.stdin.write("quit\n");
      assert.equal(await run.finished, 0, run.output());
      assert.match(run.output(), /TEST_DESKTOP_BACKEND_STOPPED/);
      assert.match(run.output(), /TEST_LAUNCH_COUNT:1/);
      await assert.rejects(websocket(port));
    } finally {
      await run.dispose();
    }
  },
);

test(
  "an unowned backend is rejected and repeated desktop launch is idempotent",
  { timeout: 25000 },
  async (t) => {
    if (!(await available(t))) return;
    const port = await reservePort();
    const owner = await fixture(port);
    let reuse;
    let repeated;
    try {
      await owner.until("Codex 共享启动成功");
      reuse = await fixture(port);
      assert.equal(await reuse.finished, 1, reuse.output());
      assert.match(reuse.output(), /已有独立后端/);
      assert.equal(reuse.output().includes("TEST_LAUNCH_ARGS:"), false);
      await websocket(port);
      repeated = await fixture(port, "shared");
      assert.equal(await repeated.finished, 0, repeated.output());
      assert.match(repeated.output(), /Codex 已在共享模式运行/);
      assert.match(repeated.output(), /TEST_LAUNCH_COUNT:0/);
      await websocket(port);
      owner.child.stdin.write("quit\n");
      assert.equal(await owner.finished, 0, owner.output());
      assert.match(owner.output(), /TEST_DESKTOP_BACKEND_STOPPED/);
    } finally {
      await repeated?.dispose();
      await reuse?.dispose();
      await owner.dispose();
    }
  },
);

test(
  "launcher rejects an unrelated listener without launching the app or stopping the listener",
  { timeout: 15000 },
  async (t) => {
    if (!(await available(t))) return;
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
    const run = await fixture((listener.address() as net.AddressInfo).port);
    try {
      assert.equal(await run.finished, 1);
      assert.match(run.output(), /端口已被其他服务占用/);
      assert.equal(run.output().includes("TEST_LAUNCH_ARGS:"), false);
      assert.equal(listener.listening, true);
    } finally {
      await run.dispose();
      await new Promise<void>((ok) => listener.close(() => ok()));
    }
  },
);

test(
  "interrupting the launcher preserves a backend still used by its desktop",
  { timeout: 15000 },
  async (t) => {
    if (!(await available(t))) return;
    const port = await reservePort();
    const run = await fixture(port);
    try {
      await run.until("Codex 共享启动成功");
      run.child.stdin.write("interrupt\n");
      await run.until("TEST_LAUNCHER_RETURNED");
      await websocket(port);
      run.child.stdin.write("quit\n");
      assert.equal(await run.finished, 0, run.output());
      await assert.rejects(websocket(port));
    } finally {
      await run.dispose();
    }
  },
);

test(
  "desktop backend startup failure is reported and cleaned up",
  { timeout: 15000 },
  async (t) => {
    if (!(await available(t))) return;
    const port = await reservePort();
    const run = await fixture(port, "closed", "/usr/bin/false");
    try {
      assert.equal(await run.finished, 1);
      assert.match(run.output(), /Codex backend exited with code 1/);
      await assert.rejects(websocket(port));
    } finally {
      await run.dispose();
    }
  },
);
