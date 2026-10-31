import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const compatibleNode = `#!/bin/sh
[ "$1" != '-e' ] || exit 0
printf 'started\\n'
printf '%s\\n' "$@"
`;
const incompatibleNode = "#!/bin/sh\nprintf 'old Node\\n'\nexit 1\n";

/** 隔离本机 Node 和网络，用真实压缩包与校验和验证首次启动流程。 */
async function bootstrapFixture(
  options: {
    machine?: string;
    invalidChecksum?: boolean;
    runtimeSource?: string;
  } = {},
) {
  const temp = await mkdtemp(join(tmpdir(), "taskboard-node-bootstrap-"));
  const plugin = join(temp, "plugin with spaces");
  const bin = join(temp, "bin");
  const home = join(temp, "user home");
  const codexHome = join(temp, "codex home");
  const downloads = join(temp, "downloads");
  const fixtures = join(temp, "fixtures");
  const machine = options.machine ?? "arm64";
  const arch = machine === "x86_64" ? "x64" : "arm64";
  const source = await readFile(resolve("scripts/start-mcp.sh"), "utf8");
  const version = source.match(
    /taskboard_node_version=["']?(\d+\.\d+\.\d+)/,
  )?.[1];
  assert.ok(version, "The bootstrap must pin its downloaded Node version.");
  const runtimeName = `node-v${version}-darwin-${arch}`;
  const archiveName = `${runtimeName}.tar.gz`;
  const archiveRoot = join(temp, "archive");
  const cache = join(codexHome, "kanban/runtime", runtimeName);
  await Promise.all([
    mkdir(join(plugin, "scripts"), { recursive: true }),
    mkdir(bin),
    mkdir(home),
    mkdir(fixtures),
    mkdir(join(archiveRoot, runtimeName, "bin"), { recursive: true }),
  ]);
  await writeFile(join(bin, "node"), incompatibleNode, { mode: 0o755 });
  await writeFile(
    join(archiveRoot, runtimeName, "bin/node"),
    options.runtimeSource ?? compatibleNode,
    { mode: 0o755 },
  );
  execFileSync("/usr/bin/tar", [
    "-czf",
    join(fixtures, archiveName),
    "-C",
    archiveRoot,
    runtimeName,
  ]);
  const checksum = options.invalidChecksum
    ? "0".repeat(64)
    : createHash("sha256")
        .update(await readFile(join(fixtures, archiveName)))
        .digest("hex");
  // 隔离开发机已有 Node，并用测试压缩包的校验和替换官方固定值。
  await writeFile(
    join(plugin, "scripts/start-mcp.sh"),
    source
      .replaceAll("/opt/homebrew", `${temp}/absent-homebrew`)
      .replaceAll("/usr/local", `${temp}/absent-local`)
      .replace(
        /taskboard_node_sha256=["']?[a-f0-9]{64}["']?/g,
        `taskboard_node_sha256='${checksum}'`,
      ),
  );
  await writeFile(
    join(bin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$BOOTSTRAP_SYSTEM" ;;
  -m) printf '%s\\n' "$BOOTSTRAP_MACHINE" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh
set -eu
destination=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) destination="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$BOOTSTRAP_DOWNLOADS"
if [ "\${BOOTSTRAP_DOWNLOAD_FAIL:-}" = 1 ]; then
  printf 'curl: download failed\\n' >&2
  exit 22
fi
cp "$BOOTSTRAP_FIXTURES/\${url##*/}" "$destination"
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    CODEX_HOME: codexHome,
    BOOTSTRAP_SYSTEM: "Darwin",
    BOOTSTRAP_MACHINE: machine,
    BOOTSTRAP_FIXTURES: fixtures,
    BOOTSTRAP_DOWNLOADS: downloads,
  };
  return {
    temp,
    plugin,
    bin,
    home,
    cache,
    version,
    run: (args: string[] = [], extraEnv: Record<string, string> = {}) =>
      spawnSync("/bin/sh", [join(plugin, "scripts/start-mcp.sh"), ...args], {
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 5000,
      }),
    downloadLog: async () => readFile(downloads, "utf8").catch(() => ""),
    cleanup: async () => rm(temp, { recursive: true, force: true }),
  };
}

test("compatible PATH Node starts immediately without downloading", async () => {
  const fixture = await bootstrapFixture();
  try {
    await writeFile(join(fixture.bin, "node"), compatibleNode, { mode: 0o755 });
    const result = fixture.run(["custom entry.mjs", "argument with spaces"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `started\n${fixture.plugin}/custom entry.mjs\nargument with spaces\n`,
    );
    assert.equal(await fixture.downloadLog(), "");
  } finally {
    await fixture.cleanup();
  }
});

test("old PATH Node falls back to an existing compatible NVM Node", async () => {
  const fixture = await bootstrapFixture();
  try {
    const nvmBin = join(fixture.home, ".nvm/versions/node/v22.13.0/bin");
    await mkdir(nvmBin, { recursive: true });
    await writeFile(join(nvmBin, "node"), compatibleNode, { mode: 0o755 });
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `started\n${fixture.plugin}/runtime/server/index.mjs\n`,
    );
    assert.equal(await fixture.downloadLog(), "");
  } finally {
    await fixture.cleanup();
  }
});

for (const machine of ["arm64", "x86_64"]) {
  test(`missing Node downloads and reuses a verified macOS ${machine} runtime`, async () => {
    const fixture = await bootstrapFixture({ machine });
    try {
      const args = ["entry with spaces.mjs", "--name", "hello world"];
      const result = fixture.run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `started\n${fixture.plugin}/entry with spaces.mjs\n--name\nhello world\n`,
      );
      await access(join(fixture.cache, "bin/node"));
      const log = await fixture.downloadLog();
      assert.equal(log.trim().split("\n").length, 1);
      assert.ok(log.includes(`https://nodejs.org/dist/v${fixture.version}/`));

      const cached = fixture.run(args, { BOOTSTRAP_DOWNLOAD_FAIL: "1" });
      assert.equal(cached.status, 0, cached.stderr);
      assert.equal(cached.stdout, result.stdout);
      assert.equal(await fixture.downloadLog(), log);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("checksum mismatch never executes or caches the downloaded runtime", async () => {
  const fixture = await bootstrapFixture({ invalidChecksum: true });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /checksum|SHA|verif|校验/i);
    await assert.rejects(access(join(fixture.cache, "bin/node")));
  } finally {
    await fixture.cleanup();
  }
});

test("failed download leaves no runtime and can be retried", async () => {
  const fixture = await bootstrapFixture();
  try {
    const failed = fixture.run([], { BOOTSTRAP_DOWNLOAD_FAIL: "1" });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /download|curl|下载/i);
    await assert.rejects(access(join(fixture.cache, "bin/node")));

    const retried = fixture.run();
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(
      retried.stdout,
      `started\n${fixture.plugin}/runtime/server/index.mjs\n`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a downloaded runtime must pass the Node capability probe before caching", async () => {
  const fixture = await bootstrapFixture({ runtimeSource: incompatibleNode });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /could not run|sqlite|WebSocket/i);
    await assert.rejects(access(join(fixture.cache, "bin/node")));
  } finally {
    await fixture.cleanup();
  }
});

test("an unusable cached runtime is downloaded again", async () => {
  const fixture = await bootstrapFixture();
  try {
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr);
    await writeFile(join(fixture.cache, "bin/node"), incompatibleNode);
    const repaired = fixture.run();
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(repaired.stdout, first.stdout);
    assert.equal((await fixture.downloadLog()).trim().split("\n").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

for (const [system, machine] of [
  ["Linux", "arm64"],
  ["Darwin", "ppc64"],
]) {
  test(`unsupported ${system}/${machine} fails before downloading`, async () => {
    const fixture = await bootstrapFixture();
    try {
      const result = fixture.run([], {
        BOOTSTRAP_SYSTEM: system,
        BOOTSTRAP_MACHINE: machine,
      });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /supports|macOS|Macs/i);
      assert.equal(await fixture.downloadLog(), "");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("unset CODEX_HOME caches Node under the user home directory", async () => {
  const fixture = await bootstrapFixture();
  try {
    const result = fixture.run([], { CODEX_HOME: "" });
    assert.equal(result.status, 0, result.stderr);
    await access(
      join(
        fixture.home,
        ".codex/kanban/runtime",
        basename(fixture.cache),
        "bin/node",
      ),
    );
    await assert.rejects(access(join(fixture.cache, "bin/node")));
  } finally {
    await fixture.cleanup();
  }
});
