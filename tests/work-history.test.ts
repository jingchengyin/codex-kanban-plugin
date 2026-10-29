import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  appendFile,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkHistoryReader,
  readWorkReview,
  summarizeWork,
  workReviewRange,
} from "../server/work-history";

const timestamp = (seconds: number) =>
  new Date(Date.parse("2026-10-26T01:00:00Z") + seconds * 1000).toISOString();
const line = (seconds: number, payload: object, type = "event_msg") =>
  JSON.stringify({ timestamp: timestamp(seconds), type, payload }) + "\n";
const start = (id: string, seconds: number) =>
  line(seconds, { type: "task_started", turn_id: id });
const tokens = (seconds: number, total: number) =>
  line(seconds, {
    type: "token_count",
    info: { total_token_usage: { total_tokens: total } },
  });
const exact = (
  id: string,
  seconds: number,
  total: number,
  threadTotal = total,
) =>
  line(
    seconds,
    {
      turn_id: id,
      turn_token_usage: { total_tokens: total },
      thread_token_usage: { total_tokens: threadTotal },
    },
    "token_usage_record",
  );
const finish = (id: string, seconds: number, type = "task_complete") =>
  line(seconds, { type, turn_id: id });

async function fixture(run: (home: string, path: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-history-"));
  try {
    await run(home, join(home, "rollout.jsonl"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("history keeps all turns, exact usage wins, repeated events do not count twice, and unknown stays unknown", () =>
  fixture(async (_home, path) => {
    const reader = new WorkHistoryReader();
    await writeFile(
      path,
      start("first", 0) +
        tokens(1, 100) +
        finish("first", 3) +
        start("second", 4) +
        tokens(5, 135) +
        finish("second", 6, "turn_aborted") +
        exact("first", 7, 90, 100) +
        exact("second", 8, 40, 140) +
        start("second", 4) +
        start("third", 9),
    );
    const records = await reader.read(path);
    assert.equal(records.length, 3);
    assert.equal(records[0].tokens, 90);
    assert.equal(records[0].status, "completed");
    assert.equal(records[1].tokens, 40);
    assert.equal(records[1].status, "interrupted");
    assert.equal(records[2].tokens, null);
    assert.equal(records[2].status, "inProgress");
    assert.deepEqual(summarizeWork(records), {
      turns: 3,
      completed: 1,
      interrupted: 1,
      inProgress: 1,
      tokens: 130,
      unknownTokens: 1,
      durationMs: 5000,
      unknownDuration: 1,
    });
    assert.deepEqual(await reader.read(path), records);
  }));

test("history incrementally reads appends and ignores incomplete tails, including large Unicode records", () =>
  fixture(async (_home, path) => {
    const reader = new WorkHistoryReader();
    await writeFile(
      path,
      start("first", 0) +
        tokens(1, 100) +
        line(2, {
          type: "agent_message",
          message: "PRIVATE中🙂".repeat(25000),
        }) +
        finish("first", 3),
    );
    assert.equal((await reader.read(path))[0].tokens, 100);
    const addition = start("second", 4) + tokens(5, 145);
    await appendFile(path, addition.slice(0, -7));
    let records = await reader.read(path);
    assert.equal(records.length, 2);
    assert.equal(records[1].tokens, null);
    await appendFile(path, addition.slice(-7) + finish("second", 9));
    const concurrent = await Promise.all([
      reader.read(path),
      reader.read(path),
    ]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    records = concurrent[0];
    assert.equal(records[1].tokens, 45);
    assert.equal(records[1].durationMs, 5000);
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
    assert.deepEqual(await new WorkHistoryReader().read(path), records);
  }));

test("history handles truncation and file replacement without retaining old turns", () =>
  fixture(async (_home, path) => {
    const reader = new WorkHistoryReader();
    await writeFile(
      path,
      start("first", 0) + tokens(1, 100) + finish("first", 3),
    );
    assert.equal((await reader.read(path))[0].id, "first");
    await writeFile(path, start("short", 4));
    assert.deepEqual(
      (await reader.read(path)).map((turn) => turn.id),
      ["short"],
    );
    await writeFile(
      path + ".replacement",
      start("replacement", 5) + exact("replacement", 6, 23),
    );
    await rename(path + ".replacement", path);
    assert.deepEqual(
      (await reader.read(path)).map((turn) => [turn.id, turn.tokens]),
      [["replacement", 23]],
    );
  }));

test("reviews with more than 500 logs do not rescan unchanged files, and shrinking the query prunes its cache", (context) =>
  fixture(async (home) => {
    const reader = new WorkHistoryReader();
    const paths = Array.from({ length: 512 }, (_, index) =>
      join(home, `${index}.jsonl`),
    );
    await Promise.all(
      paths.map((path) => writeFile(path, start("turn", 0) + tokens(1, 10))),
    );
    const scan = async () => {
      reader.retain(new Set(paths));
      for (let offset = 0; offset < paths.length; offset += 8)
        await Promise.all(
          paths.slice(offset, offset + 8).map((path) => reader.read(path)),
        );
    };
    await scan();
    const sample = await open(paths[0], "r");
    const reads = context.mock.method(Object.getPrototypeOf(sample), "read");
    await sample.close();
    await scan();
    assert.equal(
      reads.mock.callCount(),
      0,
      "unchanged logs should need stat checks but no content reads",
    );
    reader.retain(new Set(paths.slice(1)));
    assert.equal((await reader.read(paths[0]))[0].tokens, 10);
    assert.ok(
      reads.mock.callCount() > 0,
      "logs outside the query should be removed from cache",
    );
  }));

test("history preserves original user inputs and turn model, excluding injected context and assistant content", () =>
  fixture(async (_home, path) => {
    const text = "  原始输入\n\n保留排版🙂  ";
    await writeFile(
      path,
      start("first", 0) +
        line(
          1,
          {
            turn_id: "first",
            model: "test-model",
            developer_instructions: "PRIVATE_INSTRUCTIONS",
          },
          "turn_context",
        ) +
        line(
          2,
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "PRIVATE_CONTEXT" },
              { type: "input_text", text },
            ],
            internal_chat_message_metadata_passthrough: {
              turn_id: "first",
              content_item_kinds: [
                "environments.environment_context",
                "user.text",
              ],
            },
          },
          "response_item",
        ) +
        line(
          3,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "PRIVATE_REPLY" }],
          },
          "response_item",
        ) +
        line(
          4,
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<send_user_message_question_reply>PRIVATE_ANSWER</send_user_message_question_reply>",
              },
            ],
            internal_chat_message_metadata_passthrough: {
              turn_id: "first",
              content_item_kinds: ["user.text"],
            },
          },
          "response_item",
        ) +
        finish("first", 5),
    );
    const records = await new WorkHistoryReader().read(path);
    assert.equal(records[0].userInput, text);
    assert.equal(records[0].model, "test-model");
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
  }));

test("counter resets stay unknown until exact usage arrives, and orphan completions retain missing start time", () =>
  fixture(async (_home, path) => {
    const reader = new WorkHistoryReader();
    await writeFile(
      path,
      start("first", 0) +
        tokens(1, 1000) +
        finish("first", 2) +
        start("second", 3) +
        tokens(4, 30) +
        tokens(4, 1100) +
        finish("second", 5) +
        finish("orphan", 6),
    );
    let records = await reader.read(path);
    assert.equal(records[1].tokens, null);
    assert.equal(records[2].startedAt, null);
    assert.equal(records[2].durationMs, null);
    await appendFile(path, exact("second", 7, 35));
    records = await reader.read(path);
    assert.equal(records[1].tokens, 35);
  }));

test("calendar ranges follow the requested timezone and daylight-saving boundaries", () => {
  assert.deepEqual(
    workReviewRange(1, "Asia/Shanghai", new Date("2026-10-25T17:00:00Z")),
    { from: "2026-10-25T16:00:00.000Z", to: "2026-10-26T16:00:00.000Z" },
  );
  assert.deepEqual(
    workReviewRange(1, "America/New_York", new Date("2026-03-08T18:00:00Z")),
    { from: "2026-03-08T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z" },
  );
  assert.deepEqual(
    workReviewRange(1, "America/New_York", new Date("2026-11-01T18:00:00Z")),
    { from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" },
  );
  assert.throws(() => workReviewRange(0, "UTC"), RangeError);
  assert.throws(() => workReviewRange(91, "UTC"), RangeError);
  assert.throws(() => workReviewRange(7, "Invalid/Timezone"));
});

test("review includes archived conversations, filters by full project path, and marks missing logs", () =>
  fixture(async (home, path) => {
    const today = new Date();
    const currentLine = (payload: object, type = "event_msg") =>
      JSON.stringify({ timestamp: today.toISOString(), type, payload }) + "\n";
    await writeFile(
      path,
      currentLine({ type: "task_started", turn_id: "turn" }) +
        currentLine({
          type: "user_message",
          turn_id: "turn",
          message: "原始请求",
        }) +
        currentLine(
          { turn_id: "turn", turn_token_usage: { total_tokens: 123 } },
          "token_usage_record",
        ) +
        currentLine({
          type: "task_complete",
          turn_id: "turn",
          duration_ms: 1000,
        }),
    );
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER, rollout_path TEXT, model TEXT)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const updated = Math.floor(Date.now() / 1000);
    insert.run(
      "one",
      "Title",
      "Archived title",
      "/repo/one",
      "vscode",
      1,
      updated,
      path,
      "CURRENT_MODEL_MUST_NOT_REPLACE_HISTORY",
    );
    insert.run(
      "two",
      "Second",
      null,
      "/other/one",
      "cli",
      0,
      updated,
      path,
      null,
    );
    insert.run(
      "missing",
      "Missing",
      null,
      "/repo/one",
      "cli",
      0,
      updated,
      join(home, "missing.jsonl"),
      null,
    );
    database.close();
    const review = await readWorkReview(home, {
      days: 7,
      timezone: "UTC",
      project: "/repo/one",
    });
    assert.equal(review.sources.metadata, true);
    assert.equal(review.sources.scannedThreads, 3);
    assert.equal(review.sources.unavailableLogs, 1);
    assert.equal(review.records.length, 1);
    assert.equal(review.records[0].archived, true);
    assert.equal(review.records[0].title, "Archived title");
    assert.equal(review.records[0].cwd, "/repo/one");
    assert.equal(review.records[0].model, null);
    assert.equal(review.totalRecords, 1);
    assert.equal(review.summary.tokens, 246);
    assert.equal(review.projects.length, 2);
    assert.equal(
      review.projects.find((project) => project.cwd === "/repo/one")?.tokens,
      123,
    );
    assert.match(review.sources.message!, /部分/);
    const all = await readWorkReview(home, { days: 7, timezone: "UTC" });
    assert.equal(all.records.length, 2);
    assert.equal(all.totalRecords, 2);
    assert.equal(all.projects.length, 2);
  }));

test("review only counts user-initiated main-thread turns, preserving image-only input and complete project summaries", () =>
  fixture(async (home, path) => {
    const at = new Date().toISOString();
    const entry = (payload: object, type = "event_msg") =>
      JSON.stringify({ timestamp: at, type, payload }) + "\n";
    const turn = (id: string, input: string | null, count: number) =>
      entry({ type: "task_started", turn_id: id }) +
      (input === null
        ? ""
        : entry({ type: "user_message", turn_id: id, message: input })) +
      entry(
        { turn_id: id, turn_token_usage: { total_tokens: count } },
        "token_usage_record",
      ) +
      entry({ type: "task_complete", turn_id: id, duration_ms: 1000 });
    // 子代理继承父回合时，正文和用量都存在；必须按线程来源排除整个日志。
    const inherited = turn("parent-turn", "父线程请求", 5);
    const image =
      entry({ type: "task_started", turn_id: "image-only" }) +
      entry(
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# Files mentioned by the user:\n\n## image.png: /tmp/image.png\nImage attachment: true\n\n## My request:\n",
            },
            { type: "input_text", text: '<image name="image.png">' },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            { type: "input_text", text: "</image>" },
          ],
          internal_chat_message_metadata_passthrough: {
            turn_id: "image-only",
            content_item_kinds: [
              "user.text",
              "user.text",
              "user.image",
              "user.text",
            ],
          },
        },
        "response_item",
      ) +
      entry(
        { turn_id: "image-only", turn_token_usage: { total_tokens: 7 } },
        "token_usage_record",
      ) +
      entry({
        type: "task_complete",
        turn_id: "image-only",
        duration_ms: 1000,
      });
    await writeFile(path, inherited + image + turn("automatic", null, 200));
    const legacyVscode = join(home, "legacy-vscode.jsonl");
    const legacyCli = join(home, "legacy-cli.jsonl");
    const explicit = join(home, "explicit-user.jsonl");
    await Promise.all([
      writeFile(legacyVscode, turn("vscode-turn", "旧版编辑器请求", 11)),
      writeFile(legacyCli, turn("cli-turn", "旧版命令行请求", 13)),
      writeFile(explicit, turn("explicit-turn", "明确用户来源", 17)),
    ]);
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, thread_source TEXT, agent_role TEXT, updated_at INTEGER, rollout_path TEXT)",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const updated = Math.floor(Date.now() / 1000);
    for (const [id, cwd, source, threadSource, role, log] of [
      ["parent", "/repo/main", "vscode", "user", null, path],
      ["legacy-vscode", "/repo/main", "vscode", null, null, legacyVscode],
      ["legacy-cli", "/repo/cli", "cli", null, null, legacyCli],
      ["explicit", "/repo/explicit", "app_server", "user", null, explicit],
      [
        "spawn",
        "/repo/internal",
        '{"subagent":{"thread_spawn":{}}}',
        "subagent",
        null,
        path,
      ],
      ["guardian", "/repo/internal", "vscode", "guardian_review", null, path],
      ["automation", "/repo/internal", "vscode", "automation", null, path],
      ["unknown-kind", "/repo/internal", "vscode", "unknown", null, path],
      ["unknown-source", "/repo/internal", "unknown", null, null, path],
      ["agent-role", "/repo/internal", "vscode", "user", "reviewer", path],
      [
        "agent-source",
        "/repo/internal",
        '{"subagent":{"other":"guardian"}}',
        "user",
        null,
        path,
      ],
      ["subagent-kind", "/repo/internal", "vscode", "subagent", null, path],
    ])
      insert.run(
        id,
        "Test thread",
        cwd,
        source,
        threadSource,
        role,
        updated,
        log,
      );
    database.close();

    const options = { days: 7, timezone: "UTC" };
    const review = await readWorkReview(home, options);
    assert.equal(review.totalRecords, 5);
    assert.equal(review.summary.turns, 5);
    assert.equal(review.summary.tokens, 53);
    assert.equal(review.summary.durationMs, 5000);
    assert.ok(review.records.every((record) => record.kind === "user"));
    assert.ok(review.records.every((record) => record.userInput !== null));
    assert.equal(
      review.records.find((record) => record.id === "image-only")?.userInput,
      "",
    );
    assert.equal(
      review.records.filter((record) => record.id === "parent-turn").length,
      1,
    );
    assert.equal(
      review.projects.some((project) => project.cwd === "/repo/internal"),
      false,
    );

    const first = await readWorkReview(home, {
      ...options,
      project: "/repo/main",
      limit: 2,
    });
    const second = await readWorkReview(home, {
      ...options,
      project: "/repo/main",
      offset: 2,
      limit: 2,
    });
    assert.equal(first.totalRecords, 3);
    assert.equal(first.records.length, 2);
    assert.equal(second.records.length, 1);
    assert.equal(
      new Set([...first.records, ...second.records].map((record) => record.id))
        .size,
      3,
    );
    assert.ok(
      [...first.records, ...second.records].every(
        (record) => record.cwd === "/repo/main",
      ),
    );
    assert.deepEqual(first.summary, review.summary);
    assert.deepEqual(second.summary, review.summary);
    assert.deepEqual(first.projects, review.projects);
    assert.equal(
      first.projects.find((project) => project.cwd === "/repo/main")?.tokens,
      23,
    );
  }));

test("review pages preserve full summaries, project options, and original inputs without repeating records", () =>
  fixture(async (home, path) => {
    const input = "完整用户输入🙂".repeat(1000);
    const at = new Date().toISOString();
    const entry = (payload: object) =>
      JSON.stringify({ timestamp: at, type: "event_msg", payload }) + "\n";
    await writeFile(
      path,
      Array.from({ length: 73 }, (_, index) => {
        const id = `turn-${String(index).padStart(3, "0")}`;
        return (
          entry({ type: "task_started", turn_id: id }) +
          entry({ type: "user_message", turn_id: id, message: input }) +
          entry({ type: "task_complete", turn_id: id, duration_ms: 1000 })
        );
      }).join(""),
    );
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, updated_at INTEGER, rollout_path TEXT)",
    );
    database
      .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "one",
        "Title",
        "/repo/one",
        "vscode",
        Math.floor(Date.now() / 1000),
        path,
      );
    database.close();
    const options = { days: 7, timezone: "UTC" };
    const first = await readWorkReview(home, options);
    assert.equal(first.totalRecords, 73);
    assert.equal(first.records.length, 50);
    assert.equal(first.summary.turns, 73);
    assert.equal(first.summary.durationMs, 73000);
    assert.equal(first.projects[0].turns, 73);
    assert.equal(first.records[0].userInput, input);
    const second = await readWorkReview(home, { ...options, offset: 50 });
    assert.equal(second.totalRecords, 73);
    assert.equal(second.records.length, 23);
    assert.deepEqual(second.summary, first.summary);
    assert.deepEqual(second.projects, first.projects);
    assert.equal(
      new Set([...first.records, ...second.records].map((record) => record.id))
        .size,
      73,
    );
    const narrow = await readWorkReview(home, {
      ...options,
      offset: 1,
      limit: 2,
    });
    assert.deepEqual(narrow.records, first.records.slice(1, 3));
    const pastEnd = await readWorkReview(home, { ...options, offset: 100 });
    assert.deepEqual(pastEnd.records, []);
    assert.equal(pastEnd.totalRecords, 73);
    assert.deepEqual(pastEnd.summary, first.summary);
    const missingProject = await readWorkReview(home, {
      ...options,
      project: "/repo/absent",
    });
    assert.deepEqual(missingProject.records, []);
    assert.equal(missingProject.totalRecords, 0);
    assert.deepEqual(missingProject.summary, first.summary);
    assert.deepEqual(missingProject.projects, first.projects);
  }));

test("review rejects invalid page sizes and offsets", () =>
  fixture(async (home) => {
    for (const page of [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: NaN },
      { offset: -1 },
      { offset: 0.5 },
      { offset: Infinity },
    ])
      await assert.rejects(
        readWorkReview(home, { days: 7, timezone: "UTC", ...page }),
        RangeError,
      );
  }));

test("missing metadata produces an explicit unavailable source instead of an apparently successful empty report", () =>
  fixture(async (home) => {
    const review = await readWorkReview(home, { days: 7, timezone: "UTC" });
    assert.equal(review.sources.metadata, false);
    assert.equal(review.summary.turns, 0);
    assert.match(review.sources.message!, /无法读取/);
  }));
