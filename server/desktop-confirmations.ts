import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type {
  Confirmation,
  ConfirmationReply,
  Confirmations,
} from "../shared/confirmations.js";
import { confirmationReplyInput } from "./confirmations.js";
import type { DesktopConversation, DesktopIpc } from "./desktop-ipc.js";

type Pending = {
  owner: string;
  raw: any;
  confirmation: Confirmation;
  sent: boolean;
};

const supported = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
  "item/tool/requestUserInput": "userInput",
} as const;
const stale = () => new Error("该请求已处理或已失效，请刷新看板。");
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** 从桌面已有历史中取文件预览，兼容普通 turns 和新版 canonical 历史。 */
function fileChanges(state: any, params: any): any[] | undefined {
  const turns = [
    ...(Array.isArray(state.turns) ? state.turns : []),
    ...Object.values(state.turnHistory?.history?.entitiesByKey ?? {}),
  ] as any[];
  for (const turn of turns) {
    if (turn?.turnId !== params.turnId || !Array.isArray(turn.items)) continue;
    const item = turn.items.find(
      (entry: any) =>
        entry?.type === "fileChange" && entry.id === params.itemId,
    );
    if (
      Array.isArray(item?.changes) &&
      item.changes.length > 0 &&
      item.changes.every(
        (change: any) =>
          typeof change?.path === "string" && typeof change.diff === "string",
      )
    )
      return item.changes;
  }
}

/** 把原生请求转换为现有卡片结构，只提供当前请求支持的操作。 */
function describe(
  threadId: string,
  raw: any,
  state: any,
): Omit<Confirmation, "id"> | null {
  const kind = supported[raw?.method as keyof typeof supported];
  const params = raw?.params;
  if (
    !kind ||
    !["string", "number"].includes(typeof raw.id) ||
    params?.threadId !== threadId ||
    (kind === "command" && params.kind && params.kind !== "command")
  )
    return null;
  const changes =
    kind === "fileChange" ? fileChanges(state, params) : undefined;
  const decisions =
    kind === "userInput"
      ? []
      : kind === "command"
        ? (params.availableDecisions ?? ["accept", "decline", "cancel"]).filter(
            (decision: unknown) =>
              ["accept", "decline", "cancel"].includes(decision as string),
          )
        : changes
          ? ["accept", "decline", "cancel"]
          : ["decline", "cancel"];
  const details = Object.fromEntries(
    Object.entries({
      network: params.networkApprovalContext,
      permissions: params.additionalPermissions,
      ...(kind === "fileChange" ? { grantRoot: params.grantRoot } : {}),
    }).filter(([, value]) => value != null),
  );
  const questions =
    kind === "userInput" && Array.isArray(params.questions)
      ? params.questions.map((question: any) => ({
          id: question.id,
          question: question.question,
          isSecret: question.isSecret === true,
          allowOther: question.isOther === true || !question.options?.length,
          options: question.options ?? [],
        }))
      : [];
  if (
    kind === "userInput" &&
    (!questions.length ||
      questions.some(
        (question: any) =>
          typeof question.id !== "string" ||
          typeof question.question !== "string" ||
          !Array.isArray(question.options),
      ))
  )
    return null;
  return {
    threadId,
    kind,
    reason: text(params.reason),
    command: text(params.command),
    cwd: text(params.cwd),
    details: changes
      ? changes.map((change) => `${change.path}\n${change.diff}`).join("\n\n") +
        (params.grantRoot ? `\n\ngrantRoot: ${params.grantRoot}` : "")
      : Object.keys(details).length
        ? JSON.stringify(details, null, 2)
        : null,
    decisions,
    questions,
  };
}

/** 跟随桌面快照维护确认卡片，并把用户选择送回当前原连接 owner。 */
export class DesktopConfirmations {
  private threads = new Map<string, Map<string, Pending>>();

  constructor(
    private readonly ipc: Pick<DesktopIpc, "get" | "requestOwner">,
    private readonly timeoutMs = 5000,
  ) {}

  /** 每个原请求保留稳定的卡片 ID；owner 或请求内容改变后旧 ID 失效。 */
  update(threadId: string, conversation: DesktopConversation) {
    const previous = this.threads.get(threadId);
    const next = new Map<string, Pending>();
    for (const raw of conversation.state.requests ?? []) {
      const confirmation = describe(threadId, raw, conversation.state);
      if (!confirmation) continue;
      const key = JSON.stringify([conversation.ownerClientId, raw]);
      const known = previous?.get(key);
      next.set(key, {
        owner: conversation.ownerClientId,
        raw,
        confirmation: {
          ...confirmation,
          id: known?.confirmation.id ?? randomUUID(),
        },
        sent: known?.sent ?? false,
      });
    }
    this.threads.set(threadId, next);
  }

  /** 掉线、取消观察或 owner 退出时，立即撤下对应卡片。 */
  remove(threadId: string) {
    this.threads.delete(threadId);
  }

  /** 清除本次桌面连接内的全部请求标识。 */
  clear() {
    this.threads.clear();
  }

  /** 读取前再次对照当前缓存，不把上一次快照里的请求当作仍待处理。 */
  read(): Confirmations {
    for (const threadId of this.threads.keys()) {
      const current = this.ipc.get(threadId);
      if (current) this.update(threadId, current);
      else this.remove(threadId);
    }
    return {
      available: this.threads.size > 0,
      requests: [...this.threads.values()].flatMap((requests) =>
        [...requests.values()]
          .filter((request) => !request.sent)
          .map((request) => request.confirmation),
      ),
    };
  }

  /** 只提交一次；等待原请求从同一 owner 的快照移除后再返回已提交。 */
  async reply(input: ConfirmationReply): Promise<{ submitted: true }> {
    const parsed = confirmationReplyInput.parse(input);
    this.read();
    const pending = [
      ...(this.threads.get(parsed.threadId)?.values() ?? []),
    ].find((entry) => entry.confirmation.id === parsed.id && !entry.sent);
    if (!pending) throw stale();
    const current = this.ipc.get(parsed.threadId);
    if (!current || current.ownerClientId !== pending.owner) throw stale();
    const params: any = {
      conversationId: parsed.threadId,
      requestId: pending.raw.id,
    };
    let method: string;
    if (pending.confirmation.kind === "userInput") {
      if (!("answers" in parsed))
        throw new Error("确认内容无效，请检查后重试。");
      const answers = parsed.answers;
      const questions = pending.confirmation.questions;
      if (
        Object.keys(answers).length !== questions.length ||
        !questions.every((question) => {
          const answer = answers[question.id]?.answers[0];
          return (
            typeof answer === "string" &&
            answer.trim() &&
            (question.allowOther ||
              question.options.some((option) => option.label === answer))
          );
        })
      )
        throw new Error("确认内容无效，请检查后重试。");
      method = "thread-follower-submit-user-input";
      params.response = { answers };
    } else {
      if (
        !("decision" in parsed) ||
        !pending.confirmation.decisions.includes(parsed.decision)
      )
        throw new Error("确认内容无效，请检查后重试。");
      method =
        pending.confirmation.kind === "command"
          ? "thread-follower-command-approval-decision"
          : "thread-follower-file-approval-decision";
      params.decision = parsed.decision;
    }
    // 从此不再接受同一卡片的第二次点击，避免超时后的重复决策。
    pending.sent = true;
    try {
      await this.ipc.requestOwner(parsed.threadId, method, params);
    } catch {
      throw new Error("确认发送未完成，请在原对话核对结果，避免重复提交。");
    }
    const deadline = Date.now() + this.timeoutMs;
    do {
      const latest = this.ipc.get(parsed.threadId);
      if (
        !this.threads.has(parsed.threadId) ||
        !latest ||
        latest.ownerClientId !== pending.owner
      )
        throw stale();
      if (
        !(latest.state.requests ?? []).some(
          (request: any) =>
            request.id === pending.raw.id &&
            request.method === pending.raw.method,
        )
      )
        return { submitted: true };
      await pause(25);
    } while (Date.now() < deadline);
    throw new Error("确认结果尚未同步，请在原对话核对，避免重复提交。");
  }
}
