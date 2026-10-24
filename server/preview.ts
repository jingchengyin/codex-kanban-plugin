import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { StatusBridge } from "./status-bridge.js";

const bridge = new StatusBridge();
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
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/snapshot") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const selection = url.searchParams.get("unreadSelection");
      if (selection && selection.length > 400) {
        res.writeHead(400).end();
        return;
      }
      res.end(JSON.stringify(await bridge.snapshot(selection)));
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'",
      );
      res.end(await readFile(new URL("../ui/index.html", import.meta.url)));
    } else res.writeHead(404).end("Not found");
  } catch {
    res.writeHead(503).end("状态服务暂不可用");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`对话看板：http://127.0.0.1:${port}`),
);
const stop = () => {
  bridge.stop();
  server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
