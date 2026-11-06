import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { boardThreadId } from "../shared/thread-location.js";
import type { RemoteHostSource, Thread } from "../shared/types.js";
import { displayTitle } from "./local-data.js";

const execute = promisify(execFile);
const sshTarget = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-") && !/[\r\n\0]/.test(value));
const connectionSchema = z
  .object({
    hostId: z.string().regex(/^remote-ssh(?:-discovered)?:.+$/),
    displayName: z.string().optional(),
    source: z.string(),
    alias: sshTarget.nullish(),
    hostname: sshTarget.nullish(),
    sshPort: z.number().int().min(1).max(65535).nullish(),
    identity: z.string().min(1).nullish(),
  })
  .refine(
    (value) => value.alias || value.hostname,
    "SSH connection has no destination",
  );
const stateSchema = z.object({
  "codex-managed-remote-connections": z.array(z.unknown()).default([]),
  "remote-projects": z
    .array(
      z.object({
        hostId: z.string(),
        label: z.string(),
        remotePath: z.string(),
      }),
    )
    .default([]),
});
const rowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  updated_at: z.number(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
});

// Only index metadata is returned. SQLite's URI mode prevents creating or writing a database.
const remoteQuery = `import os, pathlib, sqlite3, json
home = pathlib.Path(os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex")))
db = sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
fields = ["id", "title", "name", "cwd", "updated_at", "model", "reasoning_effort"]
projection = ", ".join(field if field in columns else "NULL AS " + field for field in fields)
kind = "thread_source" if "thread_source" in columns else "NULL"
role = "agent_role" if "agent_role" in columns else "NULL"
sql = "SELECT " + projection + " FROM threads WHERE archived=0 AND (" + kind + "='user' OR source='vscode') AND coalesce(" + role + ", '')='' AND source NOT LIKE '%subagent%' AND coalesce(" + kind + ", '') NOT IN ('agent','subagent','guardian_review') ORDER BY updated_at DESC LIMIT 500"
print(json.dumps([dict(row) for row in db.execute(sql)]))
db.close()
`;
const command = `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(remoteQuery).toString("base64")}"))'`;

type RemoteData = { threads: Thread[]; hosts: RemoteHostSource[] };

/** Discover SSH hosts configured in Codex; reuse their SSH aliases and desktop status streams. */
export class RemoteDataReader {
  private cached: RemoteData = { threads: [], hosts: [] };
  private checkedAt = 0;
  private pending?: Promise<RemoteData>;
  constructor(private readonly home: string) {}

  read(): Promise<RemoteData> {
    if (this.pending) return this.pending;
    if (Date.now() - this.checkedAt < 10000)
      return Promise.resolve(this.cached);
    this.pending = this.refresh()
      .then((data) => {
        this.cached = data;
        this.checkedAt = Date.now();
        return data;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async refresh(): Promise<RemoteData> {
    let content: string;
    try {
      content = await readFile(
        join(this.home, ".codex-global-state.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { threads: [], hosts: [] };
      throw error;
    }
    const state = stateSchema.parse(JSON.parse(content));
    const connections = state["codex-managed-remote-connections"]
      .filter(
        (value) =>
          z
            .object({ source: z.enum(["discovered", "codex-managed"]) })
            .safeParse(value).success,
      )
      .map((value) => connectionSchema.parse(value));
    const results = await Promise.all(
      connections.map(async (host) => {
        const name = host.displayName || host.alias || host.hostname!;
        try {
          const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
          if (!host.alias) {
            if (host.identity) args.push("-i", host.identity);
            if (host.sshPort) args.push("-p", String(host.sshPort));
          }
          args.push("--", host.alias || host.hostname!, command);
          const { stdout } = await execute("ssh", args, {
            timeout: 15000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const rows = z.array(rowSchema).parse(JSON.parse(stdout));
          const projects = state["remote-projects"]
            .filter((project) => project.hostId === host.hostId)
            .sort((a, b) => b.remotePath.length - a.remotePath.length);
          const threads: Thread[] = rows.map((row) => ({
            id: boardThreadId(host.hostId, row.id),
            hostId: host.hostId,
            hostName: name,
            title: displayTitle(row.name, row.title),
            cwd: row.cwd,
            project:
              projects.find(
                (project) =>
                  row.cwd === project.remotePath ||
                  row.cwd.startsWith(`${project.remotePath}/`),
              )?.label ??
              (basename(row.cwd) || "未归属项目"),
            updatedAt: new Date(row.updated_at * 1000).toISOString(),
            lastUserMessageAt: null,
            kind: "user",
            model: row.model,
            reasoningEffort: row.reasoning_effort,
            collaborationMode: null,
            goalStatus: null,
            turnUsage: null,
            unread: null,
            runtime: null,
            runtimeAt: null,
            fresh: false,
            error: null,
          }));
          return {
            threads,
            host: { hostId: host.hostId, name, available: true, error: null },
          };
        } catch (error) {
          // A failed host retains its last index and reports the failure; other hosts remain usable.
          const failure = error as Error & { stderr?: string };
          return {
            threads: this.cached.threads.filter(
              (thread) => thread.hostId === host.hostId,
            ),
            host: {
              hostId: host.hostId,
              name,
              available: false,
              error: (failure.stderr?.trim() || failure.message).slice(0, 500),
            },
          };
        }
      }),
    );
    return {
      threads: results.flatMap((result) => result.threads),
      hosts: results.map((result) => result.host),
    };
  }
}
