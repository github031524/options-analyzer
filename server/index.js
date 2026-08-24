import "dotenv/config";
import compression from "compression";
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

const app = express();
// The bundle was going out uncompressed even when the client asked for gzip.
app.use(compression());
app.use(express.json({ limit: "10mb" }));

// What the upstream vision API accepts. The client sends the browser's own
// File.type, so anything outside this list is a file we could not read anyway.
const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
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
    console.error(err);
    res.status(500).json({ error: "Extraction failed" });
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
