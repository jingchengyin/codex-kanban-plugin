import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ArtifactDiscovery,
  ArtifactRules,
  DetectedArtifact,
} from "../shared/work-items.js";
import { WorkArtifactReader } from "./work-artifacts.js";
import { artifactRulesKey } from "../shared/artifact-rules.js";
import { ArtifactRulesStore } from "./artifact-rules.js";

type ThreadResult = {
  schemaVersion: 1;
  rulesKey?: string;
  threadId: string;
  artifacts: DetectedArtifact[];
  unavailable: boolean;
};

/** 对话成果的统一磁盘索引；界面只读结果，日志识别在后台按需进行。 */
export class ThreadArtifactIndex {
  private results = new Map<string, ThreadResult>();
  private loading = new Map<string, Promise<ThreadResult | undefined>>();
  private checkedAt = new Map<string, number>();
  private queued = new Set<string>();
  private scheduled = new Set<string>();
  private worker?: Promise<void>;
  private stopped = false;
  private rules: ArtifactRules = { urlPrefixes: [] };
  private rulesKey = artifactRulesKey(this.rules);
  private rulesStore: ArtifactRulesStore;

  constructor(
    readonly home: string,
    private reader: Pick<WorkArtifactReader, "read"> = new WorkArtifactReader(),
  ) {
    this.rulesStore = new ArtifactRulesStore(home);
  }

  /** 每次读取检查共享配置，使其他看板保存的规则也能立即生效。 */
  async readRules(): Promise<ArtifactRules> {
    const rules = await this.rulesStore.read();
    this.applyRules(rules);
    return rules;
  }

  /** 保存成功后清除旧规则下的内存结果，历史成果按界面请求重新识别。 */
  async saveRules(input: ArtifactRules): Promise<ArtifactRules> {
    const rules = await this.rulesStore.save(input);
    this.applyRules(rules);
    return rules;
  }

  /** 两层缓存均使用规则标识，避免修改前缀后继续展示旧成果。 */
  private applyRules(rules: ArtifactRules) {
    const key = artifactRulesKey(rules);
    if (key === this.rulesKey) return;
    this.rules = rules;
    this.rulesKey = key;
    this.results.clear();
    this.checkedAt.clear();
    this.queued.clear();
    this.scheduled.clear();
  }

  /** 对话标识单独散列，解析状态与可直接读取的成果结果分别存储。 */
  private path(threadId: string): string {
    return join(
      this.home,
      "kanban",
      "thread-artifacts",
      `${createHash("sha256").update(threadId).digest("hex")}.json`,
    );
  }

  /** 恢复已识别的成果元信息，坏缓存按缺失处理，不读取原始对话正文。 */
  private async load(
    threadId: string,
    rulesKey: string,
  ): Promise<ThreadResult | undefined> {
    const current = this.results.get(threadId);
    if (current) return current;
    const loadingKey = `${rulesKey}\0${threadId}`;
    let task = this.loading.get(loadingKey);
    if (!task) {
      task = (async () => {
        try {
          const data = JSON.parse(await readFile(this.path(threadId), "utf8"));
          if (
            data.schemaVersion !== 1 ||
            (data.rulesKey ?? "[]") !== rulesKey ||
            data.threadId !== threadId ||
            typeof data.unavailable !== "boolean" ||
            !Array.isArray(data.artifacts) ||
            !data.artifacts.every(
              (artifact: any) =>
                artifact?.threadId === threadId &&
                typeof artifact.id === "string" &&
                typeof artifact.label === "string" &&
                typeof artifact.detectedAt === "string" &&
                Number.isFinite(Date.parse(artifact.detectedAt)) &&
                (((artifact.kind === "mergeRequest" ||
                  artifact.kind === "link") &&
                  typeof artifact.url === "string") ||
                  (artifact.kind === "planFile" &&
                    typeof artifact.path === "string" &&
                    isAbsolute(artifact.path))),
            )
          )
            return;
          if (rulesKey === this.rulesKey) this.results.set(threadId, data);
          return data as ThreadResult;
        } catch {
          return;
        }
      })().finally(() => this.loading.delete(loadingKey));
      this.loading.set(loadingKey, task);
    }
    return task;
  }

  /** 快照仅聚合对话结果；空结果也缓存，避免事项反复触发历史分析。 */
  async read(threadIds: string[]): Promise<ArtifactDiscovery> {
    await this.readRules();
    const rulesKey = this.rulesKey;
    const ids = [...new Set(threadIds)];
    const rows = await Promise.all(ids.map((id) => this.load(id, rulesKey)));
    if (rulesKey !== this.rulesKey) return this.read(threadIds);
    const discovery: ArtifactDiscovery = {
      artifacts: [],
      unavailableThreadIds: [],
      pendingThreadIds: [],
    };
    for (const [index, id] of ids.entries()) {
      const row = rows[index];
      let missingPlan = false;
      if (row?.unavailable) discovery.unavailableThreadIds.push(id);
      for (const artifact of row?.artifacts ?? []) {
        if (artifact.kind === "planFile") {
          try {
            if (!(await stat(artifact.path)).isFile()) {
              missingPlan = true;
              continue;
            }
          } catch {
            missingPlan = true;
            continue;
          }
        }
        discovery.artifacts.push({ ...artifact });
      }
      this.enqueue(id, missingPlan);
      if (!row || missingPlan) discovery.pendingThreadIds!.push(id);
    }
    this.startWorker();
    discovery.artifacts.sort(
      (a, b) =>
        b.detectedAt.localeCompare(a.detectedAt) || a.id.localeCompare(b.id),
    );
    return discovery;
  }

  /** 相同对话共享进行中的识别任务，已知结果最多每十五秒按需更新。 */
  private enqueue(threadId: string, force: boolean) {
    if (
      this.stopped ||
      this.scheduled.has(threadId) ||
      (!force && Date.now() - (this.checkedAt.get(threadId) ?? 0) < 15000)
    )
      return;
    this.checkedAt.set(threadId, Date.now());
    this.scheduled.add(threadId);
    this.queued.add(threadId);
  }

  /** 单个后台队列合并不同界面的请求，避免多个解析器扫描同一份日志。 */
  private startWorker() {
    if (this.worker || this.stopped || !this.queued.size) return;
    this.worker = this.refresh().finally(() => {
      this.worker = undefined;
      this.startWorker();
    });
  }

  /** 每批最多处理三个对话，沿用分段增量解析缓存后再发布统一结果。 */
  private async refresh(): Promise<void> {
    while (!this.stopped && this.queued.size) {
      const ids = [...this.queued].slice(0, 3);
      for (const id of ids) this.queued.delete(id);
      const rules = this.rules;
      const rulesKey = this.rulesKey;
      let found: ArtifactDiscovery;
      try {
        found = await this.reader.read(this.home, ids, rules);
      } catch {
        found = { artifacts: [], unavailableThreadIds: ids };
      }
      // 用户保存规则时旧批次可能仍在读取日志，完成后直接丢弃该批结果。
      if (rulesKey !== this.rulesKey) continue;
      await Promise.all(
        ids.map(async (threadId) => {
          const row: ThreadResult = {
            schemaVersion: 1,
            rulesKey,
            threadId,
            artifacts: found.artifacts.filter(
              (artifact) => artifact.threadId === threadId,
            ),
            unavailable: found.unavailableThreadIds.includes(threadId),
          };
          try {
            const serialized = JSON.stringify(row);
            if (serialized !== JSON.stringify(this.results.get(threadId))) {
              await mkdir(join(this.home, "kanban", "thread-artifacts"), {
                recursive: true,
              });
              await writeFile(this.path(threadId), serialized, { mode: 0o600 });
            }
          } catch {
            // 派生缓存可重建，磁盘写入失败仍发布本次内存结果。
          }
          if (rulesKey === this.rulesKey) {
            this.results.set(threadId, row);
            this.scheduled.delete(threadId);
          }
        }),
      );
    }
  }

  /** 服务退出后停止领取新任务，当前批次完成即可结束。 */
  stop() {
    this.stopped = true;
    this.queued.clear();
  }
}
