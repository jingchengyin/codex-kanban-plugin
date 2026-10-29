import type { Thread, TurnUsage } from "./types.js";

/** 用户主对话中有输入记录的执行回合，运行结束不代表成果已经验收。 */
export type WorkRecord = TurnUsage & {
  threadId: string;
  title: string;
  cwd: string;
  project: string;
  model: string | null;
  kind: Thread["kind"];
  archived: boolean;
};

/** 已知用量与缺失记录分别计数，避免把未知用量当作零。 */
export type WorkSummary = {
  turns: number;
  completed: number;
  interrupted: number;
  inProgress: number;
  tokens: number;
  unknownTokens: number;
  durationMs: number;
  unknownDuration: number;
};

/** 按当地日历天汇总用户发起的回合，明细仅返回当前项目的一页。 */
export type WorkReview = {
  generatedAt: string;
  from: string;
  to: string;
  timezone: string;
  records: WorkRecord[];
  /** 当前项目的全部记录数，用于判断是否还有下一页。 */
  totalRecords: number;
  summary: WorkSummary;
  projects: (WorkSummary & { cwd: string; project: string })[];
  sources: {
    metadata: boolean;
    scannedThreads: number;
    unavailableLogs: number;
    message: string | null;
  };
};

export type WorkReviewOptions = {
  days: number;
  timezone: string;
  project?: string;
  offset?: number;
  limit?: number;
};
