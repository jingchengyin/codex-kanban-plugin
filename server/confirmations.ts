import { z } from "zod";
import type {
  ConfirmationReply,
  Confirmations,
} from "../shared/confirmations.js";

const replyIdentity = z.object({
  id: z.uuid(),
  threadId: z.string().min(1).max(200),
});
export const confirmationReplyInput = z.union([
  replyIdentity
    .extend({ decision: z.enum(["accept", "decline", "cancel"]) })
    .strict(),
  replyIdentity
    .extend({
      answers: z.record(
        z.string(),
        z.object({ answers: z.array(z.string().max(20000)).length(1) }),
      ),
    })
    .strict(),
]);

/** 复用共享后端的端口约定，连接桌面转发器持有的待确认请求。 */
function relayUrl(endpoint: string, path: string) {
  const port = Number(new URL(endpoint).port) + 1;
  return `http://127.0.0.1:${port}${path}`;
}

/** 旧启动器没有确认入口时返回不可用，不影响只读状态展示。 */
export async function readConfirmations(
  endpoint: string,
): Promise<Confirmations> {
  try {
    const response = await fetch(relayUrl(endpoint, "/pending"), {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return { available: false, requests: [] };
    const data = (await response.json()) as Confirmations;
    return data.available === true && Array.isArray(data.requests)
      ? data
      : { available: false, requests: [] };
  } catch {
    return { available: false, requests: [] };
  }
}

/** 只发送用户明确选择的结果，实际决策由桌面原连接处理。 */
export async function replyToConfirmation(
  endpoint: string,
  input: ConfirmationReply,
) {
  const parsed = confirmationReplyInput.parse(input);
  const response = await fetch(relayUrl(endpoint, "/respond"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error((await response.text()) || "确认提交失败，请重试。");
  return { submitted: true };
}
