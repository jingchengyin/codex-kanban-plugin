import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

if (process.argv.includes('--help')) {
  console.log('在独立 Terminal 中运行：node scripts/desktop-switch-experiment.mjs [--observe-live]\n仅后台管理专用 App Server、读取状态元数据。所有 Codex 退出/启动动作均由你按终端提示手动完成；最后恢复普通启动。\n--observe-live：连接后持续采样，等你手动完成一次本地对话并回到终端按回车，不在 10 秒后自动结束。');
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('请在独立 Terminal 中手动运行本测试。它需要你亲自完成 Codex 的退出和启动。');
}
const terminal = createInterface({ input: process.stdin, output: process.stdout });

// Human-operated desktop lifecycle; the script never controls the Codex UI.
// No persistent settings,
// prompts, approvals, native-pipe credentials, or conversation read-state writes.
const root = resolve(new URL('..', import.meta.url).pathname);
const output = resolve(root, 'outputs/desktop-switch-progress.json');
const resultFile = resolve(root, 'outputs/desktop-switch-result.json');
const app = '/Applications/ChatGPT.app';
const cli = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const endpoint = 'ws://127.0.0.1:19429';
const observeLive = process.argv.includes('--observe-live');
const targetId = process.env.STATUS_PROBE_THREAD_ID ?? process.env.CODEX_THREAD_ID;
if (!targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) {
  throw new Error('请通过 STATUS_PROBE_THREAD_ID 指定本次测试对话 ID。');
}
const env = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const report = {
  startedAt: new Date().toISOString(), endpoint, targetId,
  authorization: 'User approved a one-time quit/relaunch desktop transport test',
  phase: 'preflight', events: [], statusChanges: [], snapshots: [],
  persistentSettingsChanged: false, modelTurnsRequested: false,
  observationMode: observeLive ? 'manual_live_conversation' : 'ten_second_connection_check',
};
let backend;
let socket;
let oldPid;
let experimentalPid;
let oldExited = false;
let experimentalLaunchRequested = false;
let rollbackInProgress = false;
const pending = new Map();
let sequence = 0;
const delay = ms => new Promise(ok => setTimeout(ok, ms));

async function save(phase, details = {}) {
  report.phase = phase;
  report.events.push({ at: new Date().toISOString(), phase, ...details });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n');
  await rename(`${output}.tmp`, output);
}
function appPids() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,comm='],
    { env, encoding: 'utf8', timeout: 5000 }).trim().split('\n');
  return rows.map(row => row.trim().match(/^(\d+)\s+(.+)$/))
    .filter(row => row && row[2] === `${app}/Contents/MacOS/ChatGPT`).map(row => Number(row[1]));
}
async function manuallyExitApp(pid, label) {
  while (alive(pid)) {
    await terminal.question(`\n请手动退出${label} Codex（⌘Q，如有退出确认请自行处理），然后回到此终端按回车。\n`);
    if (alive(pid)) console.log('原进程仍在运行；本脚本不会替你结束它。');
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function desktopCommand(experimental) {
  const args = ['-a', app, '--env', experimental ? `CODEX_APP_SERVER_WS_URL=${endpoint}` : 'CODEX_APP_SERVER_WS_URL'];
  for (const key of ['CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'CODEX_CLI_PATH',
    'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_APP_TOOLS_CALLER_HOST_ID',
    'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'INTERNAL_ORIGINATOR_OVERRIDE']) {
    args.push('--env', key);
  }
  return ['/usr/bin/open', ...args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}
async function launchDesktop(experimental) {
  console.log(`\n请另开一个 Terminal 标签页，手动运行以下${experimental ? '实验' : '普通恢复'}启动命令：\n\n${desktopCommand(experimental)}\n`);
  await terminal.question('应用启动后，回到这个测试终端按回车继续。\n');
}
function tcpConnections(pid) {
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='],
      { env, encoding: 'utf8', timeout: 5000 }).trim().split('\n')
      .map(row => row.trim().split(/\s+/).map(Number));
    const descendants = new Set([pid]);
    let previousSize;
    do {
      previousSize = descendants.size;
      for (const [child, parent] of rows) if (descendants.has(parent)) descendants.add(child);
    } while (descendants.size !== previousSize);
    return execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', [...descendants].join(','), '-iTCP'],
      { env, encoding: 'utf8', timeout: 5000 }).trim().split('\n')
      .filter(line => line.includes('127.0.0.1:19429') && line.includes('ESTABLISHED'));
  } catch { return []; }
}
function request(method, params) {
  return new Promise((ok, fail) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`Timeout: ${method}`)); }, 5000);
    pending.set(id, { ok, fail, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function connectObserver() {
  socket = new WebSocket(endpoint);
  socket.addEventListener('message', event => {
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    if (value.method === 'thread/status/changed') {
      report.statusChanges.push({ at: new Date().toISOString(), threadId: value.params?.threadId, status: value.params?.status });
    }
    const waiter = pending.get(value.id);
    if (waiter && !value.method) {
      clearTimeout(waiter.timer); pending.delete(value.id);
      if (value.error) waiter.fail(new Error(value.error.message)); else waiter.ok(value.result);
    }
    // Never answer server requests, including requests for user approval.
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.fail(new Error('Observer disconnected')); }
    pending.clear();
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Observer connect timeout')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); ok(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error('Observer connect failed')); }, { once: true });
  });
  await request('initialize', { clientInfo: { name: 'taskboard_desktop_switch_observer', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  report.observerInitialized = true;
}
async function snapshot(label) {
  const loaded = await request('thread/loaded/list', {});
  const read = await request('thread/read', { threadId: targetId, includeTurns: false });
  const value = { at: new Date().toISOString(), label, loadedThreadIds: loaded.data,
    target: { threadId: read.thread?.id, status: read.thread?.status } };
  report.snapshots.push(value);
  return value;
}
async function rollback() {
  if (rollbackInProgress) return;
  rollbackInProgress = true;
  await save('restoring_normal_desktop');
  const current = appPids();
  if (experimentalLaunchRequested && current.length && !experimentalPid) {
    report.rollback = 'unidentified_desktop_backend_kept_alive';
    await save('manual_restore_required');
    return;
  }
  // Do not stop an unrelated process or a desktop the user started themselves.
  if (experimentalPid && current.includes(experimentalPid)) {
    await manuallyExitApp(experimentalPid, '实验');
  }
  if (experimentalLaunchRequested && appPids().length) {
    report.rollback = 'unexpected_desktop_backend_kept_alive';
    await save('manual_restore_required');
    return;
  }
  let normalLaunchRequested = false;
  if (oldExited && appPids().length === 0) {
    normalLaunchRequested = true;
    await launchDesktop(false);
  }
  if (normalLaunchRequested) {
    // The user may accidentally reuse the experimental command. Do not stop a
    // backend while any current Codex desktop is still connected to it.
    await delay(3000);
    const remaining = appPids().flatMap(pid => tcpConnections(pid));
    if (remaining.length) {
      report.rollback = 'reopened_desktop_still_connected_backend_kept_alive';
      report.remainingExperimentalConnections = remaining;
      await save('manual_restore_required');
      console.error('新桌面仍连接实验后端，已保留服务。请退出后使用普通恢复命令重新打开。');
      return;
    }
  }
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await Promise.race([new Promise(ok => backend.once('exit', ok)), delay(5000)]);
    if (backend.exitCode === null) backend.kill('SIGKILL');
  }
  const end = Date.now() + 20000;
  while (appPids().length === 0 && Date.now() < end) await delay(1000);
  report.restoredAppPids = appPids();
  report.rollback = !oldExited ? 'original_desktop_untouched'
    : (normalLaunchRequested && report.restoredAppPids.length ? 'desktop_reopened_without_observed_experiment_connection' : 'normal_desktop_launch_not_confirmed');
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, async () => {
    report.phase = 'manual_restore_required';
    report.result = 'terminal_interrupted';
    report.signal = signal;
    report.rollback = 'backend_kept_alive_for_manual_restore';
    report.finishedAt = new Date().toISOString();
    console.error(`\n终端中断，未操控 Codex。专用后端 PID：${backend?.pid ?? '尚未启动'}。\n请手动退出实验 Codex，再运行普通恢复命令：\n${desktopCommand(false)}\n确认实验桌面已退出后，可用 kill <上述后端 PID> 清理本次专用服务。`);
    socket?.close();
    try {
      await mkdir(dirname(resultFile), { recursive: true });
      await writeFile(resultFile, JSON.stringify(report, null, 2) + '\n');
    } finally { process.exit(130); }
  });
}

// Run from a user-owned Terminal so it survives the user's desktop shutdown.
try {
  oldPid = appPids()[0];
  if (!oldPid || appPids().length !== 1) throw new Error('Expected exactly one existing Codex desktop');
  report.originalAppPid = oldPid;
  await new Promise((ok, fail) => {
    const server = net.createServer();
    server.once('error', () => fail(new Error('Experiment port is already in use')));
    server.listen(19429, '127.0.0.1', () => server.close(ok));
  });
  await save('starting_dedicated_backend');
  backend = spawn(cli, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', endpoint],
    { cwd: root, env, stdio: 'ignore', detached: true });
  backend.on('error', error => { report.backendSpawnError = error.message; });
  report.backendPid = backend.pid;
  console.log(`本次专用后端 PID：${backend.pid}。中途中断时，请手动退出实验 Codex，然后使用以下普通恢复命令：\n${desktopCommand(false)}\n确认实验桌面退出后，可用 kill ${backend.pid} 清理专用后端。`);
  const end = Date.now() + 10000;
  let ready = false;
  while (!ready && Date.now() < end) {
    ready = await new Promise(ok => {
      const test = net.connect(19429, '127.0.0.1');
      test.once('connect', () => { test.destroy(); ok(true); });
      test.once('error', () => ok(false));
    });
    if (!ready) await delay(250);
  }
  if (!ready) throw new Error('Dedicated backend did not listen');
  const listenerPids = execFileSync('/usr/sbin/lsof', ['-nP', '-t', '-iTCP:19429', '-sTCP:LISTEN'],
    { env, encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(Number);
  if (backend.exitCode !== null || backend.signalCode !== null
    || listenerPids.length !== 1 || listenerPids[0] !== backend.pid) {
    throw new Error('Experiment listener is not owned by the dedicated backend');
  }
  report.listenerPidVerified = backend.pid;
  await connectObserver();
  await snapshot('before_desktop_switch');
  await save('waiting_for_user_to_quit_original_desktop');
  await manuallyExitApp(oldPid, '当前');
  oldExited = true;
  await save('launching_experimental_desktop');
  experimentalLaunchRequested = true;
  await launchDesktop(true);
  const launchEnd = Date.now() + 35000;
  while (Date.now() < launchEnd) {
    experimentalPid = appPids().find(pid => pid !== oldPid);
    if (experimentalPid) {
      const connections = tcpConnections(experimentalPid);
      if (connections.length) {
        report.desktopConnection = { pid: experimentalPid, connections, observedAt: new Date().toISOString() };
        break;
      }
    }
    await delay(1000);
  }
  if (!report.desktopConnection) throw new Error('No desktop TCP connection to the shared WebSocket backend observed');
  await save('desktop_shared_transport_observed');
  await snapshot('desktop_connected');
  if (observeLive) {
    console.log('\n现在请在实验 Codex 中打开一条现有本地对话，手动发送一个仅需简短回复的请求。只停留主页或查看历史可能不会加载运行线程。\n观察器只读取状态，不代发消息，也不回答任何审批。采样会持续到你回到此终端按回车。');
    let sampling = true;
    const samples = (async () => {
      try {
        while (sampling) {
          await snapshot('live_conversation_observation');
          await save('observing_manual_conversation');
          await delay(1000);
        }
      } catch (error) { report.liveSamplingError = error.message; }
    })();
    try { await terminal.question('完成这次对话操作后，按回车结束状态采样并进入恢复步骤。\n'); }
    finally { sampling = false; await samples; }
    if (report.liveSamplingError) throw new Error(report.liveSamplingError);
    const activeIds = new Set(report.statusChanges.filter(event => event.status?.type === 'active').map(event => event.threadId));
    report.liveEvidence = {
      loadedThreadObserved: report.snapshots.some(value => value.loadedThreadIds?.length > 0),
      activeThenIdleThreadIds: [...activeIds].filter(id => {
        const firstActive = report.statusChanges.findIndex(event => event.threadId === id && event.status?.type === 'active');
        return report.statusChanges.some((event, index) => index > firstActive && event.threadId === id && event.status?.type === 'idle');
      }),
      observedActiveFlags: [...new Set(report.statusChanges.flatMap(event => event.status?.activeFlags ?? []))],
    };
  } else await delay(10000);
  if (!alive(experimentalPid) || !tcpConnections(experimentalPid).length) throw new Error('Desktop shared connection did not remain established');
  await snapshot(observeLive ? 'desktop_connected_after_manual_observation' : 'desktop_connected_after_10_seconds');
  report.result = 'desktop_and_independent_observer_connected_to_same_backend';
  report.limitations = ['Transport connection does not by itself prove successful desktop initialization or full tool compatibility',
    'The script does not request model turns or approvals; verify each observed active flag and error separately'];
} catch (error) {
  report.result = 'desktop_switch_failed';
  report.error = error.message;
  console.error(`实验未完成：${error.message}`);
} finally {
  socket?.close();
  try { await rollback(); } catch (error) { report.rollbackError = error.message; }
  report.finishedAt = new Date().toISOString();
  await save('finished');
  await writeFile(resultFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n结果：${report.result}\n恢复：${report.rollback ?? report.rollbackError}\n记录：${resultFile}`);
  terminal.close();
}
