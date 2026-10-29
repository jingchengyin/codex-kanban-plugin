import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ArtifactDiscovery,
  ArtifactRules,
  DetectedArtifact,
} from "../shared/work-items.js";
import { artifactRulesKey } from "../shared/artifact-rules.js";

/** 原生计划没有文件地址，仅缓存明确计划块的原文，供本地预览导出。 */
type NativePlan = {
  id: string;
  kind: "nativePlan";
  label: string;
  threadId: string;
  detectedAt: string;
  content: string;
};
type ArtifactCandidate = DetectedArtifact | NativePlan;
type ArtifactState = {
  cwd: string;
  artifacts: Map<string, ArtifactCandidate>;
  pending: ArtifactCandidate[];
};
type ArtifactCache = {
  rulesKey: string;
  ino: number;
  size: number;
  mtime: number;
  offset: number;
  state: ArtifactState;
};
// 解析器逻辑变化时递增版本；用户规则另由 rulesKey 校验。
const artifactCacheVersion = 2;
type ThreadLog = { cwd: unknown; rollout_path: unknown };
/** 文件名索引按 Codex 目录复用，历史分段归属仅在请求对应对话时核对。 */
type SegmentIndex = {
  indexedAt: number | null;
  candidates: Map<string, Set<string>>;
  validated: Map<string, Promise<boolean>>;
  rollouts: Map<string, string>;
  refreshing?: Promise<void>;
};
const rolloutName =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$/i;
const documentExtensions = new Set([
  ".md",
  ".mdx",
  ".pdf",
  ".docx",
  ".rst",
  ".txt",
]);
const planName =
  /(?:^|[\s/_.-])(?:plans?|proposals?|designs?|spec(?:ification)?s?)(?:$|[\s/_.-])|方案|计划|设计/i;
const planDirectory =
  /^(?:plans?|proposals?|designs?|spec(?:ification)?s?|方案|计划|设计)$/i;

/** 去掉代码围栏，避免把示例命令和源码中的地址当作成果。 */
function withoutCodeBlocks(text: string): string {
  let fence = "";
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = "";
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join("\n");
}

/** 成果标识由来源对话和规范地址生成，刷新与重复消息不会生成新条目。 */
function artifactId(
  kind: DetectedArtifact["kind"],
  threadId: string,
  target: string,
) {
  return createHash("sha256")
    .update(`${kind}\0${threadId}\0${target}`)
    .digest("hex");
}

/** 提取围栏外的完整原生计划块，保留计划内部的代码、缩进和换行。 */
function nativePlans(
  text: string,
  threadId: string,
  detectedAt: string,
): NativePlan[] {
  const plans: NativePlan[] = [];
  let fence = "";
  let content: string[] | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = "";
      content?.push(line);
      continue;
    }
    if (!fence && line.trim() === "<proposed_plan>") {
      content = [];
      continue;
    }
    if (!fence && line.trim() === "</proposed_plan>" && content) {
      const body = content.join("");
      if (body.trim()) {
        const title =
          /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m.exec(body)?.[1]?.trim() ||
          "计划方案";
        plans.push({
          id: artifactId("planFile", threadId, `proposed_plan:${title}`),
          kind: "nativePlan",
          label: title.slice(0, 200),
          threadId,
          detectedAt,
          content: body,
        });
      }
      content = null;
      continue;
    }
    content?.push(line);
  }
  return plans;
}

/** 裸地址在未配对的右括号处结束，URL 内部成对的括号保留。 */
function bareUrlTarget(value: string): string {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") {
      if (depth === 0) {
        value = value.slice(0, index);
        break;
      }
      depth--;
    }
  }
  return value.replace(/[\],.;!?，。；：！？、]+$/u, "");
}

/** 只识别合并请求的固定路径，不访问远端，也不推断合并状态。 */
function mergeRequest(value: string): { url: string; label: string } | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const pr = /^(\/[^/]+\/([^/]+)\/pull\/([1-9]\d*))(?:\/.*)?$/.exec(
      url.pathname,
    );
    const mr = /^(\/.+?)(\/-)?\/merge_requests\/([1-9]\d*)(?:\/.*)?$/.exec(
      url.pathname,
    );
    if (pr)
      return { url: url.origin + pr[1], label: `${pr[2]} · PR #${pr[3]}` };
    if (mr)
      return {
        url: `${url.origin}${mr[1]}${mr[2] ?? ""}/merge_requests/${mr[3]}`,
        label: `${basename(mr[1])} · MR !${mr[3]}`,
      };
  } catch {
    /* 无效地址仍是正文，不作为成果返回。 */
  }
  return null;
}

/** 自定义前缀只匹配同源地址和完整路径段，不把相似域名或路径算作成果。 */
function configuredLink(value: string, prefixes: URL[]): string | null {
  if (!prefixes.length) return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return prefixes.some((prefix) => {
      const path = prefix.pathname.replace(/\/+$/, "");
      return (
        url.origin === prefix.origin &&
        (!path || url.pathname === path || url.pathname.startsWith(`${path}/`))
      );
    })
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** 相对文件只按来源对话目录解析；这里只处理地址，不读取文件正文。 */
function planPath(value: string, label: string, cwd: string): string | null {
  try {
    let path = value
      .trim()
      .replace(/^<|>$/g, "")
      .replace(/:\d+(?::\d+)?$/, "");
    if (path.startsWith("file:")) path = fileURLToPath(path);
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(path)) return null;
      path = decodeURIComponent(path.replace(/[?#].*$/, ""));
    }
    path = path.replace(/\\([() ])/g, "$1");
    if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
    else if (isAbsolute(path)) path = normalize(path);
    else if (cwd && isAbsolute(cwd)) path = resolve(cwd, path);
    else return null;
    const name = basename(path);
    // 规则文件不是交付成果；先规范化路径，确保相对地址也不能绕过排除。
    if (
      !documentExtensions.has(extname(path).toLowerCase()) ||
      /^(?:SKILL|AGENTS)\.md$/i.test(name) ||
      /(?:^|\/)\.(?:codex|agents)\/skills(?:\/|$)/i.test(path)
    )
      return null;
    // 只用文件名、标签和直接父目录判断，避免祖先目录名带来误识别。
    return planName.test(`${name} ${label}`) ||
      planDirectory.test(basename(dirname(path)))
      ? path
      : null;
  } catch {
    return null;
  }
}

/** 从最终答复提取成果地址和原生计划，不保留其他助手正文。 */
function extract(
  text: string,
  threadId: string,
  detectedAt: string,
  cwd: string,
  prefixes: URL[],
): ArtifactCandidate[] {
  const body = withoutCodeBlocks(text);
  const artifacts = new Map<string, DetectedArtifact>();
  const add = (value: string, label = "") => {
    const mr = mergeRequest(value);
    if (mr) {
      const id = artifactId("mergeRequest", threadId, mr.url);
      if (!artifacts.has(id))
        artifacts.set(id, {
          id,
          kind: "mergeRequest",
          threadId,
          detectedAt,
          url: mr.url,
          label: label || mr.label,
        });
      return;
    }
    const url = configuredLink(value, prefixes);
    if (url) {
      const id = artifactId("link", threadId, url);
      if (!artifacts.has(id))
        artifacts.set(id, {
          id,
          kind: "link",
          threadId,
          detectedAt,
          url,
          label: label || url,
        });
      return;
    }
    const path = planPath(value, label, cwd);
    if (!path) return;
    const id = artifactId("planFile", threadId, path);
    if (!artifacts.has(id))
      artifacts.set(id, {
        id,
        kind: "planFile",
        threadId,
        detectedAt,
        path,
        label: label || basename(path),
      });
  };
  // Markdown 地址及标签已处理，不再把链接后的正文当作裸地址重复扫描。
  const bare = body.replace(
    /(?<!!)\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\n)]+))\s*\)/g,
    (_match, label: string, angle: string | undefined, plain: string) => {
      const target = (angle ?? plain).replace(/\s+["'][^"']*["']\s*$/, "");
      add(target, label.replace(/[*_`]/g, "").trim().slice(0, 200));
      return " ";
    },
  );
  for (const match of bare.matchAll(
    /https?:\/\/[^\s<>"'`，。；：！？、（）【】]+/g,
  ))
    add(bareUrlTarget(match[0]));
  for (const match of body.matchAll(/`([^`\n]+)`/g)) add(match[1]);
  return [...artifacts.values(), ...nativePlans(text, threadId, detectedAt)];
}

/** 同一成果只保留一条；同标题的原生计划采用时间较新的版本。 */
function rememberArtifact(
  artifacts: Map<string, ArtifactCandidate>,
  artifact: ArtifactCandidate,
) {
  const previous = artifacts.get(artifact.id);
  if (
    !previous ||
    (artifact.kind === "nativePlan" &&
      previous.kind === "nativePlan" &&
      artifact.content !== previous.content &&
      artifact.detectedAt >= previous.detectedAt)
  )
    artifacts.set(artifact.id, artifact);
}

/** 校验磁盘缓存中的成果字段，损坏缓存按未命中处理。 */
function isArtifact(value: any): value is ArtifactCandidate {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.label !== "string" ||
    typeof value.detectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.detectedAt))
  )
    return false;
  if (value.kind === "mergeRequest" || value.kind === "link")
    return typeof value.url === "string";
  if (value.kind === "planFile")
    return typeof value.path === "string" && isAbsolute(value.path);
  return value.kind === "nativePlan" && typeof value.content === "string";
}

/** 只提交明确最终答复，旧日志的无标记助手消息需等回合结束后才提交。 */
function consume(
  state: ArtifactState,
  line: string,
  threadId: string,
  prefixes: URL[],
) {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return;
  if (record.type === "session_meta" || record.type === "turn_context") {
    if (typeof payload.cwd === "string" && isAbsolute(payload.cwd))
      state.cwd = normalize(payload.cwd);
    return;
  }
  if (
    typeof record.timestamp !== "string" ||
    !Number.isFinite(Date.parse(record.timestamp))
  )
    return;
  const at = new Date(record.timestamp).toISOString();
  const commit = (artifacts: ArtifactCandidate[]) => {
    for (const artifact of artifacts)
      rememberArtifact(state.artifacts, artifact);
  };
  if (record.type === "event_msg" && payload.type === "task_started") {
    state.pending = [];
    return;
  }
  if (record.type === "event_msg" && payload.type === "turn_aborted") {
    state.pending = [];
    return;
  }
  if (record.type === "event_msg" && payload.type === "task_complete") {
    commit(
      typeof payload.last_agent_message === "string"
        ? extract(payload.last_agent_message, threadId, at, state.cwd, prefixes)
        : state.pending,
    );
    state.pending = [];
    return;
  }
  let text: string;
  if (
    record.type === "event_msg" &&
    payload.type === "agent_message" &&
    typeof payload.message === "string"
  )
    text = payload.message;
  else if (
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "assistant" &&
    Array.isArray(payload.content)
  )
    text = payload.content
      .filter(
        (part: any) =>
          ["output_text", "text"].includes(part?.type) &&
          typeof part.text === "string",
      )
      .map((part: any) => part.text)
      .join("\n");
  else return;
  const channel = payload.channel ?? record.channel;
  const phase = payload.phase ?? record.phase;
  if (channel === "final" || phase === "final_answer") {
    // 显式最终答复替代旧版日志中的无标记进度候选。
    state.pending = [];
    commit(extract(text, threadId, at, state.cwd, prefixes));
  } else if (!channel && !phase)
    state.pending = extract(text, threadId, at, state.cwd, prefixes);
}

/** 扫描关联日志，识别合并请求、方案文件及可导出预览的原生计划。 */
export class WorkArtifactReader {
  private cache = new Map<string, ArtifactCache>();
  private pending = new Map<string, Promise<ArtifactCandidate[]>>();
  private segmentIndexes = new Map<string, SegmentIndex>();

  /** 从可丢弃的磁盘缓存恢复完整增量状态，失败时回到正常日志读取。 */
  private async loadCache(
    path: string,
    rulesKey: string,
  ): Promise<ArtifactCache | undefined> {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      if (
        data.schemaVersion !== artifactCacheVersion ||
        (data.rulesKey ?? "[]") !== rulesKey ||
        ![data.ino, data.size, data.mtime, data.offset].every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        ) ||
        !Number.isSafeInteger(data.size) ||
        !Number.isSafeInteger(data.offset) ||
        data.offset > data.size ||
        typeof data.state?.cwd !== "string" ||
        !Array.isArray(data.state.artifacts) ||
        !data.state.artifacts.every(
          (entry: any) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            isArtifact(entry[1]) &&
            entry[0] === entry[1].id,
        ) ||
        !Array.isArray(data.state.pending) ||
        !data.state.pending.every(isArtifact)
      )
        return;
      return {
        rulesKey,
        ino: data.ino,
        size: data.size,
        mtime: data.mtime,
        offset: data.offset,
        state: {
          cwd: data.state.cwd,
          artifacts: new Map(data.state.artifacts),
          pending: data.state.pending,
        },
      };
    } catch {
      return;
    }
  }

  /** 只在日志扫描后落盘，不保存无关正文；缓存写入失败不影响成果返回。 */
  private async saveCache(path: string, cached: ArtifactCache): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: artifactCacheVersion,
          ...cached,
          state: {
            ...cached.state,
            artifacts: [...cached.state.artifacts],
          },
        }),
        { mode: 0o600 },
      );
    } catch {
      // 加速缓存可以重建；不要将磁盘缓存失败误报为来源日志不可用。
    }
  }

  /** 只索引文件名，不打开未请求对话的历史正文。 */
  private async indexSegments(
    home: string,
    index: SegmentIndex,
  ): Promise<void> {
    const candidates = new Map<string, Set<string>>();
    for (const directory of ["sessions", "archived_sessions"]) {
      let entries;
      try {
        entries = await readdir(join(home, directory), {
          recursive: true,
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const id = rolloutName.exec(entry.name)?.[1];
        if (!id) continue;
        let paths = candidates.get(id);
        if (!paths) candidates.set(id, (paths = new Set()));
        paths.add(join(entry.parentPath, entry.name));
      }
    }
    index.candidates = candidates;
    index.validated.clear();
    index.indexedAt = Date.now();
  }

  /** 文件名只筛选候选，首行会话标识必须与来源对话一致。 */
  private async belongsToThread(path: string, id: string): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, "r");
      for await (const line of file.readLines()) {
        const record = JSON.parse(line);
        return record.type === "session_meta" && record.payload?.id === id;
      }
    } catch {
      // 不可验证归属的历史分段不参与识别，当前分段仍按索引读取。
    } finally {
      await file?.close();
    }
    return false;
  }

  /** 目录索引每三十秒按需更新，切换请求集合不会重复遍历或校验首行。 */
  private async logPaths(
    home: string,
    rows: Map<string, ThreadLog>,
  ): Promise<Map<string, Set<string>>> {
    let index = this.segmentIndexes.get(home);
    if (!index) {
      index = {
        indexedAt: null,
        candidates: new Map(),
        validated: new Map(),
        rollouts: new Map(),
      };
      this.segmentIndexes.set(home, index);
    }
    let rolloutChanged = false;
    for (const [id, row] of rows) {
      if (typeof row.rollout_path !== "string" || !row.rollout_path) continue;
      const path = resolve(home, row.rollout_path);
      const previous = index.rollouts.get(id);
      if (previous && previous !== path) rolloutChanged = true;
      index.rollouts.set(id, path);
    }
    if (
      !index.refreshing &&
      (index.indexedAt === null ||
        Date.now() - index.indexedAt >= 30000 ||
        rolloutChanged)
    ) {
      const current = index;
      current.refreshing = this.indexSegments(home, current).finally(() => {
        current.refreshing = undefined;
      });
    }
    await index.refreshing;
    const paths = new Map<string, Set<string>>();
    for (const [id, row] of rows) {
      if (typeof row.rollout_path !== "string" || !row.rollout_path) continue;
      // 当前分段始终从 SQLite 直接补入，不等待目录索引过期。
      const segments = new Set([resolve(home, row.rollout_path)]);
      paths.set(id, segments);
      for (const path of index.candidates.get(id) ?? []) {
        if (segments.has(path)) continue;
        let validated = index.validated.get(path);
        if (!validated) {
          validated = this.belongsToThread(path, id);
          index.validated.set(path, validated);
        }
        if (await validated) segments.add(path);
      }
    }
    return paths;
  }

  /** 包含已归档关联对话；不可读来源单独返回，不影响其他来源的成果。 */
  async read(
    home: string,
    threadIds: string[],
    rules: ArtifactRules = { urlPrefixes: [] },
  ): Promise<ArtifactDiscovery> {
    const rulesKey = artifactRulesKey(rules);
    const prefixes = rules.urlPrefixes.flatMap((prefix) => {
      try {
        return [new URL(prefix)];
      } catch {
        return [];
      }
    });
    const ids = [...new Set(threadIds)];
    const discovery: ArtifactDiscovery = {
      artifacts: [],
      unavailableThreadIds: [],
    };
    if (!ids.length) return discovery;
    let database: DatabaseSync | undefined;
    const rows = new Map<string, ThreadLog>();
    try {
      database = new DatabaseSync(join(home, "state_5.sqlite"), {
        readOnly: true,
      });
      const query = database.prepare(
        "SELECT cwd, rollout_path FROM threads WHERE id = ?",
      );
      for (const id of ids) {
        const row = query.get(id) as ThreadLog | undefined;
        if (row) rows.set(id, row);
      }
    } catch {
      discovery.unavailableThreadIds = ids;
      return discovery;
    } finally {
      database?.close();
    }
    const logPaths = await this.logPaths(home, rows);
    for (const id of ids) {
      const row = rows.get(id);
      if (!row || typeof row.rollout_path !== "string" || !row.rollout_path) {
        discovery.unavailableThreadIds.push(id);
        continue;
      }
      const cwd = typeof row.cwd === "string" ? row.cwd : "";
      const found = new Map<string, ArtifactCandidate>();
      for (const path of [...(logPaths.get(id) ?? [])].sort()) {
        const key = `${id}\0${path}\0${cwd}`;
        try {
          const pendingKey = `${key}\0${rulesKey}`;
          let scan = this.pending.get(pendingKey);
          if (!scan) {
            const cachePath = join(
              home,
              "kanban",
              "artifact-cache",
              `${createHash("sha256").update(key).digest("hex")}.json`,
            );
            scan = this.scan(
              key,
              path,
              id,
              cwd,
              cachePath,
              rulesKey,
              prefixes,
            ).finally(() => this.pending.delete(pendingKey));
            this.pending.set(pendingKey, scan);
          }
          for (const artifact of await scan) rememberArtifact(found, artifact);
        } catch {
          if (!discovery.unavailableThreadIds.includes(id))
            discovery.unavailableThreadIds.push(id);
        }
      }
      for (const artifact of found.values()) {
        if (artifact.kind === "nativePlan") {
          try {
            discovery.artifacts.push(await this.exportPlan(home, artifact));
          } catch {
            if (!discovery.unavailableThreadIds.includes(id))
              discovery.unavailableThreadIds.push(id);
          }
          continue;
        }
        if (artifact.kind === "planFile") {
          try {
            if (!(await stat(artifact.path)).isFile()) continue;
          } catch {
            continue;
          }
        }
        discovery.artifacts.push({ ...artifact });
      }
    }
    discovery.artifacts.sort(
      (a, b) =>
        b.detectedAt.localeCompare(a.detectedAt) || a.id.localeCompare(b.id),
    );
    return discovery;
  }

  /** 原生计划原样导出到插件缓存，复用 Codex 文件预览；未变化时不重写。 */
  private async exportPlan(
    home: string,
    plan: NativePlan,
  ): Promise<DetectedArtifact> {
    const path = join(home, "kanban", "plans", `${plan.id}.md`);
    let previous: string | null = null;
    try {
      previous = await readFile(path, "utf8");
    } catch {
      // 缓存缺失时直接从日志中的计划原文重建。
    }
    if (previous !== plan.content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, plan.content, { mode: 0o600 });
    }
    return {
      id: plan.id,
      kind: "planFile",
      label: plan.label,
      threadId: plan.threadId,
      detectedAt: plan.detectedAt,
      path,
    };
  }

  /** 首次分块读取，后续只扫描追加的完整行；替换或截断时丢弃旧结果。 */
  private async scan(
    key: string,
    path: string,
    threadId: string,
    cwd: string,
    cachePath: string,
    rulesKey: string,
    prefixes: URL[],
  ): Promise<ArtifactCandidate[]> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("成果来源不是日志文件");
    let cached =
      this.cache.get(key) ?? (await this.loadCache(cachePath, rulesKey));
    if (
      !cached ||
      cached.rulesKey !== rulesKey ||
      cached.ino !== info.ino ||
      info.size < cached.size ||
      (info.size === cached.size && info.mtimeMs !== cached.mtime)
    )
      cached = {
        rulesKey,
        ino: info.ino,
        size: 0,
        mtime: 0,
        offset: 0,
        state: { cwd, artifacts: new Map(), pending: [] },
      };
    if (info.size !== cached.size || info.mtimeMs !== cached.mtime) {
      const file = await open(path, "r");
      try {
        let position = cached.offset;
        let suffix = Buffer.alloc(0);
        const block = Buffer.alloc(65536);
        while (position < info.size) {
          const { bytesRead } = await file.read(
            block,
            0,
            Math.min(block.length, info.size - position),
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
          const chunk = Buffer.concat([suffix, block.subarray(0, bytesRead)]);
          let start = 0;
          for (
            let end = chunk.indexOf(10);
            end >= 0;
            end = chunk.indexOf(10, start)
          ) {
            consume(
              cached.state,
              chunk.subarray(start, end).toString("utf8"),
              threadId,
              prefixes,
            );
            cached.offset += end - start + 1;
            start = end + 1;
          }
          suffix = Buffer.from(chunk.subarray(start));
        }
        cached.size = info.size;
        cached.mtime = info.mtimeMs;
        await this.saveCache(cachePath, cached);
      } finally {
        await file.close();
      }
    }
    // 磁盘命中也进入内存缓存，后续刷新只需核对来源文件状态。
    this.cache.set(key, cached);
    return [...cached.state.artifacts.values()];
  }
}
