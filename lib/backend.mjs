import crypto from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const NEWSAPI_BASE_URL = "https://newsapi.org/v2/everything";
const BLOGS_FILE_PATH = path.join(process.cwd(), "Data", "blogs.json");
const TAMIL_NEWS_DOMAINS = [
  "dailythanthi.com",
  "dinamalar.com",
  "dinamani.com",
  "maalaimalar.com",
  "polimernews.com",
  "puthiyathalaimurai.com",
];

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
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey || apiKey === "your_newsapi_key_here") {
    sendJson(res, 500, { error: "Missing NEWS_API_KEY in .env" });
    return;
  }

  if (apiKey.startsWith("pub_")) {
    sendJson(res, 500, {
      error:
        "This server is now configured for newsapi.org keys. Replace the pub_ key in .env with a NewsAPI.org NEWS_API_KEY.",
    });
    return;
  }

  try {
    const payload = await getAssemblyNews(apiKey);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 502, {
      error: "Unable to fetch assembly coverage.",
      details: error instanceof Error ? error.message : String(error),
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
  const [englishProceedings, englishGovernance, tamilProceedings, tamilPolicy] =
    await Promise.all([
      fetchNewsApiFeed({
        apiKey,
        q:
          '("Tamil Nadu Legislative Assembly" OR "Tamil Nadu assembly") AND (proceedings OR session OR debate OR "question hour" OR "zero hour" OR "demand for grants" OR bill OR resolution)',
        language: "en",
        pageSize: "12",
        sortBy: "publishedAt",
        searchIn: "title,description,content",
      }),
      fetchNewsApiFeed({
        apiKey,
        q:
          '("Tamil Nadu Legislative Assembly" OR "Tamil Nadu assembly") AND (governance OR manifesto OR "policy note" OR budget OR welfare OR scheme OR minister statement OR announcement)',
        language: "en",
        pageSize: "12",
        sortBy: "publishedAt",
        searchIn: "title,description,content",
      }),
      fetchNewsApiFeed({
        apiKey,
        q:
          '("தமிழ்நாடு சட்டப்பேரவை" OR "சட்டப்பேரவை கூட்டம்" OR "சட்டசபை") AND (விவாதம் OR மசோதா OR "கேள்வி நேரம்" OR பட்ஜெட் OR "மானியக் கோரிக்கை")',
        domains: TAMIL_NEWS_DOMAINS.join(","),
        pageSize: "12",
        sortBy: "publishedAt",
        searchIn: "title,description,content",
      }),
      fetchNewsApiFeed({
        apiKey,
        q:
          '("தமிழ்நாடு சட்டப்பேரவை" OR "சட்டசபை") AND ("கொள்கை விளக்கக் குறிப்பு" OR நலத்திட்டம் OR ஆட்சி OR அறிவிப்பு)',
        domains: TAMIL_NEWS_DOMAINS.join(","),
        pageSize: "12",
        sortBy: "publishedAt",
        searchIn: "title,description,content",
      }),
    ]);

  const englishArticles = [...englishProceedings, ...englishGovernance];
  const tamilArticles = [...tamilProceedings, ...tamilPolicy];

  return {
    english: sanitizeArticles(filterEnglishArticles(englishArticles)),
    tamil: sanitizeArticles(filterTamilArticles(tamilArticles)),
    updatedAt: new Date().toISOString(),
    note:
      "Assembly coverage is being pulled from NewsAPI and filtered for Tamil Nadu Legislative Assembly proceedings, policy debates, governance updates, and manifesto-related discussion.",
  };
}

async function fetchNewsApiFeed(params) {
  const requestUrl = new URL(NEWSAPI_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (key !== "apiKey" && value) {
      requestUrl.searchParams.set(key, value);
    }
  });

  const response = await fetch(requestUrl, {
    headers: {
      "X-Api-Key": params.apiKey,
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
        `NewsAPI request failed with status ${response.status}.`,
    );
  }

  if (!Array.isArray(payload.articles)) {
    throw new Error("NewsAPI returned an unexpected response format.");
  }

  return payload.articles || [];
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
      id: article.url,
      title: article.title,
      source:
        typeof article.source === "string"
          ? article.source
          : article.source?.name || "Unknown source",
      description: article.description || "",
      url: article.url,
      publishedAt: article.publishedAt,
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

function filterTamilArticles(articles) {
  const assemblySignals = ["சட்டப்பேரவை", "சட்டசபை", "அவையில்"];
  const proceedingsSignals = [
    "கூட்டம்",
    "கூட்டத் தொடர்",
    "மானியக் கோரிக்கை",
    "கொள்கை விளக்கக் குறிப்பு",
    "மசோதா",
    "விவாதம்",
    "கேள்வி நேரம்",
    "பூஜ்ய நேரம்",
    "பட்ஜெட்",
    "தீர்மானம்",
    "அறிவிப்பு",
    "நலத்திட்டம்",
    "ஆட்சி",
    "கொள்கை விளக்கக் குறிப்பு",
  ];

  return articles.filter((article) => {
    const text = getArticleText(article);
    return (
      assemblySignals.some((signal) => text.includes(signal)) &&
      proceedingsSignals.some((signal) => text.includes(signal))
    );
  });
}

function getArticleText(article) {
  const keywords = Array.isArray(article?.keywords) ? article.keywords.join(" ") : "";
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
