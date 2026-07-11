// This is the most code you'll ever see for a file hosting server

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8675;
const STATIC_ROOT = path.resolve(__dirname, "..", "src");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    // Default to index.html if the root is requested
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url || "/", "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("400: Bad Request");
    }

    const requestedPath =
      pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(STATIC_ROOT, requestedPath);

    if (
      filePath !== STATIC_ROOT &&
      !filePath.startsWith(`${STATIC_ROOT}${path.sep}`)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("403: Forbidden");
    }
    let extname = path.extname(filePath);
    let contentType = MIME_TYPES[extname] || "application/octet-stream";

    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404: File Not Found");
        } else {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`500: Server Error (${error.code})`);
        }
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content, "utf-8");
      }
    });
  })
  .listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
