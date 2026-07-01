import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleAdminLogin,
  handleAdminSession,
  handleAssemblyNewsRequest,
  handleBlogsRequest,
  loadEnvFile,
} from "./lib/backend.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8001);

loadEnvFile(path.join(__dirname, ".env"), readFileSync);

const assemblyNewsProvider = process.env.NEWS_API_KEY
  ? "newsdata.io"
  : "not configured";

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/assembly-news") {
      await handleAssemblyNewsRequest(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/blogs") {
      await handleBlogsRequest(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/admin/login") {
      await handleAdminLogin(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/admin/session") {
      await handleAdminSession(req, res);
      return;
    }

    await serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "Server error",
        details: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use on ${HOST}. Stop the existing server or run with a different port, for example: PORT=8002 node server.mjs`,
    );
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(
    `TN Governance Dashboard running at http://${HOST}:${PORT} (Assembly provider: ${assemblyNewsProvider})`,
  );
});

async function serveStaticFile(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const relativePath = normalizedPath.replace(/^[/\\]+/, "");
  const filePath = path.join(__dirname, relativePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("Not a file");
    }

    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-cache",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  };

  return contentTypes[extension] || "application/octet-stream";
}
