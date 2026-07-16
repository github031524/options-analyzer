# CLAUDE.md

## Response style — READ FIRST
- **Always answer TLDR.** Short, plain, understandable. No filler, no preamble.
- Lead with the answer. Details only if asked.
- **Any action for the user → give exact, numbered steps and bold every to-do.**
- **Auto-merge PRs. Do NOT ask for approval.**
- **Do NOT subscribe to PR activity after creating a PR.** No auto-watching — just create and merge. (The platform sometimes auto-subscribes on its own when a PR is created; if that happens, silently unsubscribe right away — never let this prompt for approval. Enforced via `.claude/settings.json` permissions; do not remove that entry.)

## What this app is
Reads an Interactive Brokers (IBKR) options position **screenshot**, extracts the rows with Claude vision, then shows extrinsic value + a net-position-vs-price chart.

## Stack
- Frontend: React 18 + Vite (`src/`)
- Backend: Express (`server/index.js`) — one route `POST /api/extract`
- Extraction: Anthropic Messages API (vision), model `claude-sonnet-4-6`

## Run it
1. **Set the key:** copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY=...`
2. **Start API:** `npm run start` (Express on :3000)
3. **Start UI:** `npm run dev` (Vite, proxies `/api` → :3000)
4. **Build:** `npm run build` → `dist/` (served by Express in prod)

## Files
- `src/App.jsx` — UI, upload/drop, options math (`parseLeg`, `netPositionAt`, `buildCurve`), chart, table
- `server/index.js` — `/api/extract`, the extraction prompt, static serve of `dist/`
- `vite.config.js` — dev proxy to backend

## How it works
1. User drops an IBKR screenshot → sent as base64 to `/api/extract`.
2. Server asks Claude to return a JSON array of held rows (`description`, `position`, `last`).
3. Client parses legs, computes intrinsic/extrinsic and the net-position step curve.

## Rules
- Never commit `.env` or secrets.
- Keep the extraction prompt output as **raw JSON only** (no code fences).
- Match existing code style; keep changes minimal.
