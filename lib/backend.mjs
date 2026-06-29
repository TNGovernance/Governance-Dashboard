import crypto from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const WORLD_NEWS_API_BASE_URL = "https://api.worldnewsapi.com/search-news";
const BLOGS_FILE_PATH = path.join(process.cwd(), "Data", "blogs.json");
const WORLD_NEWS_SEARCH_TEXT =
  "Tamil Nadu Assembly proceedings budget debate policy note question hour";
const ASSEMBLY_CACHE_TTL_MS = 1000 * 60 * 10;

let assemblyNewsCache = null;
let assemblyNewsCacheUpdatedAt = 0;
let assemblyNewsInFlight = null;

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

export function withApiErrorHandling(handler, fallbackMessage = "Server error") {
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
  const apiKey = process.env.WORLD_NEWS_API_KEY || process.env.NEWS_API_KEY;

  if (
    !apiKey ||
    apiKey === "your_worldnewsapi_key_here" ||
    apiKey === "your_newsapi_key_here"
  ) {
    sendJson(res, 500, {
      error: "Missing WORLD_NEWS_API_KEY in .env",
    });
    return;
  }

  if (apiKey.startsWith("pub_")) {
    sendJson(res, 500, {
      error:
        "This server is now configured for World News API. Replace the pub_ key in .env with WORLD_NEWS_API_KEY from worldnewsapi.com.",
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
  const now = Date.now();
  if (assemblyNewsCache && now - assemblyNewsCacheUpdatedAt < ASSEMBLY_CACHE_TTL_MS) {
    return assemblyNewsCache;
  }

  if (assemblyNewsInFlight) {
    return assemblyNewsInFlight;
  }

  assemblyNewsInFlight = fetchAssemblyNews(apiKey)
    .then((payload) => {
      assemblyNewsCache = payload;
      assemblyNewsCacheUpdatedAt = Date.now();
      return payload;
    })
    .catch((error) => {
      if (
        assemblyNewsCache &&
        error instanceof Error &&
        error.message.includes("Too many concurrent requests")
      ) {
        return {
          ...assemblyNewsCache,
          note: `${assemblyNewsCache.note} Showing a recently cached snapshot because the news provider is rate-limiting requests right now.`,
        };
      }

      throw error;
    })
    .finally(() => {
      assemblyNewsInFlight = null;
    });

  return assemblyNewsInFlight;
}

async function fetchAssemblyNews(apiKey) {
  const englishArticles = await fetchWorldNewsFeed({
    apiKey,
    text: WORLD_NEWS_SEARCH_TEXT,
    language: "en",
    "source-countries": "in",
    sort: "publish-time",
    number: "10",
  });
  const filteredEnglishArticles = filterEnglishArticles(englishArticles);

  return {
    english: sanitizeArticles(
      filteredEnglishArticles.length ? filteredEnglishArticles : englishArticles,
    ),
    tamil: [],
    updatedAt: new Date().toISOString(),
    note:
      "Assembly coverage is being pulled from World News API and filtered for Tamil Nadu Legislative Assembly proceedings, policy debates, governance updates, and manifesto-related discussion.",
  };
}

async function fetchWorldNewsFeed(params) {
  const requestUrl = new URL(WORLD_NEWS_API_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (key !== "apiKey" && value) {
      requestUrl.searchParams.set(key, value);
    }
  });

  const response = await fetch(requestUrl, {
    headers: {
      "x-api-key": params.apiKey,
    },
  });

  const rawPayload = await response.text();
  let payload = {};

  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = { message: rawPayload };
    }
  }

  if (!response.ok) {
    throw new Error(
      payload.message ||
        payload.error ||
        `World News API request failed with status ${response.status}.`,
    );
  }

  if (!Array.isArray(payload.news)) {
    throw new Error("World News API returned an unexpected response format.");
  }

  return payload.news || [];
}

function sanitizeArticles(articles) {
  const seen = new Set();

  return articles
    .filter((article) => article?.title && article?.url)
    .filter((article) => {
      if (seen.has(article.url)) {
        return false;
      }

      seen.add(article.url);
      return true;
    })
    .slice(0, 6)
    .map((article) => ({
      id: article.id || article.url,
      title: article.title,
      source: getSourceLabel(article),
      description: article.summary || article.text || article.description || "",
      url: article.url,
      publishedAt: article.publishedAt || article.publish_date || article.publishDate,
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
  const proceedingsSignals = [
    "assembly proceedings",
    "assembly session",
    "budget session",
    "demand for grants",
    "policy note",
    "question hour",
    "zero hour",
    "governor address",
    "appropriation bill",
    "finance bill",
    "resolution",
    "bill tabled",
    "bill introduced",
    "debate",
    "welfare scheme",
    "manifesto",
    "governance",
    "public policy",
    "policy note",
    "demand for grants",
    "proceedings",
  ];

  return articles.filter((article) => {
    const text = getArticleText(article).toLowerCase();
    return (
      tnSignals.some((signal) => text.includes(signal)) &&
      proceedingsSignals.some((signal) => text.includes(signal))
    );
  });
}

function getArticleText(article) {
  const keywords = Array.isArray(article?.keywords) ? article.keywords.join(" ") : "";
  return `${article?.title || ""} ${article?.summary || ""} ${article?.text || ""} ${article?.description || ""} ${keywords}`.trim();
}

function getSourceLabel(article) {
  if (typeof article?.source === "string" && article.source.trim()) {
    return article.source;
  }

  if (typeof article?.source === "object" && article.source?.name) {
    return article.source.name;
  }

  try {
    const hostname = new URL(article.url).hostname.replace(/^www\./, "");
    return hostname;
  } catch {
    return "Unknown source";
  }
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
  await writeFile(BLOGS_FILE_PATH, `${JSON.stringify(blogs, null, 2)}\n`, "utf8");
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
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
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
  const secret = process.env.ADMIN_TOKEN_SECRET || process.env.BLOG_ADMIN_PASSWORD || "";
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

  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
