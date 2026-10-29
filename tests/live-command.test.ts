import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 用隔离安装目录验证 Finder 启动入口，不启动真实 Codex。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "taskboard-command-"));
  const plugin = join(root, "installed plugin with spaces");
  const scripts = join(plugin, "scripts");
  const home = join(root, "home");
  await mkdir(scripts, { recursive: true });
  await mkdir(home);
  for (const file of ["Codex Kanban.command", "start-mcp.sh"])
    await copyFile(resolve("scripts", file), join(scripts, file));
  const entry = join(scripts, "start-live.mjs");
  await writeFile(
    entry,
    'console.log("FIXTURE_ENTRY:" + JSON.stringify({ entry: process.argv[1], home: process.env.CODEX_HOME, nodeSource: process.env.TASKBOARD_TEST_NODE_SOURCE }));\n',
  );
  return {
    root,
    scripts,
    entry,
    home,
    run(env: NodeJS.ProcessEnv = {}) {
      return spawnSync("/bin/sh", [join(scripts, "Codex Kanban.command")], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          ...env,
        },
        encoding: "utf8",
        timeout: 10000,
      });
    },
  };
}

test("double-click entry locates its own installation and preserves CODEX_HOME", async () => {
  const run = await fixture();
  try {
    const result = run.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /对话看板 · 实时连接/);
    const value = JSON.parse(result.stdout.match(/FIXTURE_ENTRY:(.+)/)![1]);
    assert.equal(value.entry, run.entry);
    assert.equal(value.home, run.home);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("double-click entry finds an NVM Node when Finder PATH has no Node", async () => {
  const run = await fixture();
  try {
    const bin = join(run.home, ".nvm/versions/node/v-test/bin");
    await mkdir(bin, { recursive: true });
    const node = join(bin, "node");
    const escapedNode = process.execPath.replaceAll("'", "'\\''");
    await writeFile(
      node,
      `#!/bin/sh\nexport TASKBOARD_TEST_NODE_SOURCE=nvm\nexec '${escapedNode}' "$@"\n`,
    );
    await chmod(node, 0o755);
    // 隔离 PATH，避免测试机器在 /usr/bin 中预装 Node 影响回退验证。
    const finderPath = join(run.root, "finder-bin");
    await mkdir(finderPath);
    await symlink("/usr/bin/dirname", join(finderPath, "dirname"));
    const result = run.run({ PATH: finderPath });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout.match(/FIXTURE_ENTRY:(.+)/)![1]);
    assert.equal(value.nodeSource, "nvm");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("double-click entry preserves a launcher failure and shows guidance", async () => {
  const run = await fixture();
  try {
    await writeFile(
      run.entry,
      'console.error("fixture launch failed"); process.exit(23);\n',
    );
    const result = run.run();
    assert.equal(result.status, 23);
    assert.match(result.stderr, /fixture launch failed/);
    assert.match(result.stdout, /启动未完成，请查看上方提示/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
