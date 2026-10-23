#!/usr/bin/env node
/**
 * BIP77 mailbox + OHTTP gateway for a self-hosted directory.
 * Bodies are opaque. GET /.well-known/ohttp-gateway is RFC 9540 keys.
 * POST /.well-known/ohttp-gateway is RFC 9458 encapsulated requests.
 */
import http from "node:http";
import { MemoryDirectory } from "../src/lib/mailbox.ts";

const PORT = Number(process.env.PAYJOIN_DIRECTORY_PORT ?? 17777);
const dir = new MemoryDirectory();

const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,accept");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const out = dir.handle(req.method || "GET", url.pathname, body, url.search);
    const gateway = url.pathname.replace(/\/+$/, "").endsWith("ohttp-gateway");
    const type =
      req.method === "GET" && gateway
        ? url.searchParams.has("allowed_purposes")
          ? "application/octet-stream"
          : "application/ohttp-keys"
        : req.method === "POST" && gateway
          ? "message/ohttp-res"
          : "application/octet-stream";
    res.writeHead(out.status, { "content-type": type });
    res.end(Buffer.from(out.bytes));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PrivateBit BIP77 mailbox+OHTTP http://127.0.0.1:${PORT}`);
});
