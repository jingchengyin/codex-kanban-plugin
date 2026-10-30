import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  readConfirmations,
  replyToConfirmation,
} from "../server/confirmations";
import type { ConfirmationReply } from "../shared/confirmations";

/** 使用真实本机 HTTP 通道验证转发，消息来自隔离的桌面协议样本。 */
async function fixture(run: (f: any) => Promise<void>) {
  const { approvalRelay } = await import(
    pathToFileURL(resolve("scripts/approval-relay.mjs")).href
  );
  const reserve = net.createServer();
  await new Promise<void>((ok) => reserve.listen(0, "127.0.0.1", ok));
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((ok) => reserve.close(() => ok()));
  const endpoint = `ws://127.0.0.1:${port - 1}`;
  const sent: any[] = [];
  let connected = true;
  const relay = approvalRelay(endpoint, (message: any) => {
    if (!connected) return false;
    sent.push(message);
    return true;
  });
  await relay.start();
  try {
    await run({
      relay,
      endpoint,
      sent,
      port,
      disconnect: () => {
        connected = false;
      },
    });
  } finally {
    relay.close();
  }
}
const params = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  command: "git push origin main",
  cwd: "/work",
  reason: "Push reviewed changes",
};
const request = (id: number, extra = {}) => ({
  method: "item/commandExecution/requestApproval",
  id,
  params: { ...params, ...extra },
});

test("reading approvals never answers; explicit replies preserve the original ID and only allow offered decisions", async () => {
  await fixture(async ({ relay, endpoint, sent }) => {
    relay.observe(
      request(0, {
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "push"],
            },
          },
          "decline",
        ],
      }),
    );
    const { requests } = await readConfirmations(endpoint);
    assert.equal(requests[0].command, params.command);
    assert.equal(requests[0].reason, params.reason);
    assert.deepEqual(requests[0].decisions, ["accept", "decline"]);
    assert.deepEqual(sent, []);
    const reply = {
      id: requests[0].id,
      threadId: "thread",
      decision: "accept",
    } as const;
    await assert.rejects(
      replyToConfirmation(endpoint, { ...reply, decision: "cancel" }),
    );
    await assert.rejects(
      replyToConfirmation(endpoint, { ...reply, threadId: "other" }),
    );
    await assert.rejects(
      replyToConfirmation(endpoint, {
        ...reply,
        decision: "acceptForSession",
      } as unknown as ConfirmationReply),
    );
    assert.deepEqual(sent, []);
    await replyToConfirmation(endpoint, reply);
    assert.deepEqual(sent, [{ id: 0, result: { decision: "accept" } }]);
    await assert.rejects(
      replyToConfirmation(endpoint, reply),
      /已处理或已失效/,
    );
    assert.equal((await readConfirmations(endpoint)).requests.length, 0);
  });
});

test("desktop replies, resolved requests and turn cleanup invalidate board actions", async () => {
  await fixture(async ({ relay, endpoint, sent }) => {
    for (const cleanup of [
      () => relay.desktopResponse({ id: 42, result: { decision: "accept" } }),
      () =>
        relay.observe({
          method: "serverRequest/resolved",
          params: { threadId: "thread", requestId: 42 },
        }),
      () =>
        relay.observe({
          method: "turn/completed",
          params: { threadId: "thread" },
        }),
      () =>
        relay.observe({
          method: "thread/closed",
          params: { threadId: "thread" },
        }),
    ]) {
      relay.observe(request(42));
      const [pending] = (await readConfirmations(endpoint)).requests;
      cleanup();
      await assert.rejects(
        replyToConfirmation(endpoint, {
          id: pending.id,
          threadId: "thread",
          decision: "accept",
        }),
        /已处理或已失效/,
      );
    }
    assert.deepEqual(sent, []);
  });
});

test("file changes expose the actual diff and do not offer acceptance without a preview", async () => {
  await fixture(async ({ relay, endpoint }) => {
    const item = {
      id: "item",
      type: "fileChange",
      changes: [{ path: "/work/file.ts", diff: "-old\n+new" }],
    };
    relay.observe({
      method: "item/started",
      params: { threadId: "thread", item },
    });
    relay.observe({ method: "item/fileChange/requestApproval", id: 8, params });
    const [pending] = (await readConfirmations(endpoint)).requests;
    assert.match(pending.details!, /\/work\/file.ts\n-old\n\+new/);
    assert.ok(pending.decisions.includes("accept"));
    relay.observe({
      method: "item/fileChange/requestApproval",
      id: 9,
      params: { ...params, itemId: "unknown" },
    });
    const missing = (await readConfirmations(endpoint)).requests[1];
    assert.equal(missing.decisions.includes("accept"), false);
  });
});

test("structured answers require every question and use native answer payloads", async () => {
  await fixture(async ({ relay, endpoint, sent }) => {
    relay.observe({
      method: "item/tool/requestUserInput",
      id: "question-id",
      params: {
        ...params,
        questions: [
          {
            id: "a",
            question: "Deploy where?",
            options: [
              { label: "Staging", description: "Isolated environment" },
            ],
          },
          { id: "b", question: "Release name?", options: null },
        ],
      },
    });
    const [pending] = (await readConfirmations(endpoint)).requests;
    assert.equal(pending.questions[0].options[0].label, "Staging");
    await assert.rejects(
      replyToConfirmation(endpoint, {
        id: pending.id,
        threadId: "thread",
        answers: { a: { answers: ["Staging"] } },
      }),
    );
    const answers = { a: { answers: ["Staging"] }, b: { answers: ["v1"] } };
    await replyToConfirmation(endpoint, {
      id: pending.id,
      threadId: "thread",
      answers,
    });
    assert.deepEqual(sent, [{ id: "question-id", result: { answers } }]);
  });
});

test("disconnected transports, unsupported requests and browser calls cannot submit confirmations", async () => {
  await fixture(async ({ relay, endpoint, sent, port, disconnect }) => {
    relay.observe({
      method: "item/permissions/requestApproval",
      id: 7,
      params,
    });
      relay.observe(request(8, { kind: "writeStdin" }));
    assert.equal((await readConfirmations(endpoint)).requests.length, 0);
    relay.observe(request(1));
    const [pending] = (await readConfirmations(endpoint)).requests;
    for (const headers of [
      { Origin: "https://other.example" },
      { Origin: `http://127.0.0.1:${port}` },
      { "Sec-Fetch-Site": "same-origin" },
    ] as Record<string, string>[]) {
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/respond`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        403,
      );
    }
    disconnect();
    await assert.rejects(
      replyToConfirmation(endpoint, {
        id: pending.id,
        threadId: "thread",
        decision: "accept",
      }),
      /断开/,
    );
    assert.deepEqual(sent, []);
  });
});
