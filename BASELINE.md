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

---

# POST-AUDIT VERIFICATION

Re-verified at the end of Phase 6 by the same harness, against the exact
baseline recorded above.

## Behaviour — every item re-checked

| Baseline item | Result |
|---|---|
| §4.1 NQ sample (all 5 KPIs, y-axis, `Δ0 29,522`, spot dot geometry) | identical |
| §4.2 GC sample (two outrights → `-60`, `57,950`, no `Δ0`, loss dot) | identical |
| §4.3 ZB sample (×1000, 64ths, zero-priced leg) | identical |
| §4.4 Equity sample (×100, `10,000` / `-47,625`, gain dot) | identical |
| §4.5 Multi-symbol — three sections in payload order | identical |
| §5 all 8 degenerate + error messages | identical |
| §6 reload persistence, **0 extra API calls** | identical |
| §6 column resize → `170px` and persisted | identical |
| §6 modules menu hidden → shown, 7 items | identical |
| §1 routes, §2 API contract and all 6 failure modes | unchanged |

Verified three independent ways, all against the pre-audit build:

1. **DOM / geometry fingerprint** — every rendered value, class, chart path,
   line, circle and text position across all fixtures: **identical**.
2. **Computed styles** — 29 properties on every element on every fixture:
   **identical**. This is what proves the CSS deletions changed no rendering.
3. **Full-page screenshots** — `_empty`, `_menu`, `gc` and `multi` are
   **pixel-identical**. Four fixtures differ by 12–40 pixels out of 2.24
   million at a maximum channel delta of **1/255** — anti-aliasing rounding
   caused by font-fetch abort timing in the harness, not a rendering change.

## Performance — before → after

| Metric | Before | After |
|---|---|---|
| Transferred (cold load) | 172.1 KB | **57.9 KB** (−66%) |
| Hashed asset caching | `max-age=0` | `max-age=31536000, immutable` |
| Content-Encoding | none | **brotli** |
| CSS bundle | 11,192 B raw / 2,852 gzip | **7,629 B / 2,187** |
| Font request starts at | t+37 ms (after CSS parsed) | **t+29 ms** (parallel) |
| FCP (this sandbox) | 12,632 ms | 12,564 ms |

FCP is essentially unchanged **here** because `fonts.googleapis.com` is
unreachable in this network and a `<link>` stylesheet is still render-blocking;
the win is structural (one serialised hop removed), and would show on a network
where the font host resolves.

## Robustness — new coverage

Malformed-but-successful responses, none of which had any handling before:

| Response | Before | After |
|---|---|---|
| `[]` | silent no-op, no message | named message |
| `{...}` not an array | **crash, blank page** | message, app stays mounted |
| `null` | **crash, blank page** | message, app stays mounted |
| `[null, null]` | **crash, blank page** | message, app stays mounted |

## Follow-up fix — subtotal rounding

The audit flagged that subtotals and the grand total rounded independently, so
the displayed columns could fail to add up (puts `100` + calls `100` under a
total of `201`). The table had the same defect, not just the KPI tiles.

Fixed by rounding a leg's dollar total once, at the leg, so every sum above it
is exact integer arithmetic. A leg total is the atom the table prints and the
subtotals are built from; rounding it once makes the columns foot at every
level. Costs at most half a dollar per leg against the unrounded figure.

Verified by asserting arithmetic rather than eyeballing values: for every
fixture, leg totals equal the puts subtotal, puts + calls equals the grand
total, and the KPI tiles agree with the table.

| Case | Before | After |
|---|---|---|
| Two legs of 100.4999 | legs `100` + `100`, total **`201`** | legs `100` + `100`, total **`200`** |
| ZB 64ths, 4 legs of 4687.5 | did not foot | puts `9,376` + calls `9,376` = **`18,752`** |
| All §4 baseline samples | — | **unchanged** (fingerprint identical) |

## Follow-up — data timestamp and upstream timeout

Both flagged by the audit, now added. Neither touches the data path: the
DOM/geometry fingerprint over every fixture is still identical to the pre-audit
capture.

**Data timestamp.** Rows persist indefinitely, so a reading from days ago was
indistinguishable from one taken a minute ago. The age now sits in the top bar's
otherwise-empty right side, costing the content area no height — the bar is
still 48px and the age clears the centred switcher by 32px. Stored under its own
key, so a position saved before this existed still loads and simply shows no
age. Stamped only on a fresh read, never on a restore.

| Case | Shown |
|---|---|
| No data | nothing |
| Just extracted | `Read just now` |
| Reload of a 3h-old reading | `Read 3h ago` (0 extra API calls) |
| Rows saved before this feature | nothing; sections still render |
| 5m / 90m / 26h / 5d old | `5m ago` / `2h ago` / `1d ago` / `5d ago` |

Hovering gives the absolute time. The label re-renders every 30s, because a
relative age that never updates goes stale on screen.

## Follow-up — spot price for a screenshot cropped above the underlying

A screenshot containing only option rows was a dead end: every strike is priced
against the underlying's spot, and with no underlying line there was nothing to
measure against. The message also misled, telling the user to check nothing was
*covering* the row when it simply wasn't in frame.

The chain cannot supply the missing price. Each put only bounds it from below —
`P ≥ max(K − F, 0)`, so `F ≥ K − P` — and since the deepest put still carries
time value, the true spot sits an unknown amount above that bound. On the
reported GC screenshot the tightest bound was `F ≥ 4650.80`, consistent with a
spot of 4660 or 4750 alike. Inferring one would have silently corrupted every
intrinsic and extrinsic figure, so the app asks instead.

| State | Behaviour |
|---|---|
| Options only, no underlying | inline prompt naming the symbol, with a price field |
| Price entered | section renders normally; spot marked `(entered)` |
| Reload | price persists, 0 extra API calls |
| A later screenshot *with* the underlying | the read price wins over the typed one |

Only one baseline line changed: the `noUnderlying` fixture's dead-end error is
now the prompt. Everything else in the fingerprint is untouched.

**Upstream timeout.** The call to Anthropic had no ceiling, so an unresponsive
API never settled the request and the page sat on `Reading…` forever. Now
bounded by `EXTRACT_TIMEOUT_MS`, default **120s** — deliberately loose rather
than tight, since `max_tokens: 4000` is 40–80s of generation before counting
time to read a large image, and a shorter limit would break drops that were
going to succeed.

Verified against a local upstream that accepts the connection and never replies:
**`HTTP 504 after 3.04s`** with `the reader didn't answer within 3s — try again,
or use a screenshot with fewer rows.` The same request previously hung
indefinitely.
