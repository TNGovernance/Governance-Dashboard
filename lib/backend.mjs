import crypto from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const NEWSDATA_BASE_URL = "https://newsdata.io/api/1/latest";
const BLOGS_FILE_PATH = path.join(process.cwd(), "Data", "blogs.json");

export function loadEnvFile(filePath, readFileSync) {
  try {
    const content = readFileSync(filePath, "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmedLine.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
  } catch {
    // `.env` is optional during setup.
  }
}

export function withApiErrorHandling(
  handler,
  fallbackMessage = "Server error",
) {
  return async function wrappedHandler(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      sendJson(res, 500, {
        error: fallbackMessage,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export async function handleAssemblyNewsRequest(_req, res) {
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey || apiKey === "your_newsdata_io_key_here") {
    sendJson(res, 500, {
      error: "Missing NEWS_API_KEY in .env",
    });
    return;
  }

  if (!apiKey.startsWith("pub_")) {
    sendJson(res, 500, {
      error:
        "This server is now configured for newsdata.io keys, which start with 'pub_'. Replace NEWS_API_KEY in .env with your newsdata.io key.",
    });
    return;
  }

  try {
    const payload = await getAssemblyNews(apiKey);
    sendJson(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, {
      error: "Unable to fetch assembly coverage.",
      details: message.includes("100 characters")
        ? "World News API rejected the search query because the text filter was too long. The backend query needs to stay under 100 characters."
        : message.includes("Too many concurrent requests")
          ? "World News API is temporarily rate-limiting concurrent requests. Please try again in a moment."
          : message,
    });
  }
}

export async function handleBlogsRequest(req, res) {
  if (req.method === "GET") {
    const blogs = await readBlogs();
    sendJson(res, 200, blogs);
    return;
  }

  if (req.method === "POST") {
    const authToken = getBearerToken(req);
    if (!isValidAdminToken(authToken)) {
      sendJson(res, 401, {
        error: "Admin authentication required to publish blog updates.",
      });
      return;
    }

    const payload = await readJsonBody(req);
    const title = String(payload.title || "").trim();
    const summary = String(payload.summary || "").trim();
    const content = String(payload.content || "").trim();
    const author = String(payload.author || "").trim() || "Dashboard editor";

    if (!title || !summary || !content) {
      sendJson(res, 400, {
        error: "Title, summary, and content are required.",
      });
      return;
    }

    const blogs = await readBlogs();
    const newBlog = {
      id: Date.now(),
      title,
      summary,
      content,
      author,
      createdAt: new Date().toISOString(),
    };

    blogs.unshift(newBlog);
    await persistBlogs(blogs);
    sendJson(res, 201, newBlog);
    return;
  }

  if (req.method === "DELETE") {
    const authToken = getBearerToken(req);
    if (!isValidAdminToken(authToken)) {
      sendJson(res, 401, {
        error: "Admin authentication required to delete blog updates.",
      });
      return;
    }

    const requestUrl = getRequestUrl(req);
    const payload = await readJsonBody(req);
    const idCandidate = requestUrl.searchParams.get("id") || payload.id;
    const blogId = Number(idCandidate);

    if (!Number.isFinite(blogId)) {
      sendJson(res, 400, { error: "A valid blog id is required." });
      return;
    }

    const blogs = await readBlogs();
    const nextBlogs = blogs.filter((blog) => Number(blog.id) !== blogId);

    if (nextBlogs.length === blogs.length) {
      sendJson(res, 404, { error: "Blog post not found." });
      return;
    }

    await persistBlogs(nextBlogs);
    sendJson(res, 200, { deleted: true, id: blogId });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

export async function handleAdminLogin(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const configuredPassword = process.env.BLOG_ADMIN_PASSWORD;
  if (!configuredPassword) {
    sendJson(res, 500, { error: "Missing BLOG_ADMIN_PASSWORD in .env" });
    return;
  }

  const payload = await readJsonBody(req);
  const password = String(payload.password || "");

  if (!secureCompare(password, configuredPassword)) {
    sendJson(res, 401, { error: "Invalid admin password." });
    return;
  }

  sendJson(res, 200, { token: createAdminToken() });
}

export async function handleAdminSession(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  sendJson(res, 200, {
    authenticated: isValidAdminToken(getBearerToken(req)),
  });
}

async function getAssemblyNews(apiKey) {
  const [proceedings, governance, chamber, leadership] = await Promise.all([
    fetchNewsDataFeed({
      apiKey,
      q: '"Tamil Nadu assembly" session OR debate OR bill OR resolution',
      language: "en",
      size: "10",
    }),
    fetchNewsDataFeed({
      apiKey,
      q: '"Tamil Nadu assembly" budget OR welfare OR scheme OR minister',
      language: "en",
      size: "10",
    }),
    fetchNewsDataFeed({
      apiKey,
      q: '"Tamil Nadu assembly" governor OR opposition OR speaker',
      language: "en",
      size: "10",
    }),
    fetchNewsDataFeed({
      apiKey,
      q: '"Tamil Nadu assembly" chief minister OR cabinet OR MLA',
      language: "en",
      size: "10",
    }),
  ]);

  const englishArticles = [
    ...proceedings,
    ...governance,
    ...chamber,
    ...leadership,
  ];
  const filtered = filterEnglishArticles(englishArticles).sort(
    (a, b) => new Date(b.pubDate) - new Date(a.pubDate),
  );
  const timeline = sanitizeArticles(filtered);

  return {
    english: timeline,
    updatedAt: new Date().toISOString(),
    note: "A running, most-recent-first timeline of English-language news about the Tamil Nadu Legislative Assembly — covering sessions and bills, budget and welfare announcements, the governor and opposition, and the Chief Minister and cabinet — sourced from newsdata.io.",
  };
}

async function fetchNewsDataFeed(params) {
  const requestUrl = new URL(NEWSDATA_BASE_URL);
  requestUrl.searchParams.set("apikey", params.apiKey);
  Object.entries(params).forEach(([key, value]) => {
    if (key !== "apiKey" && value) {
      requestUrl.searchParams.set(key, value);
    }
  });

  const response = await fetch(requestUrl);
  const payload = await response.json();

  if (!response.ok || payload.status === "error") {
    throw new Error(
      payload.results?.message || payload.message || "Unable to fetch news",
    );
  }

  return payload.results || [];
}

function sanitizeArticles(articles) {
  const seen = new Set();

  return articles
    .filter((article) => article?.title && article?.link)
    .filter((article) => {
      if (seen.has(article.link)) {
        return false;
      }

      seen.add(article.link);
      return true;
    })
    .slice(0, 10)
    .map((article) => ({
      id: article.link,
      title: article.title,
      source: article.source_name || article.source_id || "Unknown source",
      description: article.description || "",
      url: article.link,
      publishedAt: article.pubDate,
    }));
}

function filterEnglishArticles(articles) {
  const tnSignals = [
    "tamil nadu",
    "tn assembly",
    "fort st. george",
    "legislative assembly",
    "assembly",
  ];

  return articles.filter((article) => {
    const text = getArticleText(article).toLowerCase();
    return tnSignals.some((signal) => text.includes(signal));
  });
}

function getArticleText(article) {
  const keywords = Array.isArray(article?.keywords)
    ? article.keywords.join(" ")
    : "";
  return `${article?.title || ""} ${article?.description || ""} ${keywords}`.trim();
}

async function readBlogs() {
  try {
    const content = await readFile(BLOGS_FILE_PATH, "utf8");
    const blogs = JSON.parse(content);
    return Array.isArray(blogs) ? blogs : [];
  } catch {
    return [];
  }
}

async function persistBlogs(blogs) {
  await writeFile(
    BLOGS_FILE_PATH,
    `${JSON.stringify(blogs, null, 2)}\n`,
    "utf8",
  );
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      return req.body ? JSON.parse(req.body) : {};
    }
    return req.body || {};
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function getRequestUrl(req) {
  const host = req.headers.host || "localhost";
  return new URL(req.url || "/", `http://${host}`);
}

function getBearerToken(req) {
  const authHeader =
    req.headers.authorization || req.headers.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.slice("Bearer ".length).trim();
}

function createAdminToken() {
  const payload = {
    role: "admin",
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14,
  };
  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signatureSegment = createSignature(payloadSegment);
  return `${payloadSegment}.${signatureSegment}`;
}

function isValidAdminToken(token) {
  if (!token) {
    return false;
  }

  const [payloadSegment, signatureSegment] = token.split(".");
  if (!payloadSegment || !signatureSegment) {
    return false;
  }

  const expectedSignature = createSignature(payloadSegment);
  if (!secureCompare(signatureSegment, expectedSignature)) {
    return false;
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadSegment));
    return payload.role === "admin" && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function createSignature(payloadSegment) {
  const secret =
    process.env.ADMIN_TOKEN_SECRET || process.env.BLOG_ADMIN_PASSWORD || "";
  return crypto
    .createHmac("sha256", secret)
    .update(payloadSegment)
    .digest("base64url");
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(res, statusCode, payload) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.status(statusCode).json(payload);
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}
