# BASELINE — behaviour before the audit

Captured at commit `276e5ea` (pre-audit). Every number below is a real
observed value, not an estimate. This is the contract the optimisation work
must not break.

Reproduce with `scratchpad/fingerprint.mjs`, which drives a real browser over
every fixture and records all rendered values, chart geometry, and error text.

---

## 1. Routes

Single-page app. The Express server has no page routes of its own:

| Path | Serves |
|---|---|
| `POST /api/extract` | The one API endpoint (below) |
| `/assets/*`, `/logo.svg` | Static build output via `express.static` |
| everything else (`GET *`) | `dist/index.html` — SPA catch-all |

There is no client-side router. All state lives in one component tree; the
URL never changes.

---

## 2. API surface

### `POST /api/extract`

**Request:** `{ base64: string, mediaType: string }` (JSON, 10 MB body limit)

**Success:** `200` with a JSON array of row objects:
`{ description, position, last, bid, ask }`

**Upstream:** Anthropic Messages API, model `claude-sonnet-4-6`,
`max_tokens: 4000`, one image block + one text block.

**Failure modes, all observed:**

| Condition | Status | Body `error` |
|---|---|---|
| No `base64` in request | 400 | `Missing base64 image data` |
| `ANTHROPIC_API_KEY` unset | 500 | `Server is missing ANTHROPIC_API_KEY` |
| Anthropic non-2xx | passthrough | upstream message |
| `stop_reason === "max_tokens"` | 502 | `the position list was too long to read in one pass — …` |
| Model output not parseable | 502 | `Model did not return valid JSON` |
| Thrown exception | 500 | `Extraction failed` |

No other endpoint is called. No third-party API is called from the client.

---

## 3. User-visible features

1. **Ingest** — drop a file, paste (Ctrl/Cmd+V), or click the dropzone to browse.
   Multiple files in one drop are merged; a new drop replaces prior rows.
2. **Per-symbol sections** — rows are grouped by ticker; each symbol renders its
   own KPI row, chart, and table.
3. **KPI row** — ticker + spot, net position at spot, puts/calls/total extrinsic.
   Ticker links to TradingView. Values coloured green (positive) / red (negative).
4. **Step chart** — net underlying position vs price, with per-step value labels,
   strike gridlines, the zero line, a dashed `Δ0` delta-neutral marker, a spot
   dot coloured by sign, and a hover crosshair + tooltip.
5. **Position detail table** — per-leg strike/type/qty/last/intrinsic/extrinsic
   /total, drag-resizable columns, puts subtotal inline, calls + grand total in
   the footer.
6. **Persistence** — extracted rows and column widths survive reload via
   `localStorage`.
7. **Diagnostics** — a named message per symbol that cannot be drawn; the real
   server error surfaced for every failure mode.
8. **Shell** — top bar with logo and a modules dropdown (7 entries).

---

## 4. Sample outputs — real numbers

Clock pinned to `2026-07-01T12:00:00Z` (delta-neutral depends on time to expiry).

### 4.1 NQ futures (×20 multiplier, puts + calls)
Input: spot 29,539.75; short 47×28900P, 20×29000P, 10×29800C, 48×30000C.

| KPI | Value |
|---|---|
| NQ | `29,539.75` |
| Net position at spot | `0` |
| Puts total extrinsic | `19,985` |
| Calls total extrinsic | `19,785` |
| Total extrinsic | `39,770` |

Chart y-axis `74 / 0 / -64`; delta-neutral marker `Δ0 29,522`;
spot dot at `cx=859.12, cy=106.09, r=7`, class `spot-dot` (no sign class — net is 0).

### 4.2 GC futures (×100, **two** outright rows summing to −70)
Input: GC Oct28 −20 and Dec29 −50; spot 4,513.10; short 40×4490P, 10×4520P, 0×4530P.

| KPI | Value |
|---|---|
| GC | `4,513.1` |
| Net position at spot | `-60` |
| Puts total extrinsic | `57,950` |
| Calls total extrinsic | `0` |
| Total extrinsic | `57,950` |

Y-axis `0 / -77`. **No `Δ0` marker** — an all-short-put position never crosses
zero delta, so the estimate is correctly suppressed.
Spot dot class `spot-dot spot-dot--loss`.

### 4.3 ZB futures (×1000, 64ths, one zero-priced leg)
Input: spot 109.46875; short 300×106P (bid/ask null, last 0), 100×108.5P.

| KPI | Value |
|---|---|
| ZB | `109.469` |
| Net position at spot | `0` |
| Puts total extrinsic | `4,688` |
| Total extrinsic | `4,688` |

Y-axis `450 / 0`. No spot dot (spot falls outside the plotted domain).
The 106P contributes `0` — blank bid means mid falls back to `last`, which is 0.

### 4.4 Equity (no futures multiplier → ×100, 100 shares/contract)
Input: DELL spot 391.38; short 50×415P, long 50×380C.

| KPI | Value |
|---|---|
| DELL | `391.38` |
| Net position at spot | `10,000` |
| Puts total extrinsic | `4,275` |
| Calls total extrinsic | `-51,900` |
| Total extrinsic | `-47,625` |

Y-axis `11K / 0`. Spot dot class `spot-dot spot-dot--gain`.

### 4.5 Multi-symbol
NQ + GC + ZB in one payload → exactly three sections, in payload order:
`NQ, GC, ZB`, each with its own multiplier and spot.

---

## 5. Degenerate and error cases

| Case | Observed message |
|---|---|
| Legs but no underlying row | `Read the screenshot. GC: couldn't read the underlying row — …check nothing is covering it.` |
| Underlying but no held legs | `Read the screenshot. ZB: no option rows with a position.` |
| 400 oversized image | `Couldn't read that screenshot — image exceeds 5 MB maximum` |
| 429 rate limited | `Couldn't read that screenshot — rate_limit_error` |
| 502 unparseable output | `Couldn't read that screenshot — try a clearer crop, or one that includes the column headers.` |
| 502 truncated | `Couldn't read that screenshot — the position list was too long to read in one pass — …` |
| 413 with an HTML body | `Couldn't read that screenshot — Server returned 413` |
| Non-image file dropped | `No image file found in that drop. Make sure you're dragging a saved screenshot file…` |

Only the unparseable-output case gets crop advice; every other failure shows the
real reason.

---

## 6. Interaction behaviour

- **Reload persistence** — rows restore from `localStorage` with **0 extra
  `/api/extract` calls**.
- **Column resize** — dragging the first handle +60px changes widths
  `["110px", …]` → `["170px","110px","110px","130px","150px","150px","190px"]`,
  persisted to `options-analyzer:column-widths`.
- **Modules menu** — starts `hidden`; clicking the trigger unhides it.
  7 items, current one inert with `aria-current="page"`.

---

## 7. Performance baseline

Production build served by `server/index.js`, median of 5 cold loads:

| Metric | Value |
|---|---|
| First Contentful Paint | **12,632 ms** |
| DOMContentLoaded | 12,594 ms |
| load | 12,596 ms |
| Transferred | 172.1 KB |

Build output:

| Asset | Raw | Gzip |
|---|---|---|
| `index-*.js` | 162,653 B | 53,292 B |
| `index-*.css` | 11,192 B | 2,852 B |
| `index.html` | 410 B | 289 B |

Observed response headers: `Cache-Control: public, max-age=0`, **no
`Content-Encoding`** — assets are served uncompressed even when the client sends
`Accept-Encoding: gzip`.

The 12.6 s FCP is caused by a render-blocking `@import` of
`fonts.googleapis.com` at the top of `styles.css`, which fails
(`ERR_CONNECTION_RESET`) after ~12 s in a restricted network. The app renders
correctly in its fallback font stack once it gives up.
