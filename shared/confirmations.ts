/** 看板可直接处理的确认请求与异步问题；ID 只在当前桌面连接内有效。 */
export type Confirmation = {
  id: string;
  threadId: string;
  kind: "command" | "fileChange" | "userInput" | "asyncUserInput";
  reason: string | null;
  command: string | null;
  cwd: string | null;
  details: string | null;
  decisions: ("accept" | "decline" | "cancel")[];
  questions: {
    id: string;
    question: string;
    isSecret: boolean;
    allowOther: boolean;
    options: { label: string; description: string }[];
  }[];
};

export type ConfirmationReply = { id: string; threadId: string } & (
  | { decision: "accept" | "decline" | "cancel" }
  | { answers: Record<string, { answers: string[] }> }
);

export type Confirmations = { available: boolean; requests: Confirmation[] };
