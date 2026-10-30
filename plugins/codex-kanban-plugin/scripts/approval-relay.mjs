import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/** 在桌面原连接上保留待确认请求；只在用户点击后回传对应结果。 */
export function approvalRelay(endpoint, send) {
  const port = Number(new URL(endpoint).port) + 1;
  const requests = new Map();
  const fileChanges = new Map();
  const forget = (predicate) => {
    for (const [id, request] of requests)
      if (predicate(request)) requests.delete(id);
  };
  /** 跟随原连接的请求与结束事件维护有效请求集合。 */
  const observe = (message) => {
    const p = message.params ?? {};
    if (
      ["item/started", "item/completed"].includes(message.method) &&
      p.item?.type === "fileChange"
    )
      fileChanges.set(JSON.stringify([p.threadId, p.item.id]), p.item.changes);
    if (
      ["turn/started", "turn/completed", "thread/closed"].includes(
        message.method,
      )
    ) {
      forget((r) => r.threadId === p.threadId);
      for (const key of fileChanges.keys())
        if (JSON.parse(key)[0] === p.threadId) fileChanges.delete(key);
    }
    if (message.method === "serverRequest/resolved")
      forget((r) => r.threadId === p.threadId && r.rpcId === p.requestId);
    const kind = {
      "item/commandExecution/requestApproval": "command",
      "item/fileChange/requestApproval": "fileChange",
      "item/tool/requestUserInput": "userInput",
    }[message.method];
    if (!kind || message.id === undefined || typeof p.threadId !== "string")
      return;
    if (kind === "command" && p.kind && p.kind !== "command") return;
    // 未支持的扩展决策不转换成普通同意，用户仍可在桌面原界面处理。
    const decisions =
      kind === "command"
        ? (p.availableDecisions ?? ["accept", "decline", "cancel"]).filter(
            (d) => ["accept", "decline", "cancel"].includes(d),
          )
        : kind === "fileChange"
          ? ["accept", "decline", "cancel"]
          : [];
    const changes = fileChanges.get(JSON.stringify([p.threadId, p.itemId]));
    const details =
      kind === "fileChange"
        ? { grantRoot: p.grantRoot }
        : {
            network: p.networkApprovalContext,
            permissions: p.additionalPermissions,
          };
    const readableDetails = Object.fromEntries(
      Object.entries(details).filter(([, v]) => v != null),
    );
    const id = randomUUID();
    requests.set(id, {
      rpcId: message.id,
      turnId: p.turnId,
      id,
      threadId: p.threadId,
      kind,
      reason: p.reason ?? null,
      command: p.command ?? null,
      cwd: p.cwd ?? null,
      details:
        kind === "fileChange" && Array.isArray(changes)
          ? changes.map((c) => `${c.path}\n${c.diff}`).join("\n\n") +
            (p.grantRoot ? `\n\ngrantRoot: ${p.grantRoot}` : "")
          : Object.keys(readableDetails).length
            ? JSON.stringify(readableDetails, null, 2)
            : null,
      decisions:
        kind === "fileChange" && !Array.isArray(changes)
          ? decisions.filter((d) => d !== "accept")
          : decisions,
      questions: (p.questions ?? []).map((q) => ({
        id: q.id,
        question: q.question,
        isSecret: q.isSecret === true,
        allowOther: q.isOther === true || !q.options?.length,
        options: q.options ?? [],
      })),
    });
  };
  /** 桌面先作答时立即撤下看板按钮，保留原始响应转发。 */
  const desktopResponse = (message) => {
    if (!message.method && message.id !== undefined)
      forget((r) => r.rpcId === message.id);
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // 此端口只供本机看板服务访问，浏览器必须经过已有的同源写入入口。
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      req.headers.origin ||
      req.headers["sec-fetch-site"]
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/pending") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          available: true,
          requests: [...requests.values()].map(({ rpcId, turnId, ...r }) => r),
        }),
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.url !== "/respond" ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 100000) {
          res.writeHead(413).end();
          return;
        }
      }
      const input = JSON.parse(body);
      const request = requests.get(input.id);
      if (!request || request.threadId !== input.threadId) {
        res.writeHead(409).end("该请求已处理或已失效，请刷新看板。");
        return;
      }
      let result;
      if (request.kind === "userInput") {
        const answers = input.answers;
        if (
          !answers ||
          Object.keys(answers).length !== request.questions.length ||
          !request.questions.every(
            (q) =>
              Array.isArray(answers[q.id]?.answers) &&
              answers[q.id].answers.length === 1 &&
              typeof answers[q.id].answers[0] === "string" &&
              answers[q.id].answers[0].trim() &&
              (q.allowOther ||
                q.options.some(
                  (option) => option.label === answers[q.id].answers[0],
                )),
          )
        )
          throw new Error("invalid answers");
        result = { answers };
      } else {
        if (!request.decisions.includes(input.decision))
          throw new Error("invalid decision");
        result = { decision: input.decision };
      }
      // 检查与发送之间不等待，桌面和看板先处理的一方会立即移除请求。
      if (!send({ id: request.rpcId, result })) {
        res.writeHead(503).end("桌面连接已断开，请重新连接后重试。");
        return;
      }
      requests.delete(input.id);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ submitted: true }));
    } catch {
      res.writeHead(400).end("确认内容无效，请检查后重试。");
    }
  });
  return {
    observe,
    desktopResponse,
    /** 启动仅监听本机的确认入口。 */
    async start() {
      if (port > 65535)
        throw new Error("No port available for confirmation relay");
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, "127.0.0.1", ok);
      });
    },
    /** 桌面退出时清除全部请求并关闭入口。 */
    close() {
      requests.clear();
      fileChanges.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}
