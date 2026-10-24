import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const marketplace = resolve(root, "releases/marketplace");
const plugin = resolve(marketplace, "plugins/codex-taskboard");
await rm(plugin, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
for (const path of [
  ".codex-plugin",
  ".mcp.json",
  "assets",
  "dist",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  await cp(resolve(root, path), resolve(plugin, path), { recursive: true });
execFileSync(
  "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: plugin, stdio: "inherit" },
);
await rm(resolve(marketplace, ".codex-plugin"), {
  recursive: true,
  force: true,
});
await mkdir(resolve(marketplace, ".agents/plugins"), { recursive: true });
await writeFile(
  resolve(marketplace, ".agents/plugins/marketplace.json"),
  JSON.stringify(
    {
      name: "codex-taskboard-local",
      interface: { displayName: "本地对话看板" },
      plugins: [
        {
          name: "codex-taskboard",
          source: { source: "local", path: "./plugins/codex-taskboard" },
          category: "Developer Tools",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
const zip = resolve(root, `releases/codex-taskboard-${pkg.version}.zip`);
await mkdir(resolve(plugin, "scripts"), { recursive: true });
await cp(
  resolve(root, "scripts/start-live.mjs"),
  resolve(plugin, "scripts/start-live.mjs"),
);
await cp(
  resolve(root, "scripts/kanban-launcher.mjs"),
  resolve(plugin, "scripts/kanban-launcher.mjs"),
);
await rm(zip, { force: true });
execFileSync("/usr/bin/zip", ["-qr", zip, "."], { cwd: plugin });
console.log(`Plugin ZIP: ${zip}\nLocal marketplace: ${marketplace}`);
