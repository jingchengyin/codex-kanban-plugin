import { test } from "node:test";
import assert from "node:assert/strict";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { columnFor, type Snapshot } from "../shared/types";

let fixtureSequence = 0;

/** 用真实宿主协议握手测试客户端，只替换浏览器的消息投递与尺寸监听。 */
async function hostFixture(
  supportsFiles: boolean,
  run: (
    client: typeof import("../ui/client.js"),
    opened: string[],
    externalCalls: string[],
    host: AppBridge,
  ) => Promise<void>,
) {
  const globals = [
    "window",
    "document",
    "requestAnimationFrame",
    "ResizeObserver",
    "fetch",
  ] as const;
  const descriptors = new Map(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const listeners = new Set<(event: MessageEvent) => void>();
  const opened: string[] = [];
  const externalCalls: string[] = [];
  const parent = {
    postMessage(message: JSONRPCMessage) {
      queueMicrotask(() => transport.onmessage?.(message));
    },
  };
  const transport: Transport = {
    async start() {},
    async send(message) {
      queueMicrotask(() => {
        const event = {
          data: message,
          source: parent,
        } as unknown as MessageEvent;
        for (const listener of listeners) listener(event);
      });
    },
    async close() {},
  };
  const bridge = new AppBridge(
    null,
    { name: "Codex native file test host", version: "1.0.0" },
    {
      openLinks: {},
      serverTools: {},
      ...(supportsFiles ? { experimental: { "openai/files": {} } } : {}),
    },
  );
  bridge.setRequestHandler(
    z.object({
      method: z.literal("openai/files/open"),
      params: z.object({ path: z.string() }),
    }),
    async ({ params }) => {
      opened.push(params.path);
      return {};
    },
  );
  bridge.onopenlink = async ({ url }) => {
    externalCalls.push(`openLink:${url}`);
    return {};
  };
  bridge.oncalltool = async ({ name }) => {
    externalCalls.push(`callTool:${name}`);
    return { content: [] };
  };
  Object.assign(globalThis, {
    window: {
      parent,
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.add(listener);
      },
      removeEventListener(
        _type: string,
        listener: (event: MessageEvent) => void,
      ) {
        listeners.delete(listener);
      },
      open(url: string) {
        externalCalls.push(`window.open:${url}`);
      },
    },
    document: {
      documentElement: { style: { setProperty() {} } },
      body: {},
    },
    // 尺寸观察不影响文件协议；这里不调度布局测量。
    requestAnimationFrame() {
      return 0;
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: async () => {
      externalCalls.push("fetch");
      throw new Error("文件预览不应请求本地 HTTP 接口");
    },
  });
  try {
    await bridge.connect(transport);
    // 每次导入独立实例，让支持与不支持的宿主分别完成能力协商。
    const client = (await import(
      `${new URL("../ui/client.ts", import.meta.url).href}?native-files=${supportsFiles}-${++fixtureSequence}`
    )) as typeof import("../ui/client.js");
    await run(client, opened, externalCalls, bridge);
  } finally {
    await bridge.close();
    for (const key of globals) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("file and conversation links use Codex host protocols without external fallback", async (t) => {
  await t.test(
    "supported host receives file paths and conversation deep links",
    () =>
      hostFixture(true, async (client, opened, externalCalls) => {
        const path = "/workspace/方案/迭代计划.md";
        await client.openDetectedFile(path);
        assert.deepEqual(opened, [path]);
        assert.deepEqual(externalCalls, []);
        const target = "01a09a03-bd00-71c2-9829-d89a84a479db";
        await client.openConversation(target);
        assert.deepEqual(externalCalls, [`openLink:codex://threads/${target}`]);
      }),
  );

  await t.test(
    "unsupported host reports an error without opening another app",
    () =>
      hostFixture(false, async (client, opened, externalCalls) => {
        await assert.rejects(
          client.openDetectedFile("/workspace/docs/design.md"),
          /当前入口不支持 Codex 文件预览，请从来源对话查看文件。/,
        );
        assert.deepEqual(opened, []);
        assert.deepEqual(externalCalls, []);
      }),
  );
});

test("host-provided list restores immediately even when the view registers observed threads", async () => {
  await hostFixture(true, async (client, _opened, externalCalls, host) => {
    const snapshot: Snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-10-30T10:00:00Z",
      threads: [
        {
          id: "existing-thread",
          title: "Existing conversation",
          cwd: "/work",
          project: "work",
          updatedAt: "2026-10-30T10:00:00Z",
          lastUserMessageAt: null,
          kind: "user",
          model: "model",
          reasoningEffort: "high",
          collaborationMode: "default",
          goalStatus: "none",
          turnUsage: null,
          unread: false,
          runtime: { type: "active", activeFlags: [] },
          runtimeAt: "2026-10-30T10:00:00Z",
          fresh: true,
          error: null,
        },
      ],
      confirmations: { available: true, requests: [] },
      connection: {
        state: "connected",
        endpoint: "ipc://desktop",
        since: null,
        message: null,
      },
      sources: {
        metadata: true,
        unread: true,
        unreadReason: "fixture",
        metadataError: null,
        unreadOptions: [],
        unreadSelection: null,
      },
    };
    await client.connect();
    await host.sendToolInput({ arguments: {} });
    await host.sendToolResult({ content: [], structuredContent: snapshot });
    const restored = await client.readSnapshot(null, []);
    assert.equal(restored.threads.length, 1);
    assert.equal(restored.cached, true);
    assert.equal(restored.threads[0].fresh, false);
    assert.equal(columnFor(restored.threads[0]), "running");
    assert.deepEqual(restored.confirmations, {
      available: false,
      requests: [],
    });
    assert.equal(externalCalls.length, 0);
    let observed: unknown;
    host.oncalltool = async ({ name, arguments: args }) => {
      externalCalls.push(`callTool:${name}`);
      observed = args?.observedThreadIds;
      return { content: [], structuredContent: snapshot };
    };
    const fresh = await client.readSnapshot(null, ["existing-thread"]);
    assert.equal(fresh.threads[0].fresh, true);
    assert.notEqual(fresh.cached, true);
    assert.deepEqual(observed, ["existing-thread"]);
    assert.deepEqual(externalCalls, ["callTool:taskboard_snapshot"]);
  });
});
