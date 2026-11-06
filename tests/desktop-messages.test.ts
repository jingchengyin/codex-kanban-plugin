import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sendDesktopMessage,
  conversationMessageInput,
} from "../server/desktop-messages";
import { boardThreadId } from "../shared/thread-location";
import type { DesktopConversation } from "../server/desktop-ipc";

const rawId = "00000000-0000-4000-8000-000000000001";
const boardId = boardThreadId("remote-ssh-discovered:devbox", rawId);

for (const runtime of ["idle", "active"])
  test(`remote messages ${runtime === "idle" ? "start a turn" : "steer the active turn"} with raw conversation IDs and accepted echoes`, async () => {
    const current: DesktopConversation = {
      ownerClientId: "owner",
      revision: 1,
      state: {
        cwd: "/work",
        threadRuntimeStatus: { type: runtime },
        turns: [],
      },
    };
    const input = {
      threadId: boardId,
      clientUserMessageId: randomUUID(),
      text: "  preserve formatting\nsecond line  ",
    };
    const sent: any[] = [];
    const result = await sendDesktopMessage(
      {
        get: () => current,
        requestOwner: async (id, method, params: any) => {
          sent.push({ id, method, params });
          current.state.turns = [
            {
              turnId: "test",
              items: [
                runtime === "idle"
                  ? { type: "userMessage", clientId: input.clientUserMessageId }
                  : {
                      type: "steeringUserMessage",
                      clientUserMessageId: input.clientUserMessageId,
                      status: "accepted",
                    },
              ],
            },
          ];
          return { ok: true };
        },
      },
      input,
      50,
    );
    assert.deepEqual(result, { submitted: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, boardId);
    assert.equal(sent[0].params.conversationId, rawId);
    const request =
      runtime === "idle" ? sent[0].params.turnStart.request : sent[0].params;
    assert.equal(request.clientUserMessageId, input.clientUserMessageId);
    assert.equal(request.input[0].text, input.text);
    if (runtime === "idle")
      assert.equal(
        sent[0].params.turnStart.context.inheritThreadSettings,
        true,
      );
  });

test("owner acknowledgements and pending steering never count as accepted messages", async () => {
  const current: DesktopConversation = {
    ownerClientId: "owner",
    revision: 1,
    state: { threadRuntimeStatus: { type: "active" }, turns: [] },
  };
  const input = {
    threadId: boardId,
    clientUserMessageId: randomUUID(),
    text: "test",
  };
  await assert.rejects(
    sendDesktopMessage(
      {
        get: () => current,
        requestOwner: async () => {
          current.state.turns = [
            {
              turnId: "test",
              items: [
                {
                  type: "steeringUserMessage",
                  clientUserMessageId: input.clientUserMessageId,
                  status: "pending",
                },
              ],
            },
          ];
          return { ok: true };
        },
      },
      input,
      10,
    ),
    /尚未同步/,
  );
});

test("unloaded conversations fail before dispatch and replaced owners revoke confirmation", async () => {
  const input = {
    threadId: boardId,
    clientUserMessageId: randomUUID(),
    text: "test",
  };
  assert.throws(
    () =>
      sendDesktopMessage(
        {
          get: () => undefined,
          requestOwner: async () => assert.fail("must not dispatch"),
        },
        input,
      ),
    /尚未加载/,
  );
  const current: DesktopConversation = {
    ownerClientId: "owner",
    revision: 1,
    state: { threadRuntimeStatus: { type: "idle" }, turns: [] },
  };
  await assert.rejects(
    sendDesktopMessage(
      {
        get: () => current,
        requestOwner: async () => {
          current.ownerClientId = "replacement";
          return { ok: true };
        },
      },
      input,
      10,
    ),
    /连接已变化/,
  );
});

test("message inputs reject blank or oversized text at the API boundary", () => {
  const input = {
    threadId: boardId,
    clientUserMessageId: randomUUID(),
    text: "test",
  };
  assert.equal(conversationMessageInput.parse(input).text, "test");
  for (const text of ["  ", "a".repeat(20001)])
    assert.equal(
      conversationMessageInput.safeParse({ ...input, text }).success,
      false,
    );
});
