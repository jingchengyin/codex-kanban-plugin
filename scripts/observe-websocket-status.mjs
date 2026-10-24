import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Attach-only observer for a user-authorized existing loopback App Server.
// No start/resume, tool execution, approval answers, or read-state writes.
const endpoint = new URL(process.env.STATUS_PROBE_WS_URL ?? 'ws://127.0.0.1:19429');
if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
  throw new Error('This experiment only accepts a local loopback ws:// endpoint');
}
const watchMs = Number(process.env.STATUS_PROBE_WATCH_MS ?? 15000);
if (!Number.isInteger(watchMs) || watchMs < 0 || watchMs > 45000) {
  throw new Error('STATUS_PROBE_WATCH_MS must be from 0 through 45000');
}
const targetId = process.env.STATUS_PROBE_THREAD_ID ?? process.env.CODEX_THREAD_ID;
const output = resolve(process.argv[2] ?? 'outputs/desktop-websocket-observer.json');
const report = {
  checkedAt: new Date().toISOString(), connectionEstablished: false,
  sameActiveDesktopThreadConfirmed: false, statusChanges: [],
  source: 'existing loopback App Server; metadata-only observer',
};
const socket = new WebSocket(endpoint);
const pending = new Map();
let sequence = 0;
let shuttingDown = false;
let rejectWatch = null;

function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
function disconnected(message) {
  if (shuttingDown) return;
  report.connectionLost = { observedAt: new Date().toISOString(), message };
  const error = new Error(message);
  rejectPending(error);
  rejectWatch?.(error);
}
socket.addEventListener('close', () => disconnected('Observer connection closed'));
socket.addEventListener('error', () => disconnected('Observer WebSocket error'));
socket.addEventListener('message', event => {
  let value;
  try { value = JSON.parse(event.data); } catch { return; }
  const waiter = pending.get(value.id);
  if (waiter && !value.method) {
    clearTimeout(waiter.timer);
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(value.error.message));
    else waiter.resolve(value.result);
  } else if (value.method === 'thread/status/changed') {
    report.statusChanges.push({
      receivedAt: new Date().toISOString(), threadId: value.params?.threadId,
      status: value.params?.status,
    });
  }
  // Incoming server approval requests are deliberately left unanswered.
});

function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`Timeout: ${method}`));
    }, 5000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('WebSocket connect timeout')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); ok(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer); fail(new Error('Cannot connect to existing local App Server'));
    }, { once: true });
  });
  await request('initialize', {
    clientInfo: { name: 'taskboard_desktop_status_observer', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  report.connectionEstablished = true;
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  const loaded = await request('thread/loaded/list', {});
  report.loadedThreadIds = loaded.data;
  if (targetId) {
    const read = await request('thread/read', { threadId: targetId, includeTurns: false });
    report.target = { threadId: targetId, status: read.thread?.status };
    report.sameActiveDesktopThreadConfirmed = loaded.data.includes(targetId)
      && read.thread?.status?.type === 'active';
  }
  console.log(JSON.stringify({ event: 'observer_ready',
    sameActiveDesktopThreadConfirmed: report.sameActiveDesktopThreadConfirmed }));
  await new Promise((ok, fail) => {
    if (report.connectionLost) { fail(new Error(report.connectionLost.message)); return; }
    const timer = setTimeout(() => { rejectWatch = null; ok(); }, watchMs);
    rejectWatch = error => { clearTimeout(timer); rejectWatch = null; fail(error); };
  });
  report.observationWindowCompleted = true;
  report.result = report.sameActiveDesktopThreadConfirmed
    ? 'same_active_thread_metadata_visible'
    : 'connected_but_live_desktop_identity_not_proven';
  if (!report.sameActiveDesktopThreadConfirmed) process.exitCode = 1;
} catch (error) {
  report.result = report.connectionEstablished
    ? (report.connectionLost ? 'connected_then_disconnected' : 'connected_but_observation_failed')
    : 'connection_failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  rejectPending(new Error('Observer finished'));
  shuttingDown = true;
  socket.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
