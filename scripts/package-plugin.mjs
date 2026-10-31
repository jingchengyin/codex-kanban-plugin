import { mkdir, cp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "tsup";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const catalog = JSON.parse(
  await readFile(resolve(root, ".agents/plugins/marketplace.json"), "utf8"),
);
const plugin = resolve(root, "plugins", pkg.name);
await rm(plugin, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
for (const path of [
  ".codex-plugin",
  "assets",
  "README.md",
  "README.zh.md",
  "LICENSE",
]) {
  await cp(resolve(root, path), resolve(plugin, path), { recursive: true });
}

// Bundle dependencies before distribution: plugin installation never runs npm.
await build({
  config: false,
  entry: { index: resolve(root, "server/index.ts") },
  outDir: resolve(plugin, "runtime/server"),
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  removeNodeProtocol: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await cp(resolve(root, "dist/ui"), resolve(plugin, "runtime/ui"), {
  recursive: true,
});
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
// Keep the MCP identity stable for existing board views and preferences.
mcp.mcpServers["codex-taskboard"].args = ["./scripts/start-mcp.sh"];
mcp.mcpServers["codex-taskboard"].cwd = ".";
// 同版本本地重装也要刷新 MCP 进程，避免新页面继续调用旧服务。
mcp.mcpServers["codex-taskboard"].env = {
  ...mcp.mcpServers["codex-taskboard"].env,
  TASKBOARD_BUILD_ID: createHash("sha256")
    .update(await readFile(resolve(plugin, "runtime/server/index.mjs")))
    .update(await readFile(resolve(plugin, "runtime/ui/index.html")))
    .digest("hex"),
};
await writeFile(
  resolve(plugin, ".mcp.json"),
  JSON.stringify(mcp, null, 2) + "\n",
);
await writeFile(
  resolve(plugin, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      engines: pkg.engines,
      scripts: {
        start: "sh scripts/start-mcp.sh",
        "codex-kanban-plugin": pkg.scripts["codex-kanban-plugin"],
        live: pkg.scripts.live,
      },
    },
    null,
    2,
  ) + "\n",
);
await mkdir(resolve(plugin, "scripts"), { recursive: true });
for (const path of [
  "Codex Kanban.command",
  "start-live.mjs",
  "kanban-launcher.mjs",
  "start-mcp.sh",
  "start-desktop-cli.sh",
  "desktop-cli.mjs",
  "approval-relay.mjs",
]) {
  await cp(resolve(root, "scripts", path), resolve(plugin, "scripts", path));
}

// Preserve license texts when shipping bundled code without node_modules.
const lock = JSON.parse(
  await readFile(resolve(root, "package-lock.json"), "utf8"),
);
const licenses = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || metadata.dev) continue;
  let source = resolve(root, path);
  let files = (await readdir(source, { withFileTypes: true }))
    .filter(
      (file) =>
        file.isFile() &&
        /^(licen[cs]e|notice|copying|ofl)([._-]|$)/i.test(file.name),
    )
    .map((file) => file.name)
    .sort();
  const destination = path.replaceAll("node_modules/", "");
  if (!files.length) {
    source = resolve(root, "licenses", destination);
    files = (await readdir(source)).sort();
  }
  await mkdir(resolve(plugin, "licenses", destination), { recursive: true });
  for (const file of files) {
    await cp(
      resolve(source, file),
      resolve(plugin, "licenses", destination, file),
    );
  }
  licenses.push({
    package: destination,
    version: metadata.version,
    license: metadata.license,
    files,
  });
}
await mkdir(resolve(plugin, "licenses/affectui"), { recursive: true });
await cp(
  resolve(root, "ui/vendor/affectui/LICENSE"),
  resolve(plugin, "licenses/affectui/LICENSE"),
);
await writeFile(
  resolve(plugin, "licenses/index.json"),
  JSON.stringify(licenses, null, 2) + "\n",
);

// Retain the existing offline marketplace and ZIP installation options.
const marketplace = resolve(root, "releases/marketplace");
const localPlugin = resolve(marketplace, "plugins", pkg.name);
await rm(localPlugin, { recursive: true, force: true });
await cp(plugin, localPlugin, { recursive: true });
await mkdir(resolve(marketplace, ".agents/plugins"), { recursive: true });
await writeFile(
  resolve(marketplace, ".agents/plugins/marketplace.json"),
  JSON.stringify(
    {
      ...catalog,
      name: "codex-taskboard-local",
      interface: { displayName: "本地对话看板" },
      // 离线市场使用随包附带的目录，在线市场才从 Git 下载插件。
      plugins: catalog.plugins.map((entry) =>
        entry.name === pkg.name
          ? {
              ...entry,
              source: { source: "local", path: `./plugins/${pkg.name}` },
            }
          : entry,
      ),
    },
    null,
    2,
  ) + "\n",
);
const zip = resolve(root, `releases/${pkg.name}-${pkg.version}.zip`);
await rm(zip, { force: true });
execFileSync("/usr/bin/zip", ["-qr", zip, "."], { cwd: plugin });
console.log(
  `GitHub plugin: ${plugin}\nPlugin ZIP: ${zip}\nLocal marketplace: ${marketplace}`,
);
