import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';

// Isolated protocol experiment. Does not connect to or restart the desktop.
// Creates one ephemeral thread and runs a literal printf to trigger lifecycle
// transitions. Never requests a model turn or changes existing user threads.
const cli = process.env.CODEX_CLI_PATH ?? 'codex';
const output = resolve('outputs/websocket-backend-probe.json');
const work = resolve('work');
await mkdir(work, { recursive: true });
const isolatedHome = await mkdtemp(join(work, 'ws-smoke-'));
const report = {
  checkedAt: new Date().toISOString(), desktopRestarted: false,
  existingUserThreadsChanged: false, modelTurnsRequested: 0,
  isolatedCodexHome: true, ephemeralMetadataThreadsCreated: 0,
  auxiliaryShellCommandsRequested: 0,
  steps: [], notifications: [],
};
const reservation = net.createServer();
await new Promise((ok, fail) => {
  reservation.once('error', fail);
  reservation.listen(0, '127.0.0.1', ok);
});
const port = reservation.address().port;
await new Promise(ok => reservation.close(ok));
const endpoint = `ws://127.0.0.1:${port}`;
const child = spawn(cli, [
  '-c', 'features.code_mode_host=true',
  '-c', 'cli_auth_credentials_store="file"',
  'app-server', '--listen', endpoint,
], {
  env: Object.fromEntries([
    ...['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key])
      .map(key => [key, process.env[key]]),
    ['CODEX_HOME', isolatedHome], ['RUST_LOG', 'error'],
  ]),
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostics = '';
let serverExited = false;
let protocolFailure = null;
let resolveServerExit;
const serverExit = new Promise(ok => { resolveServerExit = ok; });
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
child.on('exit', () => { serverExited = true; resolveServerExit(); });
child.on('error', error => {
  diagnostics += error.message; serverExited = true; resolveServerExit();
});
const clients = [];
const pause = ms => new Promise(ok => setTimeout(ok, ms));

async function connect(name) {
  const socket = await new Promise((ok, fail) => {
    const ws = new WebSocket(endpoint);
    ws.addEventListener('open', () => ok(ws), { once: true });
    ws.addEventListener('error', () => fail(new Error('WebSocket not ready')), { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  const client = {
    socket,
    request(method, params) {
      return new Promise((ok, fail) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id); fail(new Error(`Timed out: ${method}`));
        }, 5000);
        pending.set(id, { ok, fail, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); }
    catch {
      protocolFailure = new Error('Malformed JSON from isolated App Server');
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer); waiter.fail(protocolFailure);
      }
      pending.clear();
      socket.close();
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter && !message.method) {
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.error) waiter.fail(new Error(message.error.message));
      else waiter.ok(message.result);
    } else if (name === 'observer' && message.method === 'thread/status/changed') {
      report.notifications.push({
        method: message.method, threadId: message.params?.threadId,
        status: message.params?.status,
      });
    }
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.fail(new Error('WebSocket closed'));
    }
    pending.clear();
  });
  clients.push(client);
  await client.request('initialize', {
    clientInfo: { name: `taskboard_smoke_${name}`, version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  return client;
}

async function step(name, action) {
  try {
    const result = await action();
    report.steps.push({ name, ok: true });
    return result;
  } catch (error) {
    report.steps.push({ name, ok: false, error: error.message });
    throw error;
  }
}

try {
  let observer;
  const deadline = Date.now() + 12_000;
  while (!observer && Date.now() < deadline && !serverExited) {
    try { observer = await connect('observer'); }
    catch { await pause(200); }
  }
  if (!observer) throw new Error('Isolated WebSocket server did not initialize');
  report.steps.push({ name: 'initialize_observer', ok: true });
  const owner = await step('initialize_second_client', () => connect('owner'));
  const created = await step('start_ephemeral_metadata_thread', () => owner.request(
    'thread/start', { ephemeral: true, cwd: process.cwd() }));
  const threadId = created.thread.id;
  report.ephemeralMetadataThreadsCreated = 1;
  const loaded = await step('observer_lists_same_backend', () => observer.request(
    'thread/loaded/list', {}));
  const read = await step('observer_reads_metadata_without_resume', () => observer.request(
    'thread/read', { threadId, includeTurns: false }));
  report.sameThreadVisibleToBothClients = loaded.data.includes(threadId)
    && read.thread.id === threadId;
  report.observerStatus = read.thread.status;
  await step('run_literal_printf_without_model_turn', () => owner.request(
    'thread/shellCommand', {
      threadId, command: "printf 'taskboard-status-probe\\n'", timeoutMs: 1000,
    }));
  report.auxiliaryShellCommandsRequested = 1;
  const broadcastDeadline = Date.now() + 2000;
  const hasStatus = type => report.notifications.some(event =>
    event.threadId === threadId && event.status?.type === type);
  while (!(hasStatus('active') && hasStatus('idle'))
         && Date.now() < broadcastDeadline) await pause(50);
  report.statusBroadcastObserved = report.notifications.some(event => event.threadId === threadId);
  report.activeAndIdleTransitionsObserved = hasStatus('active') && hasStatus('idle');
  if (protocolFailure) throw protocolFailure;
  // Exercise the attach-only observer's loss-of-connection reporting against
  // this disposable server, never against the user's desktop connection.
  const observerOutput = resolve('outputs/observer-disconnect-probe.json');
  const attached = spawn(process.execPath, ['scripts/observe-websocket-status.mjs', observerOutput], {
    env: { ...process.env, STATUS_PROBE_WS_URL: endpoint,
      STATUS_PROBE_THREAD_ID: threadId, STATUS_PROBE_WATCH_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let attachedExited = false;
  const attachedExit = new Promise(ok => attached.on('exit', () => {
    attachedExited = true; ok();
  }));
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('Attach-only observer did not become ready')), 5000);
      attached.once('error', error => { clearTimeout(timer); fail(error); });
      attached.stdout.on('data', chunk => {
        if (chunk.toString().includes('observer_ready')) { clearTimeout(timer); ok(); }
      });
    });
    child.kill('SIGTERM');
    await Promise.race([serverExit, pause(1500)]);
    await Promise.race([attachedExit, pause(3000)]);
    if (!attachedExited) throw new Error('Attach-only observer did not finish after disconnect');
    const disconnected = JSON.parse(await readFile(observerOutput, 'utf8'));
    report.observerDisconnectHandlingVerified = disconnected.connectionEstablished
      && disconnected.result === 'connected_then_disconnected';
    if (!report.observerDisconnectHandlingVerified) throw new Error('Disconnect was not reported');
  } finally {
    if (!attachedExited) { attached.kill('SIGTERM'); await Promise.race([attachedExit, pause(1000)]); }
  }
  report.result = report.sameThreadVisibleToBothClients && report.activeAndIdleTransitionsObserved
    ? 'isolated_two_client_status_broadcast_passed'
    : 'isolated_metadata_visibility_passed_but_full_status_transition_not_proven';
  if (report.result !== 'isolated_two_client_status_broadcast_passed') process.exitCode = 1;
} catch (error) {
  report.result = 'isolated_websocket_probe_failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  for (const client of clients) client.socket.close();
  if (!serverExited) {
    child.kill('SIGTERM');
    await Promise.race([serverExit, pause(1000)]);
    if (!serverExited) {
      child.kill('SIGKILL');
      await Promise.race([serverExit, pause(1500)]);
    }
  }
  if (diagnostics) report.serverDiagnostics = diagnostics;
  report.testServerExited = serverExited;
  if (serverExited) {
    await rm(isolatedHome, { recursive: true, force: true });
    report.isolatedHomeRemoved = true;
  } else {
    report.isolatedHomeRemoved = false;
    report.result = 'test_server_cleanup_not_confirmed';
    process.exitCode = 1;
  }
  await mkdir(join(work, '..', 'outputs'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
