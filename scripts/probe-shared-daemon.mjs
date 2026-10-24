import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Uses only the official existing-daemon proxy. Never starts/resumes a thread,
// starts a daemon, changes config, answers approvals, or restarts the desktop.
const cli = process.env.STATUS_PROBE_CLI ?? process.env.CODEX_CLI_PATH ?? 'codex';
const threadId = process.env.STATUS_PROBE_THREAD_ID ?? process.env.CODEX_THREAD_ID;
const watchMs = Number(process.env.STATUS_PROBE_WATCH_MS ?? 0);
if (!Number.isInteger(watchMs) || watchMs < 0 || watchMs > 60_000) {
  throw new Error('STATUS_PROBE_WATCH_MS must be an integer from 0 to 60000');
}
const socket = process.env.STATUS_PROBE_CONTROL_SOCKET
  ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'),
          'app-server-control', 'app-server-control.sock');
const output = resolve(process.argv[2] ?? 'outputs/shared-daemon-probe.json');
const report = {
  checkedAt: new Date().toISOString(), transport: 'official existing-daemon stdio proxy',
  targetThreadProvided: Boolean(threadId), watchMs, steps: [], statusNotifications: [],
  durableReadStateNotifications: [],
  connectionEstablished: false,
  sameDesktopRuntimeConfirmed: false,
};
const child = spawn(cli, ['app-server', 'proxy', '--sock', socket], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let text = '';
let stderr = '';
let nextId = 0;
let exited = false;
const pending = new Map();

function fail(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

child.on('error', fail);
child.stdin.on('error', fail);
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500); });
child.on('exit', (code, signal) => {
  exited = true;
  fail(new Error(`Official proxy exited: ${code ?? signal}`));
});
child.stdout.on('data', chunk => {
  text += chunk.toString();
  for (let end; (end = text.indexOf('\n')) !== -1;) {
    const line = text.slice(0, end);
    text = text.slice(end + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (waiter && !message.method) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(
        new Error(message.error.message), { code: message.error.code }));
      else waiter.resolve(message.result);
    } else if (message.method === 'thread/status/changed') {
      report.statusNotifications.push({
        receivedAt: new Date().toISOString(), threadId: message.params?.threadId,
        status: message.params?.status,
      });
    } else if (message.method === 'thread/readState/changed') {
      report.durableReadStateNotifications.push({
        receivedAt: new Date().toISOString(), threadId: message.params?.threadId,
        readState: message.params?.readState,
      });
    }
    // Ignore server requests; a read-only observer never answers approval prompts.
  }
});

function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

async function step(name, action) {
  try {
    const value = await action();
    report.steps.push({ name, ok: true });
    return value;
  } catch (error) {
    report.steps.push({ name, ok: false, error: error.message });
    throw error;
  }
}

try {
  const initialization = await step('initialize_existing_daemon', () => request('initialize', {
    clientInfo: { name: 'taskboard_read_only_observer', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  }));
  report.initializationKeys = Object.keys(initialization ?? {});
  report.connectionEstablished = true;
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const loaded = await step('list_loaded_threads', () => request('thread/loaded/list', {}));
  report.loadedThreadIds = loaded.data ?? [];
  if (threadId) {
    const value = await step('read_target_metadata_only', () => request('thread/read', {
      threadId, includeTurns: false,
    }));
    report.targetStatus = value.thread?.status ?? null;
    report.targetDurableReadState = value.readState ?? null;
    report.sameDesktopRuntimeConfirmed = report.loadedThreadIds.includes(threadId)
      && value.thread?.status?.type === 'active';
  }
  if (watchMs) await new Promise(resolveWait => setTimeout(resolveWait, watchMs));
  report.result = report.sameDesktopRuntimeConfirmed
    ? 'active_caller_thread_visible_in_shared_backend'
    : 'daemon_available_but_same_live_desktop_backend_not_proven';
  if (!report.sameDesktopRuntimeConfirmed) process.exitCode = 1;
} catch (error) {
  report.result = report.connectionEstablished
    ? 'daemon_connected_but_metadata_observation_failed'
    : 'existing_daemon_connection_not_established';
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  if (stderr) report.proxyDiagnostics = stderr;
  fail(new Error('Probe finished'));
  if (!exited) {
    child.stdin.end();
    child.kill('SIGTERM');
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
