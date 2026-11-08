import { createServer } from "node:http";
import { SCHEMA_VERSION } from "../core/schema";
import type { HealthResponse } from "./api";

const PORT = 5174;

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    const body: HealthResponse = { ok: true, node: process.version, schemaVersion: SCHEMA_VERSION };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Think server: http://127.0.0.1:${PORT}`);
});
