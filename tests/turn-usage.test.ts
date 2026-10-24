import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnUsageReader } from "../server/turn-usage";
import { elapsedMs, formatDuration, formatTokens } from "../ui/card-metrics";
import type { Thread } from "../shared/types";

const at = (seconds: number) =>
  new Date(1792800000000 + seconds * 1000).toISOString();
const line = (seconds: number, payload: object, type = "event_msg") =>
  JSON.stringify({ timestamp: at(seconds), type, payload }) + "\n";
const started = (id: string, seconds: number, mode = "default") =>
  line(seconds, {
    type: "task_started",
    turn_id: id,
    collaboration_mode_kind: mode,
  });
const tokens = (seconds: number, total: number) =>
  line(seconds, {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: { total_tokens: 5 },
    },
  });

async function fixture(
  run: (path: string, reader: TurnUsageReader) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-usage-"));
  try {
    await run(join(home, "rollout.jsonl"), new TurnUsageReader());
  } finally {
    await rm(home, { recursive: true });
  }
}

test("turn totals subtract the previous baseline, count all model requests once, and freeze on completion", () =>
  fixture(async (path, reader) => {
    await writeFile(
      path,
      started("first", 0) +
        tokens(1, 100) +
        started("second", 10, "plan") +
        tokens(11, 140) +
        tokens(12, 140) +
        tokens(13, 210) +
        line(20, {
          type: "task_complete",
          turn_id: "second",
          duration_ms: 9876,
          last_agent_message: "PRIVATE_BODY_MUST_NOT_LEAK",
        }),
    );
    const value = await reader.read(path);
    assert.equal(value.collaborationMode, "plan");
    assert.equal(value.turnUsage?.id, "second");
    assert.equal(value.turnUsage?.tokens, 110);
    assert.equal(value.turnUsage?.durationMs, 9876);
    assert.equal(value.turnUsage?.status, "completed");
    assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
    assert.deepEqual(await reader.read(path), value);
  }));

test("cached appends start a fresh turn, ignore partial writes, and retain interruptions", () =>
  fixture(async (path, reader) => {
    await writeFile(path, started("first", 0) + tokens(1, 100));
    assert.equal((await reader.read(path)).turnUsage?.tokens, 100);
    await appendFile(path, started("second", 10));
    let value = await reader.read(path);
    assert.equal(value.turnUsage?.tokens, 0);
    assert.equal(value.turnUsage?.id, "second");
    const next = tokens(12, 125);
    await appendFile(path, next.slice(0, -8));
    assert.equal((await reader.read(path)).turnUsage?.tokens, 0);
    await appendFile(
      path,
      next.slice(-8) + line(15, { type: "turn_aborted", turn_id: "second" }),
    );
    value = await reader.read(path);
    assert.equal(value.turnUsage?.tokens, 25);
    assert.equal(value.turnUsage?.status, "interrupted");
    assert.equal(value.turnUsage?.durationMs, 5000);
    await appendFile(path, started("third", 16) + tokens(17, 150));
    const concurrent = await Promise.all([
      reader.read(path),
      reader.read(path),
    ]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(concurrent[0].turnUsage?.tokens, 25);
    await writeFile(path, started("replacement", 20, "plan") + tokens(21, 7));
    assert.equal((await reader.read(path)).turnUsage?.tokens, 7);
  }));

test("backward reads cross large Unicode records and exclude a large unfinished tail", () =>
  fixture(async (path, reader) => {
    const body = line(2, {
      type: "agent_message",
      message: "正文🙂".repeat(40000),
    });
    const incomplete = JSON.stringify({
      timestamp: at(14),
      type: "response_item",
      payload: { text: "中".repeat(50000) },
    });
    await writeFile(
      path,
      started("first", 0) +
        tokens(1, 100) +
        body +
        started("second", 10) +
        tokens(11, 130) +
        body +
        tokens(13, 180) +
        incomplete,
    );
    let value = await reader.read(path);
    assert.equal(value.turnUsage?.id, "second");
    assert.equal(value.turnUsage?.tokens, 80);
    await appendFile(path, "\n" + tokens(15, 190));
    value = await reader.read(path);
    assert.equal(value.turnUsage?.tokens, 90);
  }));

test("missing files and reset counters remain unknown; context modes do not require message inspection", () =>
  fixture(async (path, reader) => {
    assert.deepEqual(await reader.read(path), {
      collaborationMode: null,
      turnUsage: null,
    });
    await writeFile(
      path,
      started("first", 0) +
        tokens(1, 100) +
        started("second", 10) +
        tokens(11, 20) +
        line(
          12,
          {
            collaboration_mode: {
              mode: "plan",
              settings: { developer_instructions: "PRIVATE" },
            },
          },
          "turn_context",
        ),
    );
    const value = await reader.read(path);
    assert.equal(value.turnUsage?.tokens, null);
    assert.equal(value.collaborationMode, "plan");
    assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
  }));

test("explicit per-turn usage takes precedence over a reset thread counter and survives reconnect reads", () =>
  fixture(async (path, reader) => {
    await writeFile(
      path,
      started("first", 0) +
        tokens(1, 1000) +
        started("second", 10) +
        line(
          11,
          {
            turn_id: "second",
            turn_token_usage: { total_tokens: 80 },
            thread_token_usage: { total_tokens: 80 },
          },
          "token_usage_record",
        ) +
        tokens(12, 80) +
        line(13, {
          type: "thread_settings_applied",
          thread_settings: { collaboration_mode: { mode: "plan" } },
        }),
    );
    const value = await reader.read(path);
    assert.equal(value.turnUsage?.tokens, 80);
    assert.equal(value.collaborationMode, "plan");
    assert.deepEqual(await new TurnUsageReader().read(path), value);
  }));

test("user input preserves the complete original text and excludes injected context and assistant replies", () =>
  fixture(async (path, reader) => {
    const original =
      "  # 原文标题\n\n```ts\n  const value = '中文🙂';  \n```\n第六行\n" +
      "继续".repeat(800) +
      "\n";
    await writeFile(
      path,
      started("current", 10) +
        line(
          11,
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "PRIVATE_INJECTED_CONTEXT" },
              { type: "input_text", text: original },
            ],
            internal_chat_message_metadata_passthrough: {
              turn_id: "current",
              content_item_kinds: [
                "environments.environment_context",
                "user.text",
              ],
            },
          },
          "response_item",
        ) +
        line(
          12,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "PRIVATE_ASSISTANT_REPLY" }],
          },
          "response_item",
        ) +
        line(13, {
          type: "task_complete",
          turn_id: "current",
          duration_ms: 3000,
        }),
    );
    const value = await reader.read(path);
    assert.equal(value.turnUsage?.userInput, original);
    assert.equal(value.turnUsage?.status, "completed");
    assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
    assert.deepEqual(await reader.read(path), value);
  }));

test("new turns clear old input; late items and question-reply envelopes cannot replace the current prompt", () =>
  fixture(async (path, reader) => {
    const message = (id: string, text: string) =>
      line(
        11,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
          internal_chat_message_metadata_passthrough: {
            turn_id: id,
            content_item_kinds: ["user.text"],
          },
        },
        "response_item",
      );
    await writeFile(
      path,
      started("first", 0) + message("first", "上一轮输入") + tokens(1, 100),
    );
    assert.equal((await reader.read(path)).turnUsage?.userInput, "上一轮输入");
    await appendFile(path, started("current", 10));
    assert.equal((await reader.read(path)).turnUsage?.userInput, null);
    await appendFile(
      path,
      message("first", "迟到的旧输入") +
        message("current", "新一轮输入\n  保留缩进"),
    );
    assert.equal(
      (await reader.read(path)).turnUsage?.userInput,
      "新一轮输入\n  保留缩进",
    );
    await appendFile(
      path,
      message(
        "current",
        '<send_user_message_question_reply>{"answer":"PRIVATE_ANSWER"}</send_user_message_question_reply>',
      ),
    );
    assert.equal(
      (await reader.read(path)).turnUsage?.userInput,
      "新一轮输入\n  保留缩进",
    );
    const followup =
      "<environment_context>\n用户自己输入的标签，也保留原文\n</environment_context>";
    await appendFile(path, message("current", followup));
    const value = await reader.read(path);
    assert.equal(value.turnUsage?.userInput, followup);
    assert.deepEqual(await new TurnUsageReader().read(path), value);
  }));

test("legacy user messages preserve whitespace and client context messages are excluded", () =>
  fixture(async (path, reader) => {
    const original = "  用户的原始文字\n\n- 原样显示  \n";
    await writeFile(
      path,
      started("current", 0) +
        line(1, { type: "user_message", message: original }) +
        line(
          2,
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>PRIVATE_CONTEXT</environment_context>",
              },
            ],
          },
          "response_item",
        ),
    );
    assert.equal((await reader.read(path)).turnUsage?.userInput, original);
  }));

test("active clocks advance, completed clocks freeze, and unavailable runtime does not keep counting", () => {
  const thread = {
    fresh: true,
    runtime: { type: "active", activeFlags: ["waitingOnUserInput"] },
    turnUsage: {
      id: "current",
      userInput: null,
      status: "inProgress",
      startedAt: at(10),
      completedAt: null,
      updatedAt: at(20),
      durationMs: null,
      tokens: 0,
    },
  } as Thread;
  assert.equal(elapsedMs(thread, Date.parse(at(30))), 20000);
  assert.equal(
    elapsedMs({ ...thread, fresh: false }, Date.parse(at(30))),
    10000,
  );
  assert.equal(
    elapsedMs(
      { ...thread, runtime: { type: "notLoaded" } },
      Date.parse(at(30)),
    ),
    10000,
  );
  assert.equal(
    elapsedMs({
      ...thread,
      turnUsage: {
        ...thread.turnUsage!,
        status: "completed",
        durationMs: 1234,
      },
    }),
    1234,
  );
  assert.equal(elapsedMs({ ...thread, turnUsage: null }), null);
  assert.equal(formatTokens(0), "0 tokens");
  assert.equal(formatTokens(null), "Token 未知");
  assert.equal(formatDuration(null), "耗时未知");
  assert.equal(formatDuration(0), "0秒");
  assert.equal(formatDuration(125000), "2分5秒");
  assert.equal(formatDuration(3660000), "1时1分");
  assert.equal(formatDuration(90000000), "1天1时");
});
