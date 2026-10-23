import http from "node:http";
import fs from "node:fs";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";
const root = await realpath("dist"),
  port = Number(process.env.PORT || process.argv[2] || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".properties": "text/plain",
  ".ftl": "text/plain",
};
const server = http.createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(302, { Location: "/pdfjs/web/viewer.html?file=" });
      res.end();
      return;
    }
    const file = await realpath(
      path.resolve(root, "." + decodeURIComponent(url.pathname)),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Content-Length": info.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method === "HEAD") res.end();
    else
      fs.createReadStream(file)
        .on("error", () => res.destroy())
        .pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `OFD / PDF 阅读器：http://127.0.0.1:${port}/（静态文件服务，文档在浏览器内处理）`,
  ),
);
