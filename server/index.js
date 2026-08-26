import "dotenv/config";
import compression from "compression";
import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTRACTION_PROMPT = `You are reading a screenshot of an options/futures position table from Interactive Brokers.

For each ticker/symbol group, the top row (the stock or futures contract itself, with no PUT or CALL in its description) is the underlying reference instrument. Always include this row and its Last price, even if its Position column is blank — a blank position there just means the underlying itself isn't held, only options on it.

For PUT/CALL option leg rows, include ONLY rows where the Position column has a non-blank value. Skip PUT/CALL rows where Position is blank — those are quotes with no holding.

For each qualifying row, return an object with exactly these fields:
- "description": the exact text from the Financial Instrument (leftmost) column
- "position": the signed integer from the Position column, or 0 if blank
- "last": the Last / Lmt Price value converted to a plain decimal number. If it's shown in bond tick notation like "111'040" (32nds — two digits after the apostrophe are 32nds, an optional third digit is eighths of a 32nd), convert it, e.g. "111'040" = 111 + 4/32 = 111.125. If it's shown as a fraction like "1/64", convert it to a decimal, e.g. "1/64" = 0.015625.
- "bid": the Bid column value for that row, converted to a plain decimal number using the same rules as "last". Use null if there's no Bid column or the cell is blank.
- "ask": the Ask column value for that row, same rules. Use null if there's no Ask column or the cell is blank.

Respond with ONLY a raw JSON array of these objects. No markdown code fences, no explanation, no text before or after the array.`;

// --- Auth -------------------------------------------------------------------
// The app is a personal tool on a public URL, so everything except /health sits
// behind HTTP Basic. Credentials come from the environment only; if any of the
// three are unset we refuse every request rather than serving the app openly.
const { APP_USERNAME, APP_PASSWORD, SECRET_KEY } = process.env;
const AUTH_CONFIGURED = Boolean(APP_USERNAME && APP_PASSWORD && SECRET_KEY);

const COOKIE_NAME = "oa_auth";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Hash first so both sides are the same length: timingSafeEqual throws on a
// length mismatch, and that throw would itself leak the length of the secret.
function safeEqual(a, b) {
  const digest = (v) => crypto.createHash("sha256").update(String(v), "utf8").digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Stateless session: the cookie carries its own expiry plus an HMAC over it, so
// nothing is held server-side and a redeploy doesn't sign anyone out. Binding
// the username into the signature means changing APP_USERNAME revokes old
// cookies; rotating SECRET_KEY revokes all of them.
function sign(exp) {
  return crypto.createHmac("sha256", SECRET_KEY).update(`${APP_USERNAME}.${exp}`).digest("base64url");
}

function validCookie(value) {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot === -1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return safeEqual(value.slice(dot + 1), sign(exp));
}

function readCookie(header, name) {
  for (const part of (header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed percent-escape from a hand-crafted request must not throw.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function challenge(res) {
  res.set("WWW-Authenticate", 'Basic realm="options-analyzer", charset="UTF-8"');
  return res.status(401).type("text/plain").send("Authentication required");
}

function requireAuth(req, res, next) {
  if (!AUTH_CONFIGURED) {
    return res
      .status(503)
      .type("text/plain")
      .send("Server is missing APP_USERNAME, APP_PASSWORD or SECRET_KEY");
  }

  if (validCookie(readCookie(req.headers.cookie, COOKIE_NAME))) return next();

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return challenge(res);

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return challenge(res);

  // Both comparisons always run, so how long the reply takes says nothing about
  // which half was wrong.
  const userOk = safeEqual(decoded.slice(0, sep), APP_USERNAME);
  const passOk = safeEqual(decoded.slice(sep + 1), APP_PASSWORD);
  if (!userOk || !passOk) return challenge(res);

  const exp = Date.now() + COOKIE_MAX_AGE_MS;
  res.cookie(COOKIE_NAME, `${exp}.${sign(exp)}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
  next();
}

const app = express();
// The bundle was going out uncompressed even when the client asked for gzip.
app.use(compression());

// Railway's healthcheck runs without credentials, so this has to sit above the
// auth middleware. It reports nothing about the app beyond being up.
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Ahead of every route, every static file and the SPA fallback below — and
// ahead of the body parser, so an unauthenticated caller can't make us buffer
// 10MB before being turned away.
app.use(requireAuth);
app.use(express.json({ limit: "10mb" }));

// What the upstream vision API accepts. The client sends the browser's own
// File.type, so anything outside this list is a file we could not read anyway.
const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Ceiling on the upstream call. Without one an unresponsive API never settles
// the request and the page sits on "Reading..." forever with no way out.
// Sized to be unreachable in normal use rather than tight: max_tokens is 4000,
// which at typical output speed is 40-80s of generation, plus time to read a
// large image. Anything past that is a stall, not a slow answer. Override with
// EXTRACT_TIMEOUT_MS if the model or limits change.
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS) || 120_000;

app.post("/api/extract", async (req, res) => {
  const { base64, mediaType } = req.body || {};
  if (typeof base64 !== "string" || base64.length === 0) {
    return res.status(400).json({ error: "Missing base64 image data" });
  }
  // Don't forward an arbitrary client string into the upstream request body.
  const imageMediaType = ALLOWED_MEDIA_TYPES.has(mediaType) ? mediaType : "image/png";
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
  }

  // Aborting cancels the response body too, so a stall part-way through a
  // long generation is caught as well as one before the first byte.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), EXTRACT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        // A row costs roughly 40 tokens, so 1000 only covered ~25 rows and a
        // longer position list would silently truncate into invalid JSON.
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: imageMediaType, data: base64 } },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "Anthropic API error" });
    }

    // Truncated output parses as invalid JSON, which would otherwise be
    // reported as an unreadable screenshot rather than an over-long one.
    if (data.stop_reason === "max_tokens") {
      return res.status(502).json({
        error: "the position list was too long to read in one pass — try a screenshot with fewer rows.",
      });
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const cleaned = text.replace(/```json|```/g, "").trim();

    let rows;
    try {
      rows = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: "Model did not return valid JSON" });
    }

    // Parsing is not enough: "null" and "{...}" are valid JSON but not a list of
    // rows, and forwarding either one crashed the client into a blank page.
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: "Model did not return a list of rows" });
    }

    res.json(rows);
  } catch (err) {
    if (err?.name === "AbortError") {
      return res.status(504).json({
        error: `the reader didn't answer within ${Math.round(EXTRACT_TIMEOUT_MS / 1000)}s — try again, or use a screenshot with fewer rows.`,
      });
    }
    console.error(err);
    res.status(500).json({ error: "Extraction failed" });
  } finally {
    clearTimeout(timer);
  }
});

const distPath = path.join(__dirname, "..", "dist");

// Vite fingerprints everything under /assets with a content hash, so those URLs
// can never point at different bytes — they're safe to cache indefinitely.
// Everything else (index.html, logo.svg) keeps the default revalidate-always
// behaviour so a new deploy is picked up immediately.
app.use(
  "/assets",
  express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "1y" })
);
app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
