/** 工作事项独立记录交付进度，不根据对话运行状态推断是否完成。 */
export type WorkItemStatus = "planned" | "active" | "review" | "done";

export type WorkItem = {
  id: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  threadIds: string[];
  checklist: { id: string; text: string; done: boolean }[];
  links: { label: string; url: string }[];
  createdAt: string;
  updatedAt: string;
};

export type WorkItemInput = Omit<WorkItem, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

/** 用户配置的成果地址前缀；内置合并请求和方案识别规则始终保留。 */
export type ArtifactRules = { urlPrefixes: string[] };

/** 自动发现仅保留成果地址和来源，不保存对话正文。 */
export type DetectedArtifact = {
  id: string;
  label: string;
  threadId: string;
  detectedAt: string;
} & (
  | { kind: "mergeRequest"; url: string }
  | { kind: "link"; url: string }
  | { kind: "planFile"; path: string }
);

export type ArtifactDiscovery = {
  artifacts: DetectedArtifact[];
  unavailableThreadIds: string[];
  /** 尚未生成可用对话成果的来源，由统一索引在后台识别。 */
  pendingThreadIds?: string[];
};

export type WorkspaceData = {
  items: WorkItem[];
  discovery?: ArtifactDiscovery;
};

/** 保存结果明确返回本次事项，首次自动保存可直接取得新建 ID。 */
export type WorkItemSaveResult = WorkspaceData & { item: WorkItem };
