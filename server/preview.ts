import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { StatusBridge } from "./status-bridge.js";
import { WorkspaceStore } from "./work-items.js";
import { readWorkReview } from "./work-history.js";
import { launchLiveConnection } from "./live-connection.js";
import { ThreadArtifactIndex } from "./thread-artifacts.js";
import type { WorkspaceData } from "../shared/work-items.js";

const bridge = new StatusBridge();
const workspace = new WorkspaceStore(bridge.home);
const artifacts = new ThreadArtifactIndex(bridge.home);
/** 预览和工作事项复用同一份对话成果磁盘索引。 */
const discover = async <T extends WorkspaceData>(data: T) => ({
  ...data,
  discovery: await artifacts.read(data.items.flatMap((item) => item.threadIds)),
});
const port = Number(process.env.TASKBOARD_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid preview port");
bridge.start();
const server = createServer(async (req, res) => {
  if (
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    const json = (data: object) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    };
    if (req.method === "POST") {
      // 主动操作入口只接受同源 JSON 请求，避免其他网页修改本机事项。
      if (
        req.headers.origin !== `http://${req.headers.host}` ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        res.writeHead(403).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1000000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (url.pathname === "/api/work-items/save")
        json(await discover(workspace.save(input)));
      else if (url.pathname === "/api/work-items/add-thread")
        json(await discover(workspace.addThread(input.id, input.threadId)));
      else if (url.pathname === "/api/artifact-rules")
        json(await artifacts.saveRules(input));
      else if (url.pathname === "/api/work-items/delete")
        json(await discover(workspace.delete(input.id)));
      else if (url.pathname === "/api/live/launch")
        json(await launchLiveConnection());
      else if (url.pathname === "/api/confirmations/respond") {
        try {
          json(await bridge.replyToConfirmation(input));
        } catch (error) {
          res
            .writeHead(409)
            .end(
              error instanceof Error ? error.message : "确认提交失败，请重试。",
            );
        }
      } else if (url.pathname === "/api/thread-artifacts") {
        const ids = input.threadIds;
        if (
          !Array.isArray(ids) ||
          ids.length > 500 ||
          !ids.every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
          )
        ) {
          res.writeHead(400).end();
          return;
        }
        json(await artifacts.read(ids));
      } else if (
        url.pathname === "/api/board/open" ||
        url.pathname === "/api/snapshot"
      ) {
        const selection = input.unreadSelection;
        const ids = input.observedThreadIds;
        if (
          (selection != null &&
            (typeof selection !== "string" || selection.length > 400)) ||
          (ids !== undefined &&
            (!Array.isArray(ids) ||
              ids.length > 500 ||
              !ids.every(
                (id: unknown) =>
                  typeof id === "string" && id.length > 0 && id.length <= 200,
              )))
        ) {
          res.writeHead(400).end();
          return;
        }
        json(
          await (url.pathname === "/api/board/open"
            ? bridge.open(selection ?? null, ids)
            : bridge.snapshot(selection ?? null, ids)),
        );
      } else res.writeHead(404).end("Not found");
      return;
    }
    if (url.pathname === "/api/snapshot") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const selection = url.searchParams.get("unreadSelection");
      if (selection && selection.length > 400) {
        res.writeHead(400).end();
        return;
      }
      json(await bridge.snapshot(selection));
    } else if (url.pathname === "/api/artifact-rules") {
      json(await artifacts.readRules());
    } else if (url.pathname === "/api/workspace") {
      json(await discover(workspace.read()));
    } else if (url.pathname === "/api/work-review") {
      json(
        await readWorkReview(bridge.home, {
          days: Number(url.searchParams.get("days") ?? 7),
          timezone: url.searchParams.get("timezone") ?? "UTC",
          project: url.searchParams.get("project") ?? undefined,
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      );
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'",
      );
      res.end(await readFile(new URL("../ui/index.html", import.meta.url)));
    } else res.writeHead(404).end("Not found");
  } catch (error) {
    const invalid =
      error instanceof SyntaxError ||
      (error as { name?: string })?.name === "ZodError" ||
      error instanceof RangeError;
    res
      .writeHead(invalid ? 400 : 503)
      .end(
        invalid
          ? "输入内容无效，请检查后重试。"
          : "工作台服务暂不可用，请稍后重试。",
      );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`对话看板：http://127.0.0.1:${port}`),
);
const stop = () => {
  artifacts.stop();
  bridge.stop();
  server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
