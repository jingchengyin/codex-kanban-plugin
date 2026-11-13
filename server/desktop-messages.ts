import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import type { DesktopIpc } from "./desktop-ipc.js";
import { desktopTurns } from "./user-input.js";
import { threadLocation } from "../shared/thread-location.js";
import type { ConversationMessage } from "../shared/messages.js";

export const conversationMessageInput = z
  .object({
    threadId: z.string().min(1).max(200),
    clientUserMessageId: z.uuid(),
    text: z
      .string()
      .min(1)
      .max(20000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

/** Ordinary messages and question replies use the same owner transport and inherited settings. */
export function desktopMessageRequest(
  conversationId: string,
  state: any,
  text: string,
  clientUserMessageId: string,
  turnTrigger: "composer" | "send_user_message_async_question",
) {
  const cwd = state.cwd;
  const restoreMessage = {
    id: clientUserMessageId,
    text,
    context: {
      prompt: text,
      turnTrigger,
      addedFiles: [],
      fileAttachments: [],
      ideContext: null,
      imageAttachments: [],
      workspaceRoots: typeof cwd === "string" ? [cwd] : [],
    },
    cwd,
    createdAt: Date.now(),
    responsesapiClientMetadata: { source: "codex" },
  };
  const input = [{ type: "text", text, text_elements: [] }];
  return state.threadRuntimeStatus?.type === "active"
    ? {
        method: "thread-follower-steer-turn",
        params: {
          conversationId,
          input,
          restoreMessage,
          clientUserMessageId,
          attachments: [],
        },
      }
    : {
        method: "thread-follower-start-turn",
        params: {
          conversationId,
          turnStart: {
            request: {
              threadId: conversationId,
              input,
              turnTrigger,
              clientUserMessageId,
            },
            context: {
              inheritThreadSettings: true,
              restoreMessage,
              attachments: [],
            },
          },
        },
      };
}

/** A routing acknowledgement is insufficient: wait for the owner's accepted message echo. */
export function sendDesktopMessage(
  ipc: Pick<DesktopIpc, "get" | "requestOwner">,
  input: ConversationMessage,
  timeoutMs = 5000,
): Promise<{ submitted: true }> {
  const current = ipc.get(input.threadId);
  if (
    !current ||
    !["active", "idle"].includes(current.state.threadRuntimeStatus?.type)
  )
    throw new Error("会话尚未加载，请先打开原对话后再发送。");
  const owner = current.ownerClientId;
  const { threadId } = threadLocation(input.threadId);
  const request = desktopMessageRequest(
    threadId,
    current.state,
    input.text,
    input.clientUserMessageId,
    "composer",
  );
  return deliver();
  async function deliver(): Promise<{ submitted: true }> {
    try {
      await ipc.requestOwner(input.threadId, request.method, request.params);
    } catch (error) {
      throw new Error("消息发送结果尚未确认，请在原对话核对，避免重复发送。", {
        cause: error,
      });
    }
    const deadline = Date.now() + timeoutMs;
    do {
      const latest = ipc.get(input.threadId);
      if (!latest || latest.ownerClientId !== owner)
        throw new Error("原对话连接已变化，请在原对话核对消息是否收到。");
      const received = desktopTurns(latest.state).some((turn) =>
        (turn.items ?? []).some(
          (item: any) =>
            (item.type === "userMessage" &&
              item.clientId === input.clientUserMessageId) ||
            (item.type === "steeringUserMessage" &&
              item.clientUserMessageId === input.clientUserMessageId &&
              item.status === "accepted"),
        ),
      );
      if (received) return { submitted: true };
      await pause(25);
    } while (Date.now() < deadline);
    throw new Error("消息结果尚未同步，请在原对话核对，避免重复发送。");
  }
}
