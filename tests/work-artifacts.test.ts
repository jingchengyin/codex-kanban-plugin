import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs, {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkArtifactReader } from "../server/work-artifacts.js";
import type { ArtifactDiscovery } from "../shared/work-items.js";

const first = "a0000000-0000-4000-8000-000000000001";
const second = "a0000000-0000-4000-8000-000000000002";
const third = "a0000000-0000-4000-8000-000000000003";
const timestamp = (seconds = 0) =>
  new Date(Date.parse("2026-10-26T01:00:00Z") + seconds * 1000).toISOString();
const entry = (payload: object, type = "event_msg", seconds = 0) =>
  JSON.stringify({ timestamp: timestamp(seconds), type, payload }) + "\n";
const assistant = (text: string, extra = {}, seconds = 0) =>
  entry(
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
      ...extra,
    },
    "response_item",
    seconds,
  );
const final = (text: string, seconds = 0) =>
  assistant(text, { phase: "final_answer" }, seconds);
const proposed = (content: string) =>
  `<proposed_plan>\n${content}\n</proposed_plan>`;
const urls = (result: ArtifactDiscovery) =>
  result.artifacts
    .flatMap((artifact) =>
      artifact.kind === "mergeRequest" ? [artifact.url] : [],
    )
    .sort();
const paths = (result: ArtifactDiscovery) =>
  result.artifacts
    .flatMap((artifact) =>
      artifact.kind === "planFile" ? [artifact.path] : [],
    )
    .sort();

async function fixture(
  run: (home: string, path: string, cwd: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "taskboard-artifacts-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const path = join(home, "first.jsonl");
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, archived INTEGER)",
  );
  database
    .prepare("INSERT INTO threads VALUES(?, ?, ?, ?)")
    .run(first, cwd, path, 0);
  database.close();
  try {
    await run(home, path, cwd);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("final answers discover canonical MR/PR URLs, preserve labels, and ignore users, tools, commentary and code examples", () =>
  fixture(async (home, path) => {
    await writeFile(
      path,
      entry(
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "https://github.com/team/repo/pull/99",
            },
          ],
        },
        "response_item",
      ) +
        entry(
          {
            type: "function_call_output",
            output: "https://github.com/team/repo/pull/98",
          },
          "response_item",
        ) +
        entry(
          {
            type: "message",
            role: "system",
            content: [
              { type: "text", text: "https://github.com/team/repo/pull/97" },
            ],
            channel: "final",
          },
          "response_item",
        ) +
        assistant("https://github.com/team/repo/pull/96", {
          channel: "commentary",
        }) +
        final(
          [
            "MR：[实现变更](https://git.example/group/sub/repo/-/merge_requests/12/diffs?view=inline#note_1)",
            "重复地址 https://git.example/group/sub/repo/-/merge_requests/12/changes",
            "Codebase：https://code.byted.org/team/repo/merge_requests/8/commits?tab=all。",
            "PR：https://github.com/team/repo/pull/7/files#diff",
            "认证地址 https://user:secret@git.example/team/repo/merge_requests/44",
            "参考 https://example.com/docs/design",
            "```sh",
            "echo https://github.com/team/repo/pull/95",
            "```",
            "~~~markdown",
            "[example](https://git.example/team/repo/merge_requests/94)",
            "~~~",
          ].join("\n"),
          3,
        ),
    );
    const reader = new WorkArtifactReader();
    const result = await reader.read(home, [first, first]);
    assert.deepEqual(urls(result), [
      "https://code.byted.org/team/repo/merge_requests/8",
      "https://git.example/group/sub/repo/-/merge_requests/12",
      "https://github.com/team/repo/pull/7",
    ]);
    assert.deepEqual(result.unavailableThreadIds, []);
    assert.equal(
      result.artifacts.find((artifact) => artifact.label === "实现变更")
        ?.detectedAt,
      timestamp(3),
    );
    assert.ok(
      result.artifacts.every(
        (artifact) =>
          /^[a-f0-9]{64}$/.test(artifact.id) && artifact.threadId === first,
      ),
    );
    assert.deepEqual(await reader.read(home, [first]), result);
  }));

test("configured prefixes recognize final document links with labels and path boundaries while preserving MR precedence", () =>
  fixture(async (home, path) => {
    const prefix = "https://bytedance.sg.larkoffice.com/docx";
    const document = `${prefix}/VTWBdRKXso20opxNAC2liEuDgpf`;
    const bare = `${prefix}/bare?from=board#section`;
    const mr = "https://code.byted.org/dp/data-brain/merge_requests/1570";
    await writeFile(
      path,
      entry(
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${prefix}/user` }],
        },
        "response_item",
      ) +
        entry(
          { type: "function_call_output", output: `${prefix}/tool` },
          "response_item",
        ) +
        assistant(`${prefix}/commentary`, { channel: "commentary" }) +
        final(
          [
            `[消费端小批次提交方案](${document})`,
            `重复地址：${document}。`,
            `其他成果：${bare}；`,
            `${prefix}evil/other`,
            "https://bytedance.sg.larkoffice.com.evil.test/docx/other",
            "http://bytedance.sg.larkoffice.com/docx/other",
            "https://user:secret@bytedance.sg.larkoffice.com/docx/other",
            `${mr}/diffs?view=inline`,
            "```markdown",
            `[示例](${prefix}/example)`,
            "```",
          ].join("\n"),
          1,
        ),
    );
    const rules = {
      urlPrefixes: [prefix, "https://code.byted.org/dp/data-brain"],
    };
    const result = await new WorkArtifactReader().read(home, [first], rules);
    assert.equal(result.artifacts.length, 3);
    assert.deepEqual(
      result.artifacts
        .filter((artifact) => artifact.kind === "link")
        .map((artifact) => [artifact.url, artifact.label])
        .sort(),
      [
        [document, "消费端小批次提交方案"],
        [bare, bare],
      ].sort(),
    );
    assert.deepEqual(urls(result), [mr]);
    assert.deepEqual(result.unavailableThreadIds, []);
  }));

test("prefix additions and removals rebuild unchanged memory and disk caches and stable rules keep incremental hits", (context) =>
  fixture(async (home, path) => {
    const prefix = "https://bytedance.sg.larkoffice.com/docx";
    const document = `${prefix}/VTWBdRKXso20opxNAC2liEuDgpf`;
    const mr = "https://github.com/team/repo/pull/7";
    const configured = { urlPrefixes: [prefix] };
    await writeFile(path, final(`[交付文档](${document})\n${mr}`));
    const reader = new WorkArtifactReader();
    const initial = await reader.read(home, [first]);
    assert.deepEqual(urls(initial), [mr]);
    assert.equal(initial.artifacts.length, 1);
    const directory = join(home, "kanban", "artifact-cache");
    const [name] = await readdir(directory);
    const cachePath = join(directory, name);
    const legacy = JSON.parse(await readFile(cachePath, "utf8"));
    delete legacy.rulesKey;
    await writeFile(cachePath, JSON.stringify(legacy));

    const sample = await open(path, "r");
    const reads = context.mock.method(Object.getPrototypeOf(sample), "read");
    await sample.close();
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      initial,
    );
    assert.equal(
      reads.mock.callCount(),
      0,
      "legacy empty-rule caches remain usable",
    );

    const restored = await new WorkArtifactReader().read(
      home,
      [first],
      configured,
    );
    assert.equal(restored.artifacts.length, 2);
    assert.equal(
      reads.mock.callCount(),
      1,
      "new rules reparse the old persisted result",
    );
    const expanded = await reader.read(home, [first], configured);
    assert.deepEqual(expanded, restored);
    assert.equal(
      reads.mock.callCount(),
      2,
      "new rules also replace old memory state",
    );
    assert.deepEqual(await reader.read(home, [first], configured), expanded);
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first], configured),
      expanded,
    );
    assert.equal(
      reads.mock.callCount(),
      2,
      "unchanged rules do not reread log bodies",
    );
    assert.equal(
      (await readdir(directory)).length,
      1,
      "rule edits reuse cache paths",
    );

    assert.deepEqual(await reader.read(home, [first]), initial);
    assert.equal(
      reads.mock.callCount(),
      3,
      "removed prefixes remove prior custom links",
    );
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      initial,
    );
    assert.equal(reads.mock.callCount(), 3);
  }));

test("historical session and archived segments restore missing MRs without duplicates or unrelated sources", () =>
  fixture(async (home, path, cwd) => {
    const history = join(
      home,
      "sessions/2026/10/20",
      `rollout-2026-10-20T15-06-47-${first}_${second}.jsonl`,
    );
    const archived = join(
      home,
      "archived_sessions",
      `rollout-2026-10-19T15-06-47-${first}.jsonl`,
    );
    const unrelated = join(
      dirname(history),
      `rollout-2026-10-20T15-06-48-${first}_${third}.jsonl`,
    );
    await mkdir(dirname(history), { recursive: true });
    await mkdir(dirname(archived), { recursive: true });
    const mr = "https://code.byted.org/dp/data-brain/merge_requests/1570";
    const earlierMr =
      "https://code.byted.org/dp/data-brain/merge_requests/1560";
    const currentMr =
      "https://code.byted.org/dp/data-brain-frontend/merge_requests/574";
    await writeFile(path, final(currentMr, 20));
    await writeFile(
      history,
      entry({ id: first, cwd }, "session_meta") +
        entry(
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "https://github.com/team/repo/pull/99",
              },
            ],
          },
          "response_item",
        ) +
        entry(
          {
            type: "function_call_output",
            output: "https://github.com/team/repo/pull/98",
          },
          "response_item",
        ) +
        final(mr, 10),
    );
    await writeFile(
      archived,
      entry({ id: first, cwd }, "session_meta") +
        final(`${mr}\n${earlierMr}`, 1),
    );
    // 文件名包含父对话 ID 也不能代替 session_meta 的归属校验。
    await writeFile(
      unrelated,
      entry({ id: second, cwd }, "session_meta") +
        final("https://github.com/team/repo/pull/97", 15),
    );
    const reader = new WorkArtifactReader();
    const expected = [mr, earlierMr, currentMr].sort();
    const result = await reader.read(home, [first]);
    assert.deepEqual(urls(result), expected);
    assert.equal(result.artifacts.length, 3);
    assert.ok(
      result.artifacts.every((artifact) => artifact.threadId === first),
    );
    assert.deepEqual(result.unavailableThreadIds, []);
    await appendFile(path, final(mr, 21));
    assert.deepEqual(urls(await reader.read(home, [first])), expected);
  }));

test("changing requested threads reuses the directory index, lazy ownership checks and other threads' memory caches", (context) =>
  fixture(async (home, path, cwd) => {
    const otherPath = join(home, "second.jsonl");
    const directory = join(home, "sessions/2026/10/20");
    const history = (id: string) =>
      join(directory, `rollout-2026-10-20T15-06-47-${id}.jsonl`);
    await mkdir(directory, { recursive: true });
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database
      .prepare("INSERT INTO threads VALUES (?, ?, ?, ?)")
      .run(second, cwd, otherPath, 0);
    database.close();
    await Promise.all([
      writeFile(path, final("https://github.com/team/repo/pull/1")),
      writeFile(otherPath, final("https://github.com/team/repo/pull/2")),
      writeFile(
        history(first),
        entry({ id: first, cwd }, "session_meta") +
          final("https://github.com/team/repo/pull/3"),
      ),
      writeFile(
        history(second),
        entry({ id: second, cwd }, "session_meta") +
          final("https://github.com/team/repo/pull/4"),
      ),
    ]);
    const sample = await open(path, "r");
    const prototype = Object.getPrototypeOf(sample);
    await sample.close();
    const directories = context.mock.method(fs, "readdir");
    syncBuiltinESMExports();
    context.after(() => {
      directories.mock.restore();
      syncBuiltinESMExports();
    });
    const ownership = context.mock.method(prototype, "readLines");
    const reads = context.mock.method(prototype, "read");
    const reader = new WorkArtifactReader();
    const initial = await reader.read(home, [first]);
    assert.deepEqual(urls(initial), [
      "https://github.com/team/repo/pull/1",
      "https://github.com/team/repo/pull/3",
    ]);
    assert.equal(directories.mock.callCount(), 2);
    assert.equal(
      ownership.mock.callCount(),
      1,
      "unselected histories stay unopened",
    );

    // 删除磁盘缓存后切换选集，仍应保留第一条对话的内存增量状态。
    await rm(join(home, "kanban/artifact-cache"), { recursive: true });
    assert.deepEqual(urls(await reader.read(home, [second])), [
      "https://github.com/team/repo/pull/2",
      "https://github.com/team/repo/pull/4",
    ]);
    assert.equal(directories.mock.callCount(), 2);
    assert.equal(ownership.mock.callCount(), 2);
    const contentReads = reads.mock.callCount();
    assert.deepEqual(await reader.read(home, [first]), initial);
    assert.equal(directories.mock.callCount(), 2);
    assert.equal(ownership.mock.callCount(), 2);
    assert.equal(reads.mock.callCount(), contentReads);
  }));

test("historical filename indexes refresh after thirty seconds or a known rollout change", (context) =>
  fixture(async (home, path, cwd) => {
    let clock = Date.now();
    context.mock.method(Date, "now", () => clock);
    const directory = join(home, "sessions/2026/10/20");
    const history = (seconds: number) =>
      join(directory, `rollout-2026-10-20T15-06-${seconds}-${first}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, final("https://github.com/team/repo/pull/1"));
    const reader = new WorkArtifactReader();
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/1",
    ]);
    await writeFile(
      history(47),
      entry({ id: first, cwd }, "session_meta") +
        final("https://github.com/team/repo/pull/2"),
    );
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/1",
    ]);
    clock += 30001;
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/1",
      "https://github.com/team/repo/pull/2",
    ]);

    const nextPath = join(home, "next.jsonl");
    await Promise.all([
      writeFile(nextPath, final("https://github.com/team/repo/pull/3")),
      writeFile(
        history(48),
        entry({ id: first, cwd }, "session_meta") +
          final("https://github.com/team/repo/pull/4"),
      ),
    ]);
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database
      .prepare("UPDATE threads SET rollout_path=? WHERE id=?")
      .run(nextPath, first);
    database.close();
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/2",
      "https://github.com/team/repo/pull/3",
      "https://github.com/team/repo/pull/4",
    ]);
  }));

test("same-titled native plans across historical segments retain the newest content and stable export", () =>
  fixture(async (home, path, cwd) => {
    const history = join(
      home,
      "sessions/2026/10/20",
      `rollout-2026-10-20T15-06-47-${first}.jsonl`,
    );
    const archived = join(
      home,
      "archived_sessions",
      `rollout-2026-10-19T15-06-47-${first}_${second}.jsonl`,
    );
    await mkdir(dirname(history), { recursive: true });
    await mkdir(dirname(archived), { recursive: true });
    const title = "消费端小批次提交方案";
    const latest = `# ${title}\n\n最新版本保留全部原始事件。`;
    await writeFile(path, final(proposed(latest), 20));
    await writeFile(
      history,
      entry({ id: first, cwd }, "session_meta") +
        final(proposed(`# ${title}\n\n历史版本。`), 10),
    );
    await writeFile(
      archived,
      entry({ id: first, cwd }, "session_meta") +
        final(proposed(`# ${title}\n\n归档初稿。`), 1),
    );
    const reader = new WorkArtifactReader();
    const result = await reader.read(home, [first]);
    assert.equal(result.artifacts.length, 1);
    const plan = result.artifacts[0];
    assert.ok(plan.kind === "planFile");
    assert.equal(plan.label, title);
    assert.equal(plan.detectedAt, timestamp(20));
    assert.equal(await readFile(plan.path, "utf8"), `${latest}\n`);
    assert.deepEqual(await reader.read(home, [first]), result);
    assert.equal(await readFile(plan.path, "utf8"), `${latest}\n`);
    const revised = `# ${title}\n\n历史分段追加了更新的最终版本。`;
    await appendFile(history, final(proposed(revised), 30));
    const updated = await reader.read(home, [first]);
    assert.deepEqual(updated.artifacts, [
      { ...plan, detectedAt: timestamp(30) },
    ]);
    assert.equal(await readFile(plan.path, "utf8"), `${revised}\n`);
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      updated,
    );
  }));

test("legacy messages wait for completion, completion text wins, unfinished and aborted candidates are excluded", () =>
  fixture(async (home, path) => {
    await writeFile(
      path,
      entry({ type: "task_started", turn_id: "one" }) +
        assistant("https://github.com/team/repo/pull/1") +
        entry(
          {
            type: "task_complete",
            turn_id: "one",
            last_agent_message: "完成：https://github.com/team/repo/pull/2",
          },
          "event_msg",
          1,
        ) +
        entry({ type: "task_started", turn_id: "two" }, "event_msg", 2) +
        assistant("https://github.com/team/repo/pull/3", {}, 3) +
        entry(
          {
            type: "agent_message",
            message: "https://github.com/team/repo/pull/4",
          },
          "event_msg",
          4,
        ) +
        entry({ type: "task_complete", turn_id: "two" }, "event_msg", 5) +
        entry({ type: "task_started", turn_id: "three" }, "event_msg", 6) +
        assistant("https://github.com/team/repo/pull/5", {}, 7),
    );
    const reader = new WorkArtifactReader();
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/2",
      "https://github.com/team/repo/pull/4",
    ]);
    await appendFile(
      path,
      entry({ type: "task_started", turn_id: "four" }, "event_msg", 8) +
        assistant("https://github.com/team/repo/pull/6", {}, 9) +
        entry({ type: "turn_aborted", turn_id: "four" }, "event_msg", 10) +
        entry({ type: "task_complete", turn_id: "four" }, "event_msg", 11) +
        assistant(
          "https://github.com/team/repo/pull/7",
          { channel: "final" },
          12,
        ) +
        entry(
          {
            type: "agent_message",
            phase: "final_answer",
            message: "https://github.com/team/repo/pull/8",
          },
          "event_msg",
          13,
        ) +
        entry(
          {
            type: "agent_message",
            channel: "commentary",
            message: "https://github.com/team/repo/pull/9",
          },
          "event_msg",
          14,
        ),
    );
    assert.deepEqual(
      urls(await reader.read(home, [first])),
      [2, 4, 7, 8].map(
        (number) => `https://github.com/team/repo/pull/${number}`,
      ),
    );
  }));

test("explicit final answers discard earlier unmarked progress candidates before completion", () =>
  fixture(async (home, path) => {
    await writeFile(
      path,
      entry({ type: "task_started", turn_id: "one" }) +
        assistant(
          "检查参考 MR：https://git.example/team/repo/merge_requests/50",
        ) +
        final("工作已完成，本轮没有创建合并请求。", 1) +
        entry({ type: "task_complete", turn_id: "one" }, "event_msg", 2) +
        entry({ type: "task_started", turn_id: "two" }, "event_msg", 3) +
        entry(
          {
            type: "agent_message",
            message: "参考：https://github.com/team/repo/pull/60",
          },
          "event_msg",
          4,
        ) +
        assistant(
          "最终成果：https://github.com/team/repo/pull/61",
          { channel: "final" },
          5,
        ) +
        entry({ type: "task_complete", turn_id: "two" }, "event_msg", 6),
    );
    assert.deepEqual(urls(await new WorkArtifactReader().read(home, [first])), [
      "https://github.com/team/repo/pull/61",
    ]);
  }));

test("plan files resolve conversation cwd, labels, spaces and line numbers, and require existing regular documents", () =>
  fixture(async (home, path, cwd) => {
    const docs = join(cwd, "docs");
    const changedCwd = join(home, "changed cwd");
    const turnCwd = join(home, "turn cwd");
    await Promise.all([mkdir(docs), mkdir(changedCwd), mkdir(turnCwd)]);
    const named = join(docs, "方案 初稿.md");
    const labelled = join(docs, "notes.md");
    const fallback = join(cwd, "plan.md");
    const sessionFile = join(changedCwd, "design.pdf");
    const turnFile = join(turnCwd, "proposal.docx");
    await Promise.all(
      [
        named,
        labelled,
        fallback,
        sessionFile,
        turnFile,
        join(cwd, "plan.ts"),
        join(docs, "notes.txt"),
      ].map((file) => writeFile(file, "PRIVATE_DOCUMENT_BODY")),
    );
    await mkdir(join(docs, "directory-plan.md"));
    await writeFile(
      path,
      final(
        [
          "[方案初稿](<docs/方案 初稿.md:17>)",
          "[技术设计](docs/notes.md:9:2)",
          "`plan.md:10`",
          `[方案地址](${pathToFileURL(named).href})`,
          "[重复方案](docs/%E6%96%B9%E6%A1%88%20%E5%88%9D%E7%A8%BF.md#section)",
          "`docs/missing-plan.md` `docs/directory-plan.md` `plan.ts` `docs/notes.txt`",
          "```sh\ncat docs/hidden-plan.md\n```",
        ].join("\n"),
      ) +
        entry({ cwd: changedCwd }, "session_meta", 1) +
        final("`design.pdf`", 2) +
        entry({ cwd: turnCwd }, "turn_context", 3) +
        final("[实施方案](proposal.docx)", 4),
    );
    const result = await new WorkArtifactReader().read(home, [first]);
    assert.deepEqual(
      paths(result),
      [named, labelled, fallback, sessionFile, turnFile].sort(),
    );
    assert.equal(result.artifacts.length, 5);
    assert.equal(
      JSON.stringify(result).includes("PRIVATE_DOCUMENT_BODY"),
      false,
    );
    assert.deepEqual(result.unavailableThreadIds, []);
  }));

test("plan discovery ignores skill rules and unrelated files under design-named ancestors", () =>
  fixture(async (home, path, cwd) => {
    const references = [
      [join(cwd, "design-platform", "java-coding-rules.md"), "编码规则"],
      [join(cwd, "design-platform", "00-workflows.md"), "工作流程"],
      [join(cwd, "design-platform", "interaction-and-review.md"), "评审规范"],
      [join(cwd, "design-platform", "references", "notes.md"), "参考资料"],
      [join(cwd, "plans", "SKILL.md"), "设计方案"],
      [join(cwd, "docs", "AGENTS.md"), "实施计划"],
      [
        join(
          home,
          ".codex",
          "skills",
          "design",
          "references",
          "java-coding-rules.md",
        ),
        "设计方案",
      ],
      [
        join(home, ".agents", "skills", "review", "plans", "00-workflows.md"),
        "计划文档",
      ],
      [
        join(cwd, ".codex", "skills", "new-skill", "docs", "design.md"),
        "技术设计",
      ],
    ];
    const plans = [
      [join(cwd, "docs", "plan.md"), "实施计划"],
      [join(cwd, "docs", "design.md"), "技术设计"],
      [join(cwd, "plans", "2026-10-26.md"), "本轮交付"],
      [join(cwd, "设计", "release.md"), "发布文档"],
      [join(cwd, "docs", "上线方案.md"), "发布文档"],
      [join(cwd, "docs", "output.md"), "设计方案"],
    ];
    await Promise.all(
      [...references, ...plans].map(async ([file]) => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "PRIVATE_DOCUMENT_BODY");
      }),
    );
    await writeFile(
      path,
      final(
        [...references, ...plans]
          .map(([file, label]) => `[${label}](<${file}>)`)
          .concat("[实施方案](../.agents/skills/review/plans/00-workflows.md)")
          .join("\n"),
      ),
    );
    const result = await new WorkArtifactReader().read(home, [first]);
    assert.deepEqual(paths(result), plans.map(([file]) => file).sort());
    assert.deepEqual(result.unavailableThreadIds, []);
  }));

test("native final plans export their original content and retain only the latest version of each title", () =>
  fixture(async (home, path) => {
    const title = "消费端小批次提交方案";
    const firstContent = `# ${title}\n\n第一版：逐条提交。`;
    const latestContent = [
      `# ${title}`,
      "",
      "第三版：小批次提交，并保留原始示例。",
      "",
      "```ts",
      "const batch = [1, 2];",
      "  await commit(batch);",
      "```",
      "",
      "失败时保留未提交批次。",
    ].join("\n");
    await writeFile(path, final(proposed(firstContent), 1));
    const reader = new WorkArtifactReader();
    const initial = await reader.read(home, [first]);
    assert.equal(initial.artifacts.length, 1);
    const original = initial.artifacts[0];
    assert.ok(original.kind === "planFile");
    assert.equal(original.label, title);
    assert.equal(dirname(original.path), join(home, "kanban", "plans"));
    assert.ok(original.path.endsWith(".md"));
    assert.equal((await readFile(original.path, "utf8")).trim(), firstContent);

    await appendFile(
      path,
      final(proposed(`# ${title}\n\n第二版：按批次提交。`), 2) +
        final(proposed(latestContent), 3),
    );
    const latest = await reader.read(home, [first]);
    assert.equal(latest.artifacts.length, 1);
    assert.deepEqual(latest.artifacts[0], {
      ...original,
      detectedAt: timestamp(3),
    });
    assert.equal((await readFile(original.path, "utf8")).trim(), latestContent);
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      latest,
    );
  }));

test("native plans keep same-titled conversations separate and ignore nonfinal, example and incomplete blocks", () =>
  fixture(async (home, path, cwd) => {
    const title = "消费端小批次提交方案";
    const otherPath = join(home, "second.jsonl");
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    database
      .prepare("INSERT INTO threads VALUES (?, ?, ?, ?)")
      .run(second, cwd, otherPath, 0);
    database.close();
    await writeFile(
      path,
      entry(
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: proposed("# 用户方案\n正文") }],
        },
        "response_item",
      ) +
        assistant(proposed("# 进度方案\n正文"), { channel: "commentary" }) +
        final("```markdown\n" + proposed("# 示例方案\n正文") + "\n```", 1) +
        final("<proposed_plan>\n# 未闭合方案\n正文", 2) +
        final(proposed(`# ${title}\n\n第一个对话的方案。`), 3),
    );
    await writeFile(
      otherPath,
      final(proposed(`# ${title}\n\n第二个对话的方案。`), 4),
    );
    const result = await new WorkArtifactReader().read(home, [first, second]);
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.label),
      [title, title],
    );
    assert.deepEqual(
      new Set(result.artifacts.map((artifact) => artifact.threadId)),
      new Set([first, second]),
    );
    assert.equal(new Set(paths(result)).size, 2);
    assert.equal(
      new Set(result.artifacts.map((artifact) => artifact.id)).size,
      2,
    );
    assert.deepEqual(result.unavailableThreadIds, []);
  }));

test("unchanged native plans keep export timestamps and rebuild deleted derived files", () =>
  fixture(async (home, path) => {
    const content = "# 消费端小批次提交方案\n\n按批次提交。";
    await writeFile(path, final(proposed(content), 1));
    const reader = new WorkArtifactReader();
    const initial = await reader.read(home, [first]);
    assert.equal(initial.artifacts.length, 1);
    const artifact = initial.artifacts[0];
    assert.ok(artifact.kind === "planFile");
    const unchangedAt = new Date("2020-01-01T00:00:00Z");
    await utimes(artifact.path, unchangedAt, unchangedAt);
    assert.deepEqual(await reader.read(home, [first]), initial);
    assert.equal((await stat(artifact.path)).mtimeMs, unchangedAt.getTime());

    await unlink(artifact.path);
    assert.deepEqual(await reader.read(home, [first]), initial);
    assert.equal((await readFile(artifact.path, "utf8")).trim(), content);
  }));

test("unchanged logs recheck file existence without reading document bodies or rereading logs", (context) =>
  fixture(async (home, path, cwd) => {
    const plan = join(cwd, "implementation-plan.md");
    await writeFile(path, final("`implementation-plan.md`"));
    const reader = new WorkArtifactReader();
    assert.deepEqual(paths(await reader.read(home, [first])), []);
    const sample = await open(path, "r");
    const reads = context.mock.method(Object.getPrototypeOf(sample), "read");
    await sample.close();
    await writeFile(plan, "PRIVATE_PLAN_BODY");
    const result = await reader.read(home, [first]);
    assert.deepEqual(paths(result), [plan]);
    assert.equal(reads.mock.callCount(), 0);
    await unlink(plan);
    assert.deepEqual(paths(await reader.read(home, [first])), []);
    assert.equal(reads.mock.callCount(), 0);
  }));

test("incremental scans keep incomplete tails, share concurrent reads, and reset after overwrites, truncation and replacement", (context) =>
  fixture(async (home, path) => {
    const reader = new WorkArtifactReader();
    await writeFile(
      path,
      entry({
        type: "agent_message",
        channel: "commentary",
        message: "PRIVATE中🙂".repeat(25000),
      }) + final("https://github.com/team/repo/pull/1"),
    );
    const initial = await reader.read(home, [first]);
    assert.deepEqual(urls(initial), ["https://github.com/team/repo/pull/1"]);
    assert.equal(JSON.stringify(initial).includes("PRIVATE"), false);
    const addition = final("https://github.com/team/repo/pull/2", 1);
    await appendFile(path, addition.slice(0, -9));
    assert.deepEqual(urls(await reader.read(home, [first])), urls(initial));
    await appendFile(path, addition.slice(-9));
    const sample = await open(path, "r");
    const reads = context.mock.method(Object.getPrototypeOf(sample), "read");
    await sample.close();
    const concurrent = await Promise.all([
      reader.read(home, [first]),
      reader.read(home, [first]),
    ]);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.deepEqual(urls(concurrent[0]), [
      "https://github.com/team/repo/pull/1",
      "https://github.com/team/repo/pull/2",
    ]);
    assert.equal(reads.mock.callCount(), 1);
    await reader.read(home, [first]);
    assert.equal(
      reads.mock.callCount(),
      1,
      "unchanged logs need no content reads",
    );
    await writeFile(path, final("https://github.com/team/repo/pull/3", 2));
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/3",
    ]);
    await writeFile(path, final("https://github.com/team/repo/pull/4", 2));
    await utimes(path, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/4",
    ]);
    await writeFile(
      path + ".replacement",
      final("https://github.com/team/repo/pull/5", 2),
    );
    await rename(path + ".replacement", path);
    assert.deepEqual(urls(await reader.read(home, [first])), [
      "https://github.com/team/repo/pull/5",
    ]);
  }));

test("disk caches survive reader restarts, omit unrelated bodies, and resume from the appended offset", (context) =>
  fixture(async (home, path) => {
    const mr = "https://github.com/team/repo/pull/1";
    const native = "# 缓存方案\n\nNATIVE_PLAN_BODY";
    const initialLog =
      entry(
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "PRIVATE_USER_BODY" }],
        },
        "response_item",
      ) +
      entry(
        { type: "function_call_output", output: "PRIVATE_TOOL_BODY" },
        "response_item",
      ) +
      assistant("PRIVATE_ASSISTANT_BODY", { channel: "commentary" }) +
      final(`${mr}\n${proposed(native)}`, 1);
    await writeFile(path, initialLog);
    const initial = await new WorkArtifactReader().read(home, [first]);
    const directory = join(home, "kanban", "artifact-cache");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    const saved = await readFile(join(directory, files[0]), "utf8");
    assert.equal(JSON.parse(saved).schemaVersion, 1);
    assert.equal(saved.includes("PRIVATE_"), false);
    assert.equal(saved.includes("NATIVE_PLAN_BODY"), true);

    const sample = await open(path, "r");
    const reads = context.mock.method(Object.getPrototypeOf(sample), "read");
    await sample.close();
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      initial,
    );
    assert.equal(
      reads.mock.callCount(),
      0,
      "disk hits do not reread the log body",
    );

    const appended = final("https://github.com/team/repo/pull/2", 2);
    await appendFile(path, appended);
    const updated = await new WorkArtifactReader().read(home, [first]);
    assert.deepEqual(urls(updated), [
      mr,
      "https://github.com/team/repo/pull/2",
    ]);
    assert.equal(reads.mock.callCount(), 1);
    assert.equal(
      reads.mock.calls[0].arguments[3],
      Buffer.byteLength(initialLog),
    );
    assert.equal(reads.mock.calls[0].arguments[2], Buffer.byteLength(appended));
  }));

test("disk caches preserve pending legacy results and incomplete-line offsets across restarts", () =>
  fixture(async (home, path) => {
    const mr = "https://github.com/team/repo/pull/7";
    const completion = entry(
      { type: "task_complete", turn_id: "legacy" },
      "event_msg",
      2,
    );
    const split = completion.length - 8;
    await writeFile(
      path,
      entry({ type: "task_started", turn_id: "legacy" }) +
        assistant(mr, {}, 1) +
        completion.slice(0, split),
    );
    assert.deepEqual(
      urls(await new WorkArtifactReader().read(home, [first])),
      [],
    );
    assert.deepEqual(
      urls(await new WorkArtifactReader().read(home, [first])),
      [],
    );
    await appendFile(path, completion.slice(split));
    const completed = await new WorkArtifactReader().read(home, [first]);
    assert.deepEqual(urls(completed), [mr]);
    assert.deepEqual(completed.unavailableThreadIds, []);
    assert.deepEqual(
      await new WorkArtifactReader().read(home, [first]),
      completed,
    );
  }));

test("disk caches rebuild after source rewrites and invalid persisted data", () =>
  fixture(async (home, path) => {
    const read = () => new WorkArtifactReader().read(home, [first]);
    await writeFile(
      path,
      assistant("LONG_IGNORED_BODY".repeat(200), { channel: "commentary" }) +
        final("https://github.com/team/repo/pull/1"),
    );
    assert.deepEqual(urls(await read()), [
      "https://github.com/team/repo/pull/1",
    ]);
    await writeFile(path, final("https://github.com/team/repo/pull/2"));
    assert.deepEqual(urls(await read()), [
      "https://github.com/team/repo/pull/2",
    ]);
    await writeFile(path, final("https://github.com/team/repo/pull/3"));
    await utimes(path, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(urls(await read()), [
      "https://github.com/team/repo/pull/3",
    ]);
    await writeFile(
      path + ".replacement",
      final("https://github.com/team/repo/pull/4"),
    );
    await rename(path + ".replacement", path);
    const expected = await read();
    assert.deepEqual(urls(expected), ["https://github.com/team/repo/pull/4"]);

    const directory = join(home, "kanban", "artifact-cache");
    const [name] = await readdir(directory);
    const cachePath = join(directory, name);
    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    for (const invalid of [
      "{ unfinished",
      JSON.stringify({ ...saved, schemaVersion: 0 }),
      JSON.stringify({
        ...saved,
        state: { ...saved.state, artifacts: [["invalid", {}]] },
      }),
    ]) {
      await writeFile(cachePath, invalid);
      const rebuilt = await read();
      assert.deepEqual(rebuilt, expected);
      assert.equal(
        JSON.parse(await readFile(cachePath, "utf8")).schemaVersion,
        1,
      );
    }
  }));

test("an unavailable disk-cache directory does not hide discovered artifacts", () =>
  fixture(async (home, path) => {
    const mr = "https://github.com/team/repo/pull/8";
    await writeFile(path, final(mr));
    await mkdir(join(home, "kanban"));
    const blocked = join(home, "kanban", "artifact-cache");
    await writeFile(blocked, "CACHE_DIRECTORY_IS_A_FILE");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await new WorkArtifactReader().read(home, [first]);
      assert.deepEqual(urls(result), [mr]);
      assert.deepEqual(result.unavailableThreadIds, []);
    }
    assert.equal(await readFile(blocked, "utf8"), "CACHE_DIRECTORY_IS_A_FILE");
  }));

test("only selected threads are scanned, archived sources work, and missing sources are reported separately", () =>
  fixture(async (home, path, cwd) => {
    const archived = join(home, "archived.jsonl");
    await writeFile(path, final("https://github.com/team/repo/pull/1"));
    await writeFile(
      archived,
      final("https://git.example/team/repo/merge_requests/2", 1),
    );
    const database = new DatabaseSync(join(home, "state_5.sqlite"));
    const add = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
    add.run(second, cwd, archived, 1);
    add.run(third, cwd, join(home, "missing.jsonl"), 0);
    add.run("no-path", cwd, null, 0);
    add.run("unselected", cwd, join(home, "unselected-missing.jsonl"), 0);
    database.close();
    const reader = new WorkArtifactReader();
    const selected = await reader.read(home, [second]);
    assert.deepEqual(urls(selected), [
      "https://git.example/team/repo/merge_requests/2",
    ]);
    assert.deepEqual(selected.unavailableThreadIds, []);
    const mixed = await reader.read(home, [
      first,
      second,
      third,
      "unknown",
      "no-path",
      third,
    ]);
    assert.equal(mixed.artifacts.length, 2);
    assert.deepEqual(mixed.unavailableThreadIds, [third, "unknown", "no-path"]);
    await unlink(path);
    const missing = await reader.read(home, [first]);
    assert.deepEqual(missing.artifacts, []);
    assert.deepEqual(missing.unavailableThreadIds, [first]);
    const unavailableHome = join(home, "missing-home");
    assert.deepEqual(await reader.read(unavailableHome, []), {
      artifacts: [],
      unavailableThreadIds: [],
    });
    assert.deepEqual(
      await reader.read(unavailableHome, [first, first, second]),
      { artifacts: [], unavailableThreadIds: [first, second] },
    );
  }));
