import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Read-only integration probe. Uses the shipped MCP implementation unchanged.
// Never calls a mutation tool or reads conversation bodies.
const serverPath = process.env.STATUS_PROBE_SERVER_PATH
  ?? '/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools/server.mjs';
const outputPath = resolve(process.argv[2] ?? 'outputs/independent-probe.json');
const timeoutMs = 15_000;
const report = {
  checkedAt: new Date().toISOString(),
  transport: 'shipped codex-app-tools MCP over stdio to desktop native pipe',
  pipeProvided: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
  callerContextProvided: Boolean(process.env.CODEX_THREAD_ID),
  serverPath,
  steps: [],
};
const child = spawn(process.env.CODEX_MCP_NODE_PATH ?? process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let sequence = 0;
let buffer = '';
let stderr = '';
let stopped = false;

function failPending(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

child.on('error', failPending);
child.stdin.on('error', failPending);
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
child.on('exit', (code, signal) => {
  stopped = true;
  failPending(new Error(`MCP server exited: ${code ?? signal}`));
});
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  for (let end; (end = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { failPending(new Error('Invalid JSON from shipped MCP server')); continue; }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    } else waiter.resolve(message.result);
  }
});

function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`Timed out waiting for ${method}`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function step(name, action) {
  const started = Date.now();
  try {
    const result = await action();
    report.steps.push({ name, ok: true, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    report.steps.push({ name, ok: false, elapsedMs: Date.now() - started, error: {
      code: error.code ?? null, message: error.message,
    } });
    throw error;
  }
}

try {
  const initialized = await step('mcp_initialize', () => request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'read-only-status-chain-probe', version: '0.1.0' },
  }));
  report.serverInfo = initialized.serverInfo;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await step('desktop_tool_catalog', () => request('tools/list', {}));
  report.statusTools = catalog.tools
    .filter((tool) => /(?:^|__)list_threads$|(?:^|__)wait_threads$|(?:^|__)read_thread$/.test(tool.name))
    .map((tool) => tool.name);
  const listTool = catalog.tools.find((tool) => /(?:^|__)list_threads$/.test(tool.name));
  if (!listTool) throw new Error('Desktop did not expose list_threads');
  if (!process.env.CODEX_THREAD_ID) throw new Error('No authentic caller thread context was inherited');
  const result = await step('desktop_status_snapshot', () => request('tools/call', {
    name: listTool.name,
    arguments: { limit: 20 },
    _meta: { 'x-codex-turn-metadata': { thread_id: process.env.CODEX_THREAD_ID } },
  }));
  if (result.isError) throw new Error('Desktop rejected the read-only status tool call');
  const content = result.content?.find((item) => item.type === 'text');
  const snapshot = JSON.parse(content?.text ?? '{}');
  report.snapshot = {
    schemaVersion: snapshot.schemaVersion,
    threads: [...(snapshot.pinnedThreads ?? []), ...(snapshot.threads ?? [])].map((thread) => ({
      id: thread.id, kind: thread.kind, status: thread.status,
      isUnread: thread.isUnread, hostId: thread.hostId ?? null,
    })),
    unavailableHosts: snapshot.unavailableHosts ?? [],
    unavailableSources: snapshot.unavailableSources ?? [],
  };
  report.result = 'independent_snapshot_passed';
} catch (error) {
  report.result = 'independent_snapshot_not_established';
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  if (stderr) report.serverStderr = stderr;
  failPending(new Error('Probe finished'));
  if (!stopped) {
    child.stdin.end();
    child.kill('SIGTERM');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
