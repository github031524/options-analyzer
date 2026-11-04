import { useState, useCallback, useRef, useEffect, Fragment } from "react";
import { Upload } from "lucide-react";
import { EXTRACT_MODEL, modelName } from "../shared/model.js";

const ACCENT = "#5980a6";
const ACCENT_TINT = "#dbe4ee";
const ACCENT_TEXT = "#32485e";
const HAIRLINE = "#c9cacc";

// ---------- extraction ----------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractRows(base64, mediaType) {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, mediaType }),
  });
  // A failing request doesn't always carry a JSON body — a proxy 413 or 502
  // sends HTML, and parsing that would mask the status behind a syntax error.
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* handled below via the status code */
  }
  if (!response.ok) {
    throw new Error(data?.error || `Server returned ${response.status}`);
  }
  // A 200 doesn't guarantee the shape. Anything that isn't a list of row
  // objects used to reach the grouping pass and unmount the app into a blank
  // page, so it's rejected here instead.
  if (!Array.isArray(data)) {
    throw new Error("the server returned something other than a list of rows.");
  }
  return data.filter((row) => row && typeof row === "object");
}

// ---------- parsing & math ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// IBKR writes the expiry inline in the description, e.g. "Jul20'26".
function parseExpiry(description) {
  const m = (description || "").match(/([A-Za-z]{3})(\d{1,2})'(\d{2})/);
  const month = m && MONTHS[m[1].toLowerCase()];
  if (month == null) return null;
  return Date.UTC(2000 + Number(m[3]), month, Number(m[2]), 20, 0, 0);
}

function parseLeg(description) {
  const match = (description || "").match(/(\d+(?:\.\d+)?)\s*(PUT|CALL)/i);
  if (!match) return null;
  return {
    ticker: description.trim().split(/\s+/)[0],
    strike: parseFloat(match[1]),
    type: match[2].toUpperCase(),
    expiry: parseExpiry(description),
  };
}

// ---------- delta-neutral estimate ----------
//
// The step curve is the at-expiry picture: every option is fully assigned or
// fully worthless, so it jumps across zero rather than landing on it. The price
// where the position is ACTUALLY flat needs real deltas, which need time to
// expiry (parsed above) and vol (backed out of each leg's own mid price below).
//
// Black-76 throughout — these are mostly options on futures. Rates are taken as
// zero: the discount factor scales every leg's delta equally, so it cannot move
// the root, and for equities this just means carry is ignored.

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function black76Price(type, F, K, T, sigma) {
  if (!(T > 0) || !(sigma > 0)) return type === "CALL" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + ((sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return type === "CALL"
    ? F * normCdf(d1) - K * normCdf(d2)
    : K * normCdf(-d2) - F * normCdf(-d1);
}

function black76Delta(type, F, K, T, sigma) {
  // With no time value left the delta is the step itself — which is exactly
  // what a leg quoted at or below intrinsic is telling us.
  if (!(T > 0) || !(sigma > 0)) {
    if (type === "CALL") return F > K ? 1 : 0;
    return F < K ? -1 : 0;
  }
  const d1 = (Math.log(F / K) + ((sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return type === "CALL" ? normCdf(d1) : normCdf(d1) - 1;
}

// Bisection: the model price rises monotonically with vol, so this always
// converges when the quote carries any time value at all.
function impliedVol(type, F, K, T, price) {
  if (!(price > 0) || !(T > 0)) return null;
  const intrinsic = type === "CALL" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (price <= intrinsic) return null;
  let lo = 1e-4, hi = 5;
  if (black76Price(type, F, K, T, hi) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (black76Price(type, F, K, T, mid) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

// Each leg's time to expiry in years, and the vol its own quote implies at the
// current spot — what every re-pricing below starts from, so the Δ0 estimate
// and the P&L chart read the same snapshot.
function withImpliedVols(legs, spot, now) {
  return legs.map((leg) => {
    const T = leg.expiry != null ? (leg.expiry - now) / YEAR_MS : 0;
    return { ...leg, T, iv: impliedVol(leg.type, spot, leg.strike, T, leg.last) };
  });
}

// Price at which the delta-weighted position nets to zero. Each leg's vol is
// backed out once at the current spot and then held fixed while the price is
// varied (the standard sticky-vol assumption) — so this is a snapshot, and it
// drifts toward the step curve's crossing as expiry approaches.
function deltaNeutralPrice(legs, baselineShift, sharesPerContract, spot) {
  if (!(spot > 0) || legs.length === 0) return null;
  const priced = withImpliedVols(legs, spot, Date.now());
  // Every leg expired (or none dated) means the step curve already is the answer.
  if (priced.every((l) => !(l.T > 0) || l.iv == null)) return null;

  const netDelta = (F) =>
    baselineShift +
    priced.reduce((sum, l) => sum + l.position * black76Delta(l.type, F, l.strike, l.T, l.iv) * sharesPerContract, 0);

  const strikes = legs.map((l) => l.strike);
  const lo = Math.min(...strikes) * 0.5;
  const hi = Math.max(...strikes) * 1.5;

  // Far from the strikes every option delta underflows toward zero, so values
  // smaller than eps are the tail flattening out, not a crossing. Testing only
  // the bracket ENDPOINTS for that missed real roots, though: an all-put
  // structure (e.g. a 1/-3/1 put fly) can cross zero mid-range and still decay
  // to nothing at the top of the bracket, and the endpoint test read that
  // decayed tail as "no crossing". So scan across the bracket for a sign
  // change between meaningful values — stepping over the underflow zone rather
  // than treating it as a root — and bisect inside the change.
  const size = legs.reduce((s, l) => s + Math.abs(l.position), 0) * sharesPerContract;
  const eps = Math.max(size * 1e-4, 1e-9);

  const STEPS = 400;
  let prevX = null;
  let prevF = null;
  for (let i = 0; i <= STEPS; i++) {
    const x = lo + ((hi - lo) * i) / STEPS;
    const f = netDelta(x);
    if (Math.abs(f) < eps) continue;
    if (prevF != null && f > 0 !== prevF > 0) {
      let a = prevX, b = x, fa = prevF;
      for (let k = 0; k < 100; k++) {
        const mid = (a + b) / 2;
        const fMid = netDelta(mid);
        if (fMid === 0) return mid;
        if (fMid > 0 === fa > 0) { a = mid; fa = fMid; } else { b = mid; }
      }
      return (a + b) / 2;
    }
    prevX = x;
    prevF = f;
  }
  return null; // never crosses with real weight behind it
}

// ---------- per-symbol grouping ----------

// A screenshot can hold several symbols, each with its own underlying row and
// its own legs. Everything downstream (spot, multiplier, curve, totals) is
// per-symbol, so split first and compute each group independently — a strike is
// only meaningful against its own underlying's price.
function buildSymbolViews(rawRows, manualSpots = {}) {
  const order = [];
  const groups = new Map();
  for (const row of rawRows) {
    const ticker = String(row.description || "").trim().split(/\s+/)[0] || "—";
    if (!groups.has(ticker)) {
      groups.set(ticker, []);
      order.push(ticker);
    }
    groups.get(ticker).push(row);
  }

  return order.map((ticker) => {
    const rows = groups.get(ticker);
    // A symbol can hold several outright contracts at once (e.g. GC Oct26 and
    // GC Dec26). They all count toward the net underlying position, so sum every
    // one of them — taking only the first would silently drop the rest.
    const underlyingRows = rows.filter((r) => !parseLeg(r.description));
    const priceRow = underlyingRows.find((r) => Number.isFinite(Number(r.last)));
    // A price that won't parse is as unusable as a missing row, and letting NaN
    // through would render every figure in the section as NaN.
    const extractedSpot = priceRow ? Number(priceRow.last) : null;
    // A screenshot cropped to just the option rows has no underlying line to
    // read, and the chain cannot supply one: every put only bounds the spot
    // from below (F >= K - P), so the true price sits an unknown amount above
    // that. Rather than guess and quietly corrupt every intrinsic, fall back to
    // a price the user typed in.
    const typedSpot = Number(manualSpots[ticker]);
    const spotPrice =
      extractedSpot ?? (Number.isFinite(typedSpot) && typedSpot > 0 ? typedSpot : null);
    const spotIsTyped = extractedSpot == null && spotPrice != null;
    const hasOptionRows = rows.some((r) => parseLeg(r.description));
    const baselineShift = underlyingRows.reduce((sum, r) => {
      const qty = r.position === null || r.position === "" ? 0 : Number(r.position);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);
    const { dollarMultiplier, sharesPerContract } = contractSpec(ticker);

    const legRows =
      spotPrice == null
        ? []
        : rows
            .map((r) => {
              const leg = parseLeg(r.description);
              if (!leg) return null;
              const position = Number(r.position);
              const last = midOrLast(r);
              if (!Number.isFinite(position) || !Number.isFinite(last)) return null;
              const intrinsic =
                leg.type === "PUT" ? Math.max(leg.strike - spotPrice, 0) : Math.max(spotPrice - leg.strike, 0);
              const extrinsic = last - intrinsic;
              return {
                ...leg,
                position,
                last,
                intrinsic,
                extrinsic,
                // Rounded here, at the leg, rather than at each place it is
                // printed. A leg's dollar total is the atom the table shows and
                // the subtotals are built from, so rounding it once makes every
                // sum exact integer arithmetic and the columns foot. Rounding
                // independently at each display instead let full-precision
                // values disagree once printed: two legs of 100.4999 each showed
                // as 100 and 100 under a total of 201, because the unrounded sum
                // 200.9999 rounded up on its own. Costs at most half a dollar
                // per leg against the unrounded figure.
                // Signed by direction: a short leg collected this premium
                // (positive — decay earns it), a long leg paid it (negative —
                // decay burns it). Subtotals then net the way the account
                // does, instead of adding absolute values that painted paid
                // premium green and couldn't tell a fly from its inverse.
                totalExtrinsic: Math.round(extrinsic * -position * dollarMultiplier),
              };
            })
            .filter(Boolean)
            .sort((a, b) => (a.type === b.type ? a.strike - b.strike : a.type === "PUT" ? -1 : 1));

    const putsTotal = legRows.filter((r) => r.type === "PUT").reduce((s, r) => s + r.totalExtrinsic, 0);
    const callsTotal = legRows.filter((r) => r.type === "CALL").reduce((s, r) => s + r.totalExtrinsic, 0);
    const ready = spotPrice != null && legRows.length > 0;
    // Computed before the curve so the chart's domain can stretch to keep the
    // Δ0 marker on screen when it falls past the strike range.
    const neutralPrice = ready ? deltaNeutralPrice(legRows, baselineShift, sharesPerContract, spotPrice) : null;
    const curve = ready ? buildCurve(legRows, baselineShift, sharesPerContract, neutralPrice) : null;

    return {
      ticker,
      spotPrice,
      legRows,
      putsTotal,
      callsTotal,
      grandTotal: putsTotal + callsTotal,
      curve,
      // Drawn over the step chart's price range, so the two charts' strikes
      // line up one above the other.
      pnl: ready
        ? buildPnl(legRows, baselineShift, spotPrice, dollarMultiplier, sharesPerContract, curve.domainMin, curve.domainMax)
        : null,
      netAtSpot: ready ? netPositionAt(legRows, baselineShift, spotPrice, sharesPerContract) : null,
      neutralPrice,
      ready,
      spotIsTyped,
      // Missing spot is recoverable by typing one, so it gets a prompt rather
      // than a dead-end message.
      needsSpot: spotPrice == null && hasOptionRows,
      issue:
        ready || (spotPrice == null && hasOptionRows) ? null : `${ticker}: no option rows with a position.`,
    };
  });
}

// Last-trade prints go stale fast on thin option strikes; prefer the live
// bid/ask mid when both are available and fall back to last otherwise.
function midOrLast(r) {
  const bid = r.bid != null ? Number(r.bid) : NaN;
  const ask = r.ask != null ? Number(r.ask) : NaN;
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number(r.last);
}

// Dollar value of a 1-point move, per futures contract. Options on these
// futures settle 1-for-1 into the future itself (unlike equity options,
// which are 100 shares/contract) -- see contractSpec.
const FUTURES_MULTIPLIERS = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, RTY: 50, M2K: 5, YM: 5, MYM: 0.5,
  NKD: 5, NIY: 500, VXM: 100, BTC: 5, MBT: 0.1, ETH: 50, MET: 0.5,
  CL: 1000, MCL: 100, NG: 10000, MNG: 1000, RB: 42000, HO: 42000,
  BZ: 1000, QM: 500, QG: 2500, LCO: 1000, GC: 100, MGC: 10, SI: 5000,
  SIL: 1000, HG: 25000, PL: 50, PA: 100, QC: 12500, QI: 2500, QO: 50,
  ZC: 50, ZW: 50, ZS: 50, ZM: 100, ZL: 600, ZO: 50, ZR: 2000, KC: 375,
  CC: 10, CT: 500, SB: 1120, OJ: 150, GF: 500, LE: 400, HE: 400, LBS: 110,
  "6E": 125000, M6E: 12500, "6B": 62500, M6B: 6250, "6J": 1250000,
  "6A": 100000, M6A: 10000, "6C": 100000, "6S": 125000, "6M": 500000,
  "6N": 100000, DX: 1000, ZT: 2000, ZF: 1000, ZN: 1000, ZB: 1000,
  UB: 1000, TN: 1000, GE: 2500, SR3: 2500, ZQ: 4167,
};

function contractSpec(ticker) {
  const dollarMultiplier = FUTURES_MULTIPLIERS[ticker];
  return dollarMultiplier != null
    ? { dollarMultiplier, sharesPerContract: 1 }
    : { dollarMultiplier: 100, sharesPerContract: 100 };
}

// Which venue each futures root trades on, for the chart link below. A bare
// futures root is not just ambiguous on TradingView, it is usually wrong —
// "ES" resolves to Eversource Energy, "CC" to a stock — so a root has to be
// qualified before it names the contract the position is actually in.
const FUTURES_EXCHANGES = {
  ES: "CME_MINI", MES: "CME_MINI", NQ: "CME_MINI", MNQ: "CME_MINI",
  RTY: "CME_MINI", M2K: "CME_MINI", YM: "CBOT_MINI", MYM: "CBOT_MINI",
  NKD: "CME", NIY: "CME", VXM: "CFE",
  BTC: "CME", MBT: "CME", ETH: "CME", MET: "CME",
  CL: "NYMEX", MCL: "NYMEX", NG: "NYMEX", MNG: "NYMEX", RB: "NYMEX",
  HO: "NYMEX", BZ: "NYMEX", QM: "NYMEX", QG: "NYMEX", PL: "NYMEX", PA: "NYMEX",
  GC: "COMEX", MGC: "COMEX", SI: "COMEX", SIL: "COMEX", HG: "COMEX",
  QC: "COMEX", QI: "COMEX", QO: "COMEX",
  ZC: "CBOT", ZW: "CBOT", ZS: "CBOT", ZM: "CBOT", ZL: "CBOT", ZO: "CBOT",
  ZR: "CBOT", ZT: "CBOT", ZF: "CBOT", ZN: "CBOT", ZB: "CBOT", UB: "CBOT",
  TN: "CBOT", ZQ: "CBOT",
  KC: "ICEUS", CC: "ICEUS", CT: "ICEUS", SB: "ICEUS", OJ: "ICEUS", DX: "ICEUS",
  GF: "CME", LE: "CME", HE: "CME", LBS: "CME",
  "6E": "CME", M6E: "CME", "6B": "CME", M6B: "CME", "6J": "CME", "6A": "CME",
  M6A: "CME", "6C": "CME", "6S": "CME", "6M": "CME", "6N": "CME",
  GE: "CME", SR3: "CME",
};

// The one place a ticker becomes a TradingView symbol, so every link that
// shows a symbol resolves to the same chart (spec §06). A futures root gets
// the continuous front-month contract ("1!") and its venue where we know it;
// a root we price as a future but can't place still gets "1!", which at least
// says "futures", never a same-named stock. Everything else is an equity and
// passes through as-is.
function tvSymbol(ticker) {
  if (!(ticker in FUTURES_MULTIPLIERS)) return ticker.toLowerCase();
  const exchange = FUTURES_EXCHANGES[ticker];
  return exchange ? `${exchange}:${ticker}1!` : `${ticker}1!`;
}

function netPositionAt(legs, baselineShift, price, sharesPerContract) {
  let v = baselineShift || 0;
  for (const leg of legs) {
    const short = leg.position < 0;
    const qty = Math.abs(leg.position);
    if (leg.type === "PUT") {
      if (short) { if (price < leg.strike) v += sharesPerContract * qty; }
      else { if (price < leg.strike) v -= sharesPerContract * qty; }
    } else {
      if (short) { if (price > leg.strike) v -= sharesPerContract * qty; }
      else { if (price > leg.strike) v += sharesPerContract * qty; }
    }
  }
  return v;
}

function buildCurve(legs, baselineShift, sharesPerContract, include = null) {
  if (legs.length === 0) return null;
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const minK = strikes[0];
  const maxK = strikes[strikes.length - 1];
  const pad = strikes.length > 1 ? (maxK - minK) * 0.15 : Math.max(minK * 0.05, 5);
  let domainMin = minK - pad;
  let domainMax = maxK + pad;
  // The Δ0 marker used to be silently clipped when it landed past the
  // strike-derived edge (ZB: Δ0 at 107.35 against a 107.3 edge). Stretch the
  // domain to keep it on the chart, with half a pad of breathing room.
  if (include != null) {
    domainMin = Math.min(domainMin, include - pad * 0.5);
    domainMax = Math.max(domainMax, include + pad * 0.5);
  }
  const xs = [domainMin, ...strikes, domainMax];

  const segments = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2;
    segments.push({ x0: xs[i], x1: xs[i + 1], y: netPositionAt(legs, baselineShift, mid, sharesPerContract) });
  }
  return { segments, domainMin, domainMax, strikes };
}

// ---------- profit / loss ----------
//
// The screenshot shows today's prices but not what was paid for each leg, so
// P&L is measured from the screenshot's prices: the dollars made or lost from
// there if the whole position is closed with the underlying at a given price.
// Two lines. "At expiry" is drawn at the FIRST expiry — that expiry's options
// are worth their intrinsic, and a later-dated leg keeps the time it still has
// left. "Today" re-prices every leg now. Both run Black-76 at the vol backed
// out of each leg's own quote, the same snapshot the Δ0 estimate uses.
function buildPnl(legs, baselineShift, spot, dollarMultiplier, sharesPerContract, domainMin, domainMax) {
  const now = Date.now();
  const dated = legs.map((l) => l.expiry).filter((e) => e != null);
  const firstExpiry = dated.length ? Math.min(...dated) : null;
  // An expiry already past leaves nothing to wait for: the line is drawn now.
  const horizon = Math.max(now, firstExpiry ?? now);
  const priced = withImpliedVols(legs, spot, now).map((l) => ({
    ...l,
    tLeft: l.expiry != null ? (l.expiry - horizon) / YEAR_MS : 0,
  }));
  // The underlying row counts contracts for futures but shares for equities,
  // so its dollars per point differ from an option's.
  const underlyingPerPoint = dollarMultiplier / sharesPerContract;
  // black76Price falls back to intrinsic for a leg with no time or no vol.
  const pnlWith = (price, timeOf) =>
    baselineShift * (price - spot) * underlyingPerPoint +
    priced.reduce(
      (sum, l) => sum + l.position * (black76Price(l.type, price, l.strike, timeOf(l), l.iv) - l.last) * dollarMultiplier,
      0
    );
  const atExpiry = (price) => pnlWith(price, (l) => l.tLeft);
  // With no time value left anywhere the two lines are one and the same.
  const today =
    horizon > now && priced.some((l) => l.T > 0 && l.iv != null) ? (price) => pnlWith(price, (l) => l.T) : null;

  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  // Even steps plus every strike in view: a single-expiry line is straight
  // between strikes, so landing on each kink draws it exactly. Prices stop at
  // zero even where the chart's range runs below it.
  const lo = Math.max(domainMin, 0);
  const STEPS = 300;
  const xs = [
    ...new Set([
      ...Array.from({ length: STEPS + 1 }, (_, i) => lo + ((domainMax - lo) * i) / STEPS),
      ...strikes.filter((k) => k > lo && k < domainMax),
    ]),
  ].sort((a, b) => a - b);

  // The summary figures cover every price, not just the plotted range. Far
  // above the top strike every call moves one-for-one with the underlying and
  // every put is worthless, so the line ends at this slope: falling is an
  // unlimited loss, rising an unlimited profit.
  const slopeAbove =
    baselineShift * underlyingPerPoint +
    legs.reduce((s, l) => s + (l.type === "CALL" ? l.position * dollarMultiplier : 0), 0);
  // Short of that, it's scanned from zero to twice the top price, strikes
  // included — exact for a single-expiry line, straight between strikes, and
  // within a scan step for a later-dated leg's curve.
  const reach = 2 * Math.max(spot, ...strikes);
  const SCAN = 2000;
  const scan = [...new Set([0, ...strikes, ...Array.from({ length: SCAN + 1 }, (_, i) => (reach * i) / SCAN)])]
    .sort((a, b) => a - b)
    .map((x) => ({ x, y: atExpiry(x) }));
  const breakEvens = [];
  for (let i = 1; i < scan.length; i++) {
    const up = scan[i - 1].y >= 0;
    if (scan[i].y >= 0 === up) continue;
    let a = scan[i - 1].x, b = scan[i].x;
    for (let k = 0; k < 60; k++) {
      const mid = (a + b) / 2;
      if (atExpiry(mid) >= 0 === up) a = mid;
      else b = mid;
    }
    breakEvens.push((a + b) / 2);
  }
  const last = scan[scan.length - 1];
  if (slopeAbove !== 0 && last.y >= 0 !== slopeAbove > 0) breakEvens.push(last.x - last.y / slopeAbove);
  const ys = scan.map((p) => p.y);

  return {
    expiryPts: xs.map((x) => ({ x, y: atExpiry(x) })),
    todayPts: today ? xs.map((x) => ({ x, y: today(x) })) : null,
    breakEvens,
    maxProfit: slopeAbove > 0 ? Infinity : Math.max(...ys),
    maxLoss: slopeAbove < 0 ? -Infinity : Math.min(...ys),
    atSpot: atExpiry(spot),
    firstExpiry,
    mixedExpiries: new Set(dated).size > 1,
    atExpiry,
    today,
  };
}

// A real minus sign (U+2212), not a hyphen — the platform's number treatment.
const MINUS = "−";

// Puts the real minus on any already-formatted number, e.g. a toFixed result.
const fmtSigned = (v) => String(v).replace("-", MINUS);

function fmtMoney(n) {
  const sign = n < 0 ? MINUS : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString()}`;
}

function signClass(n) {
  if (n > 0) return "gain";
  if (n < 0) return "loss";
  return "kpi__figure--accent";
}

// Treasury futures quote in points and 32nds — show their prices the way the
// quote screen writes them ("106'24") instead of the decimal they equal.
const TICK32_TICKERS = new Set(["ZT", "ZF", "ZN", "TN", "ZB", "UB"]);

// 106.75 → "106'24", rounded to the nearest 1/32 tick.
function fmt32(price) {
  const whole = Math.floor(price);
  const ticks = Math.round((price - whole) * 32);
  if (ticks === 32) return `${(whole + 1).toLocaleString()}'00`;
  return `${whole.toLocaleString()}'${String(ticks).padStart(2, "0")}`;
}

// Two decimals, the platform's price treatment (spec §06) — treasuries keep
// their own tick notation instead, which is how they are quoted.
function fmtPrice(price, ticker) {
  return TICK32_TICKERS.has(ticker)
    ? fmt32(price)
    : price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Treasury OPTION prices tick in 64ths — "16/64", the way the quote screen
// writes them. A bid-ask mid can land between ticks, shown as "30.5/64".
function fmt64(price) {
  const sign = price < 0 ? MINUS : "";
  const n = Math.round(Math.abs(price) * 64 * 10) / 10;
  return `${sign}${n}/64`;
}

function fmtShort(n) {
  const sign = n < 0 ? MINUS : "";
  const abs = Math.abs(n);
  // P&L axes reach millions of dollars, where "1500K" would read badly.
  if (abs >= 1e6) return `${sign}${Number((abs / 1e6).toFixed(1))}M`;
  return abs >= 1000 ? `${sign}${Math.round(abs / 1000)}K` : `${sign}${Math.round(abs)}`;
}

// A price picked out on a chart (Δ0, a break-even). Treasuries read in ticks
// ("107'11", nearest 1/32), matching the quote screen. Elsewhere, whole points
// are plenty at index-sized prices but hide too much under 1,000 — show cents
// there.
function fmtLevel(price, ticker) {
  return TICK32_TICKERS.has(ticker)
    ? fmt32(price)
    : price.toLocaleString(undefined, { maximumFractionDigits: price < 1000 ? 2 : 0 });
}

// Smallest 2-significant-figure number at or above value*1.1 (10% headroom),
// so the chart's y-axis hugs the data instead of a coarse 1/2/5 step that can
// round a value like 260 all the way up to 500 and make the line look flat.
function niceCeil(value) {
  if (value <= 0) return 1;
  const padded = value * 1.1;
  const exponent = Math.floor(Math.log10(padded)) - 1;
  const step = 10 ** exponent;
  return Math.ceil(padded / step) * step;
}

// ---------- chart ----------

// The pointer's x in a chart's own viewBox units, whatever size it's drawn at.
function svgPointerX(svg, e) {
  const ctm = svg?.getScreenCTM();
  if (!svg || !ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(ctm.inverse()).x;
}

// The pixel size an element is laid out at, kept current as it resizes.
function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

// Takes whatever room its panel leaves and draws the chart at exactly that
// size, so a label stays 10.5px on any screen. Scaling one fixed-size picture
// to fit instead shrank the text with the column — to about 6px in a
// two-thirds-width panel.
function ChartBox({ children }) {
  const [ref, size] = useElementSize();
  return (
    <div ref={ref} className="chart-box">
      {size && size.width > 0 && size.height > 0 && children(size)}
    </div>
  );
}

// Every label on the chart: Inter at 10.5px in the accent text colour,
// right-aligned unless told otherwise.
function ChartText({ x, y, anchor = "end", children, ...rest }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif" {...rest}>
      {children}
    </text>
  );
}

// The chart's title, and the key to its two P&L lines.
function ChartHead({ pnl }) {
  const { firstExpiry, mixedExpiries, today } = pnl;
  const date =
    firstExpiry != null &&
    new Date(firstExpiry).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const expiryLabel = `${mixedExpiries ? "At first expiry" : "At expiry"}${date ? ` · ${date}` : ""}`;

  return (
    <div className="pnl-head">
      <p className="kpi__label pnl-head__title">
        Profit / loss <span className="pnl-head__note">from the screenshot’s prices</span>
      </p>
      <span className="pnl-legend">
        <svg width="24" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="24" y2="4" stroke={ACCENT} strokeWidth="2" />
        </svg>
        <span className="kpi__label">{expiryLabel}</span>
        {today && (
          <>
            <svg width="24" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="24" y2="4" stroke={ACCENT_TEXT} strokeWidth="1.5" strokeDasharray="5 3" />
            </svg>
            <span className="kpi__label">Today</span>
          </>
        )}
      </span>
    </div>
  );
}

// Filled from the gain/loss tokens via CSS, so a spot dot always matches its
// tile rather than drifting from it.
const spotDotClass = (v) => `spot-dot ${v > 0 ? "spot-dot--gain" : v < 0 ? "spot-dot--loss" : ""}`;

// Profit/loss on top and the net position at expiry underneath, on one price
// axis: a strike, the Δ0 marker or the hover line falls at the same x in both
// panes, so any price reads straight down through the two.
function PositionChart({ view, width: W, height: H }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const { ticker, curve, pnl, neutralPrice, spotPrice, netAtSpot } = view;
  const { segments, domainMin, domainMax, strikes } = curve;
  const { expiryPts, todayPts, breakEvens, atExpiry, today, atSpot } = pnl;

  // The top margin holds the Δ0 label. The bottom one carries the strike
  // labels plus a band under the lower pane's floor for negative steps' value
  // labels, which sit below their own step. The gap between the panes holds
  // the lower one's name.
  const mL = 60, mR = 20, mT = 20, mB = 46, gap = 42;
  const plotW = W - mL - mR;
  const pnlTop = mT;
  const pnlBottom = pnlTop + Math.round((H - mT - mB - gap) * 0.6);
  const netTop = pnlBottom + gap;
  const floor = H - mB;

  const xScale = (p) => mL + ((p - domainMin) / (domainMax - domainMin)) * plotW;
  const priceAt = (x) => domainMin + ((x - mL) / plotW) * (domainMax - domainMin);
  // Each pane sizes each side of zero independently — a position that never
  // goes negative shouldn't spend half a pane on an empty negative half. Zero
  // always stays on the axis (it's the reference each pane is about), just
  // not forced to the middle.
  const paneScale = (values, top, bottom) => {
    const hi = Math.max(0, ...values);
    const lo = Math.min(0, ...values);
    let max = hi > 0 ? niceCeil(hi) : 0;
    let min = lo < 0 ? -niceCeil(-lo) : 0;
    if (max === min) { max = 1; min = -1; }  // flat on zero
    return { max, min, y: (v) => top + ((max - v) / (max - min)) * (bottom - top) };
  };
  const pnlScale = paneScale([...expiryPts, ...(todayPts || [])].map((p) => p.y), pnlTop, pnlBottom);
  const netScale = paneScale(segments.map((s) => s.y), netTop, floor);
  const pnlY = pnlScale.y;
  const netY = netScale.y;
  const pnlZero = pnlY(0);
  const netZero = netY(0);

  // P&L pane. Its lines start at a price of zero when the range runs below it.
  const toLine = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${xScale(p.x)},${pnlY(p.y)}`).join(" ");
  const xFirst = xScale(expiryPts[0].x);
  const xLast = xScale(expiryPts[expiryPts.length - 1].x);
  const wash = `M${xFirst},${pnlZero} ${expiryPts.map((p) => `L${xScale(p.x)},${pnlY(p.y)}`).join(" ")} L${xLast},${pnlZero} Z`;
  // Clip ids are page-wide, and a ticker can start with a digit ("6E").
  const clipId = `pnl-clip-${ticker.replace(/[^A-Za-z0-9]/g, "")}`;

  // Net-position pane.
  let step = "";
  let stepArea = `M${xScale(segments[0].x0)},${netZero} `;
  segments.forEach((s, i) => {
    const x0 = xScale(s.x0), x1 = xScale(s.x1), y = netY(s.y);
    step += (i === 0 ? `M${x0},${y} ` : `L${x0},${y} `) + `L${x1},${y} `;
    stepArea += `L${x0},${y} L${x1},${y} `;
  });
  stepArea += `L${xScale(segments[segments.length - 1].x1)},${netZero} Z`;
  const segmentAt = (price) => segments.find((s) => price >= s.x0 && price <= s.x1) || segments[segments.length - 1];

  const handleMove = (e) => {
    const pointerX = svgPointerX(svgRef.current, e);
    if (pointerX == null) return;
    const x = Math.min(Math.max(pointerX, xFirst), xLast);
    const price = Math.max(priceAt(x), 0);
    setHover({ x, price, net: segmentAt(price).y, expiry: atExpiry(price), today: today ? today(price) : null });
  };

  let tip = null;
  if (hover) {
    const rows = [["Net position", hover.net, false], ["P&L at expiry", hover.expiry, true]];
    if (hover.today != null) rows.push(["P&L today", hover.today, true]);
    const tipW = 184, tipH = 28 + rows.length * 15;
    const tipX = hover.x + 10 + tipW > W - mR ? hover.x - 10 - tipW : hover.x + 10;
    // Top or bottom of the P&L pane, whichever its lines leave clearer across
    // the box — a short-premium position's plateau runs right along the top.
    const lineYs = Array.from({ length: 9 }, (_, i) => Math.max(priceAt(tipX + (tipW * i) / 8), 0)).flatMap((p) =>
      today ? [pnlY(atExpiry(p)), pnlY(today(p))] : [pnlY(atExpiry(p))]
    );
    const clashes = (top) => lineYs.filter((y) => y > top - 6 && y < top + tipH + 6).length;
    const topY = pnlTop + 4;
    const bottomY = pnlBottom - tipH - 4;
    const tipY = clashes(bottomY) < clashes(topY) ? bottomY : topY;
    tip = (
      <g pointerEvents="none">
        <line x1={hover.x} y1={pnlTop} x2={hover.x} y2={floor} stroke={ACCENT} strokeWidth="1" strokeDasharray="3 3" />
        {hover.today != null && (
          <circle cx={hover.x} cy={pnlY(hover.today)} r="3.5" fill={ACCENT_TEXT} stroke="#fff" strokeWidth="1.5" />
        )}
        <circle cx={hover.x} cy={pnlY(hover.expiry)} r="3.5" fill={ACCENT} stroke="#fff" strokeWidth="1.5" />
        <circle cx={hover.x} cy={netY(hover.net)} r="3.5" fill={ACCENT} stroke="#fff" strokeWidth="1.5" />
        <rect x={tipX} y={tipY} width={tipW} height={tipH} rx="3" fill="#fff" stroke={HAIRLINE} strokeWidth="1" />
        <ChartText x={tipX + 8} y={tipY + 16} anchor="start" fontWeight="600">
          {/* Treasuries hover in ticks too, rounded to the nearest 1/32. */}
          {TICK32_TICKERS.has(ticker)
            ? fmt32(hover.price)
            : hover.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </ChartText>
        {rows.map(([label, v, money], i) => (
          <Fragment key={label}>
            <ChartText x={tipX + 8} y={tipY + 32 + i * 15} anchor="start">
              {label}
            </ChartText>
            <ChartText
              x={tipX + tipW - 8}
              y={tipY + 32 + i * 15}
              className={money && v > 0 ? "pnl-text--gain" : money && v < 0 ? "pnl-text--loss" : undefined}
            >
              {fmtMoney(v)}
            </ChartText>
          </Fragment>
        ))}
      </g>
    );
  }

  // A pane's scale, labelled down its left edge. An end that would land on
  // the zero label (a small profit over a large tail loss) is left unlabelled
  // rather than overprinted.
  const axisLabels = ({ max, min, y }) => (
    <>
      {max !== 0 && y(0) - y(max) >= 11 && <ChartText x={mL - 10} y={y(max) + 4}>{fmtShort(max)}</ChartText>}
      <ChartText x={mL - 10} y={y(0) + 4}>0</ChartText>
      {min !== 0 && y(min) - y(0) >= 11 && <ChartText x={mL - 10} y={y(min) + 4}>{fmtShort(min)}</ChartText>}
    </>
  );

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={`${ticker} across prices: profit and loss from ${fmtShort(pnlScale.min)} to ${fmtShort(pnlScale.max)} dollars, and net position at expiry from ${fmtShort(netScale.min)} to ${fmtShort(netScale.max)}`}
      onMouseMove={handleMove}
      onMouseLeave={() => setHover(null)}
      style={{ cursor: "crosshair" }}
    >
      <defs>
        <clipPath id={`${clipId}-gain`}>
          <rect x={mL} y={pnlTop} width={plotW} height={pnlZero - pnlTop} />
        </clipPath>
        <clipPath id={`${clipId}-loss`}>
          <rect x={mL} y={pnlZero} width={plotW} height={pnlBottom - pnlZero} />
        </clipPath>
      </defs>
      {strikes.map((k) => (
        <line key={k} x1={xScale(k)} y1={pnlTop} x2={xScale(k)} y2={floor} stroke={HAIRLINE} strokeWidth="1" />
      ))}

      {/* Profit above the zero line and loss below it, washed in the gain/loss
          colours. */}
      <path d={wash} className="pnl-wash--gain" clipPath={`url(#${clipId}-gain)`} />
      <path d={wash} className="pnl-wash--loss" clipPath={`url(#${clipId}-loss)`} />
      <line x1={mL} y1={pnlZero} x2={W - mR} y2={pnlZero} stroke={ACCENT_TEXT} strokeWidth="1.75" />
      {todayPts && (
        <path d={toLine(todayPts)} fill="none" stroke={ACCENT_TEXT} strokeWidth="1.5" strokeDasharray="5 3" />
      )}
      <path d={toLine(expiryPts)} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinejoin="miter" />
      {axisLabels(pnlScale)}
      {/* Break-evens sit on the zero line, labelled on their losing side —
          where the space above the line is empty — unless that side runs out
          of room at the plot's edge. */}
      {breakEvens
        .filter((b) => b >= domainMin && b <= domainMax)
        .map((b) => {
          const x = xScale(b);
          const label = `Break-even ${fmtLevel(b, ticker)}`;
          const labelW = label.length * 6; // roughly, at this size
          const lossOnLeft = atExpiry(Math.max(b - (domainMax - domainMin) * 1e-3, 0)) < 0;
          const left = lossOnLeft ? x - 8 - labelW >= mL : x + 8 + labelW > W - mR;
          return (
            <g key={b} pointerEvents="none">
              <circle cx={x} cy={pnlZero} r="4" fill="#fff" stroke={ACCENT_TEXT} strokeWidth="1.5" />
              <ChartText x={left ? x - 8 : x + 8} y={pnlZero - 8} anchor={left ? "end" : "start"} className="chart-halo">
                {label}
              </ChartText>
            </g>
          );
        })}

      <ChartText x={mL} y={netTop - 14} anchor="start" className="chart-pane-label">
        Net position at expiry
      </ChartText>
      <line x1={mL} y1={netZero} x2={W - mR} y2={netZero} stroke={ACCENT_TEXT} strokeWidth="1.75" />
      <path d={stepArea} fill={ACCENT_TINT} />
      <path d={step} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinejoin="miter" />
      {axisLabels(netScale)}
      {/* Net position value for each step, centered above its own segment. */}
      {segments.map((s, i) => (
        <ChartText
          key={`v${i}`}
          x={(xScale(s.x0) + xScale(s.x1)) / 2}
          y={s.y < 0 ? netY(s.y) + 15 : netY(s.y) - 6}
          anchor="middle"
        >
          {fmtMoney(s.y)}
        </ChartText>
      ))}
      {strikes.map((k) => (
        <ChartText key={`k${k}`} x={xScale(k)} y={H - 14} anchor="middle">
          {/* Treasuries label the axis in ticks too: 106.5 → "106'16". */}
          {TICK32_TICKERS.has(ticker) ? fmt32(k) : k}
        </ChartText>
      ))}

      {neutralPrice != null && neutralPrice >= domainMin && neutralPrice <= domainMax && (
        <g pointerEvents="none">
          <line
            x1={xScale(neutralPrice)} y1={pnlTop} x2={xScale(neutralPrice)} y2={floor}
            stroke={ACCENT} strokeWidth="1.25" strokeDasharray="4 3"
          />
          <ChartText x={xScale(neutralPrice)} y={pnlTop - 6} anchor="middle" fill={ACCENT}>
            {`Δ0 ${fmtLevel(neutralPrice, ticker)}`}
          </ChartText>
        </g>
      )}
      {/* Spot in both panes: what holding to expiry pays if the price doesn't
          move, and the net position it leaves. Drawn after the Δ0 marker so it
          stays legible on top when the two nearly coincide. */}
      {spotPrice >= domainMin && spotPrice <= domainMax && (
        <g pointerEvents="none">
          <circle className={spotDotClass(atSpot)} cx={xScale(spotPrice)} cy={pnlY(atSpot)} r="7" stroke="#fff" strokeWidth="2" />
          <circle className={spotDotClass(netAtSpot)} cx={xScale(spotPrice)} cy={netY(netAtSpot)} r="7" stroke="#fff" strokeWidth="2" />
        </g>
      )}
      {tip}
    </svg>
  );
}

// ---------- blueprint frame ----------

function Blueprint({ children, className = "", ...rest }) {
  return <div className={`blueprint ${className}`} {...rest}>{children}</div>;
}

// ---------- resizable table columns (spec §08a) ----------

// title feeds the native header tooltip (spec §06); numeric picks the sort
// comparison and the first-click direction (numbers start descending, text
// ascending — the finance default). The default widths fit the table in the
// right-hand third of a laptop screen.
const COLUMNS = [
  { key: "strike", label: "Strike", width: 56, numeric: true,
    title: "Option strike price" },
  { key: "type", label: "Type", width: 48, numeric: false,
    title: "PUT or CALL" },
  { key: "qty", label: "Qty", width: 50, numeric: true,
    title: "Signed position — negative is short, positive is long" },
  { key: "last", label: "Last", width: 54, numeric: true,
    title: "Bid–ask midpoint; falls back to the last trade when a quote is missing" },
  { key: "intrinsic", label: "Intrinsic", width: 78, numeric: true,
    title: "Value if exercised now — how far the option is in the money" },
  { key: "extrinsic", label: "Extrinsic", width: 78, numeric: true,
    title: "Time value — price minus intrinsic" },
  { key: "totalExtrinsic", label: "Total extrinsic", width: 78, numeric: true,
    title: "Extrinsic × contracts × contract multiplier; positive is premium collected (short leg), negative premium paid (long leg)" },
];

// The qty column shows r.position; every other key reads its own field.
const sortValue = (row, key) => (key === "qty" ? row.position : row[key]);

function sortLegRows(rows, sort) {
  if (!sort) return rows;
  const numeric = COLUMNS.find((c) => c.key === sort.key)?.numeric;
  const flip = sort.dir === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const cmp = numeric ? av - bv : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return cmp * flip;
  });
}

// A new key for the one-screen layout: widths saved for the old full-width
// table would overflow its narrow column, so they're left behind.
const COLUMN_WIDTHS_KEY = "options-analyzer:column-widths-v2";
const ROWS_KEY = "options-analyzer:rows";
// Kept in its own key rather than folded into the stored rows, so a position
// saved before this existed still loads — it just has no age to show.
const EXTRACTED_AT_KEY = "options-analyzer:extracted-at";
const MIN_COLUMN_WIDTH = 40;

const MANUAL_SPOTS_KEY = "options-analyzer:manual-spots";

function loadStoredSpots() {
  try {
    const stored = JSON.parse(localStorage.getItem(MANUAL_SPOTS_KEY));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    // Keep only usable prices; a corrupt entry would otherwise drive the whole
    // section's arithmetic.
    return Object.fromEntries(
      Object.entries(stored).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0)
    );
  } catch {
    return {};
  }
}

function loadStoredTimestamp() {
  try {
    const at = Number(localStorage.getItem(EXTRACTED_AT_KEY));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function formatAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Restore the last extracted position so a reload doesn't mean re-dropping the
// screenshot. Anything unreadable or not in the expected shape is discarded
// rather than fed into the math downstream.
function loadStoredRows() {
  try {
    const stored = JSON.parse(localStorage.getItem(ROWS_KEY));
    if (!Array.isArray(stored)) return [];
    return stored.filter((r) => r && typeof r.description === "string");
  } catch {
    return [];
  }
}

function useColumnWidths() {
  const [widths, setWidths] = useState(() => {
    const fallback = COLUMNS.map((c) => c.width);
    try {
      const stored = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY));
      return Array.isArray(stored) && stored.length === COLUMNS.length ? stored : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths));
  }, [widths]);

  const [activeIndex, setActiveIndex] = useState(null);

  // Pointer events with capture on the handle itself (spec §08a): mouse,
  // touch and pen all work, no window listeners, and a fast drag can't
  // escape the strip.
  const startResize = (index, e) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setActiveIndex(index);
    const startX = e.clientX;
    const startWidth = widths[index];
    const onMove = (ev) => {
      const next = Math.max(MIN_COLUMN_WIDTH, startWidth + ev.clientX - startX);
      setWidths((prev) => prev.map((w, i) => (i === index ? next : w)));
    };
    const onUp = () => {
      setActiveIndex(null);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return { widths, startResize, activeIndex };
}

// ---------- shell ----------

// Copy verbatim into each app — this list is identical everywhere. Never edit it per app.
const MODULES = [
  { name: "Options Analyzer",   url: "https://options-analyzer-production-24d8.up.railway.app/" },
  { name: "Earnings Tracker",   url: "https://earnings-tracker-production-2c77.up.railway.app/#/" },
  { name: "Custom Indexer",     url: "https://indexer-production-83a6.up.railway.app/#/" },
  { name: "Stock Screener",     url: "https://parabolic-screener-production.up.railway.app/" },
  { name: "PRE-earnings Drift", url: "https://pre-earnings-drift-production.up.railway.app/" },
  { name: "PEAD",               url: "https://pead-watchlist-e1a53.up.railway.app/" },
  { name: "Taiwan Screener",    url: "https://taiwan-revenue-screener-production.up.railway.app/#/" },
];

// The ONE line that differs per app:
const CURRENT_MODULE = "Options Analyzer";

// How old the position on screen is. Rows persist indefinitely, so without
// this a reading from days ago is indistinguishable from one taken a minute
// ago — and option prices make that difference matter. Lives in the top bar's
// otherwise-empty right side, which costs the content area no height.
function DataAge({ at }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (at == null) return;
    // A relative age that never re-renders would go stale on screen.
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [at]);

  if (at == null) return null;
  return (
    <span className="topbar__age" title={`Extracted ${new Date(at).toLocaleString()}`}>
      Read {formatAge(Date.now() - at)}
    </span>
  );
}

function TopBar({ extractedAt }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    // Escape closes AND returns focus to the button (spec §03).
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="topbar">
      {/* The brand mark links to THIS app's start page — never to a hub
          (there is none). */}
      <a className="topbar__brand" href="/" aria-label="NC Futures — start page">
        <img src="/logo.svg" alt="" />
      </a>
      <div className="topbar__modules" ref={wrapRef}>
        <button
          ref={triggerRef}
          className="btn topbar__modules-trigger"
          type="button"
          aria-expanded={open}
          aria-controls="modules-menu"
          onClick={() => setOpen((v) => !v)}
        >
          {CURRENT_MODULE} <span aria-hidden="true">▾</span>
        </button>
        {/* A disclosure, not an application menu: a plain list of links (no
            role="menu"), so no arrow-key handling is owed. */}
        <nav
          id="modules-menu"
          className="topbar__modules-menu blueprint blueprint--solid"
          aria-label="Modules"
          hidden={!open}
        >
          {MODULES.map((m) =>
            m.name === CURRENT_MODULE ? (
              <span key={m.name} className="topbar__modules-item" aria-current="page">
                {m.name}
              </span>
            ) : (
              <a
                key={m.name}
                className="topbar__modules-item"
                target="_blank"
                rel="noopener"
                href={m.url}
              >
                {m.name}
              </a>
            )
          )}
        </nav>
      </div>
      {/* The spec's right-hand slot (no account chip in this app). The model
          label reads the same constant the server sends to Anthropic. */}
      <div className="topbar__actions">
        <DataAge at={extractedAt} />
        <span className="topbar__model" title={`Screenshots are read by ${EXTRACT_MODEL}`}>
          AI model: {modelName(EXTRACT_MODEL)}
        </span>
      </div>
    </header>
  );
}

// Asks for the one number a cropped screenshot can't supply. Applied on submit
// or blur rather than per keystroke, so a half-typed "46" never renders a
// section priced at 46.
function SpotPrompt({ ticker, onSubmit }) {
  const [value, setValue] = useState("");
  // An entry that isn't a usable price used to be dropped in silence, leaving
  // the prompt sitting there as if nothing had been typed (spec §06 States).
  const [invalid, setInvalid] = useState(false);

  const apply = () => {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0) {
      setInvalid(false);
      onSubmit(ticker, price);
    } else {
      // An empty field is "not filled in yet", not a mistake.
      setInvalid(value.trim() !== "");
    }
  };

  return (
    <form
      className="spot-prompt blueprint blueprint--tint"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label htmlFor={`spot-${ticker}`}>
        {ticker}: no underlying price in this screenshot — include the {ticker} contract line above
        the options, or enter its price:
      </label>
      <input
        id={`spot-${ticker}`}
        className="input"
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 4655.3"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `spot-${ticker}-err` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          // Clear the flag as soon as they start fixing it.
          if (invalid) setInvalid(false);
        }}
        onBlur={apply}
      />
      {invalid && (
        <span id={`spot-${ticker}-err`} className="micro spot-prompt__error">
          Enter a price above zero, e.g. 4655.3
        </span>
      )}
    </form>
  );
}

// ---------- main ----------

// One summary figure, as the platform's KPI tile.
function Tile({ label, labelTone = "", tone = "", title, children }) {
  return (
    <Blueprint className="kpi">
      <p className={`kpi__label ${labelTone}`}>{label}</p>
      <p className={`kpi__figure ${tone}`} title={title}>
        {children}
      </p>
    </Blueprint>
  );
}

// Leg by leg: puts subtotal inline under the puts, calls and grand totals in
// the footer.
function LegTable({ view, columnWidths, startResize, activeColumn, sort, onSort }) {
  const { ticker, legRows, putsTotal, callsTotal, grandTotal } = view;

  const sortedRows = sortLegRows(legRows, sort);
  // The inline puts subtotal follows the puts wherever a sort puts them —
  // after the LAST put row, exactly once.
  const lastPutIndex = sortedRows.map((r) => r.type).lastIndexOf("PUT");
  // Option-price columns read in the symbol's own tick language: 64ths for
  // treasuries, decimals for everything else.
  const px = TICK32_TICKERS.has(ticker) ? fmt64 : (v) => fmtSigned(v.toFixed(2));

  return (
    <Blueprint className="screen__table">
      {/* .table-scroll is the scroll box (spec §08a): resized-wide tables
          scroll horizontally instead of spilling past the frame, and the
          header pins at the box's own top for long tables. */}
      <div className="table-scroll">
      <table
        className="table"
        style={{ tableLayout: "fixed", width: `max(100%, ${columnWidths.reduce((a, b) => a + b, 0)}px)` }}
      >
        <colgroup>
          {columnWidths.map((w, i) => (
            <col key={COLUMNS[i].key} style={{ width: `${w}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((c, i) => (
              <th
                key={c.key}
                className={`sortable${c.key === "type" ? " text" : ""}`}
                aria-sort={sort?.key === c.key ? sort.dir : undefined}
              >
                {/* Header text in a button so Tab reaches it and Enter or
                    Space sorts; the native title is the column's tooltip. */}
                <button className="th-sort" type="button" title={c.title} onClick={() => onSort(c.key)}>
                  {c.label}
                </button>
                <span
                  className={`th-resize${activeColumn === i ? " is-dragging" : ""}`}
                  onPointerDown={(e) => startResize(i, e)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r, i) => (
            <Fragment key={`${r.type}-${r.strike}-${r.position}`}>
              <tr className={r.type === "PUT" ? "row-put" : "row-call"}>
                <td>{r.strike}</td>
                <td className="text">{r.type}</td>
                <td>{fmtSigned(r.position)}</td>
                <td>{px(r.last)}</td>
                <td>{px(r.intrinsic)}</td>
                <td>{px(r.extrinsic)}</td>
                <td className={signClass(r.totalExtrinsic)}>{fmtMoney(r.totalExtrinsic)}</td>
              </tr>
              {/* Puts subtotal sits with the puts rather than in the footer;
                  the calls subtotal already falls directly under the calls. */}
              {i === lastPutIndex && (
                <tr className="table-subtotal">
                  <td colSpan={6} className={signClass(putsTotal)}>Puts total extrinsic</td>
                  <td className={signClass(putsTotal)}>{fmtMoney(putsTotal)}</td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={6} className={signClass(callsTotal)}>Calls total extrinsic</td><td className={signClass(callsTotal)}>{fmtMoney(callsTotal)}</td></tr>
          <tr><td colSpan={6} className={signClass(grandTotal)}>Total extrinsic</td><td className={signClass(grandTotal)}>{fmtMoney(grandTotal)}</td></tr>
        </tfoot>
      </table>
      </div>
    </Blueprint>
  );
}

// One symbol on one screen: the chart fills the left two-thirds; every figure
// and the leg table sit in the right third. The chart panel doubles as the
// drop target, so a new screenshot can go straight onto it.
function PositionScreen({ view, tableProps, dragOver, onDragOver, onDragLeave, onDrop, ...rest }) {
  const { ticker, spotPrice, spotIsTyped, putsTotal, callsTotal, grandTotal, pnl, netAtSpot } = view;
  const { maxProfit, maxLoss, breakEvens } = pnl;

  return (
    <section className="screen" {...rest}>
      <Blueprint
        className={`screen__chart${dragOver ? " blueprint--drop" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <ChartHead pnl={pnl} />
        <ChartBox>{({ width, height }) => <PositionChart view={view} width={width} height={height} />}</ChartBox>
      </Blueprint>

      <div className="screen__data">
        <div className="kpi-grid">
          {/* Flagged when typed, so an entered price is never mistaken for
              one read off the screenshot. */}
          <Tile
            label={
              <a
                className="symbol"
                href={`https://www.tradingview.com/chart/3Ojf0qKU/?symbol=${encodeURIComponent(tvSymbol(ticker))}`}
                target="_blank"
                rel="noopener"
              >
                {ticker}
              </a>
            }
            title={spotIsTyped ? "Price you entered, not read from the screenshot" : undefined}
          >
            {fmtPrice(spotPrice, ticker)}
            {spotIsTyped && <span className="kpi__figure-note"> (entered)</span>}
          </Tile>
          <Tile label="Net position at spot" tone={signClass(netAtSpot)}>
            {fmtMoney(netAtSpot)}
          </Tile>
          {/* A line that runs off forever past the top strike has no maximum,
              and a position that can't win (or can't lose) has none to show
              either. */}
          <Tile label="Max profit" tone={signClass(Math.max(maxProfit, 0))}>
            {maxProfit === Infinity ? "Unlimited" : maxProfit > 0 ? fmtMoney(maxProfit) : "None"}
          </Tile>
          <Tile label="Max loss" tone={signClass(Math.min(maxLoss, 0))}>
            {maxLoss === -Infinity ? "Unlimited" : maxLoss < 0 ? fmtMoney(maxLoss) : "None"}
          </Tile>
          <Tile label="Break-even">
            {breakEvens.length ? breakEvens.map((b) => fmtLevel(b, ticker)).join(" · ") : "None"}
          </Tile>
          {/* The three extrinsic totals differ only in label and value. */}
          {[
            ["Total extrinsic", grandTotal],
            ["Puts total extrinsic", putsTotal],
            ["Calls total extrinsic", callsTotal],
          ].map(([label, total]) => (
            <Tile key={label} label={label} labelTone={signClass(total)} tone={signClass(total)}>
              {fmtMoney(total)}
            </Tile>
          ))}
        </div>
        <LegTable view={view} {...tableProps} />
      </div>
    </section>
  );
}

// One tab per symbol, so a screenshot holding several still fits one screen.
// Arrow keys, Home and End move along the row — the keyboard contract a tab
// list owes — and only the selected tab sits in the Tab order.
function SymbolTabs({ tickers, active, onSelect }) {
  const tabRefs = useRef([]);
  const onKeyDown = (e, i) => {
    const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tickers.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = (moves[e.key] + tickers.length) % tickers.length;
    onSelect(tickers[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label="Symbols">
      {tickers.map((t, i) => (
        <button
          key={t}
          ref={(el) => { tabRefs.current[i] = el; }}
          id={`tab-${t}`}
          className="tab"
          type="button"
          role="tab"
          aria-selected={t === active}
          aria-controls="symbol-panel"
          tabIndex={t === active ? 0 : -1}
          onClick={() => onSelect(t)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// Only used to combine several images dropped together — a new drop always
// starts from scratch, so rows from an earlier screenshot never linger.
function mergeRows(prev, incoming) {
  const map = new Map(prev.map((r) => [r.description, r]));
  for (const r of incoming) map.set(r.description, r);
  return Array.from(map.values());
}

export default function OptionsPositionAnalyzer() {
  const [rawRows, setRawRows] = useState(loadStoredRows);
  const [extractedAt, setExtractedAt] = useState(loadStoredTimestamp);
  const [manualSpots, setManualSpots] = useState(loadStoredSpots);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The images behind the last failed read, so the error state's Retry can
  // re-run them without another drop.
  const [retryFiles, setRetryFiles] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // One sort for every section's table, like the shared column widths.
  const [sort, setSort] = useState(null);
  // The symbol tab picked; until one is, the first symbol shows.
  const [activeTicker, setActiveTicker] = useState(null);
  const inputRef = useRef(null);
  const { widths: columnWidths, startResize, activeIndex: activeColumn } = useColumnWidths();

  // First click sorts a numeric column descending (biggest first) and a text
  // column ascending; clicking the same header again flips it.
  const toggleSort = useCallback((key) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return { key, dir: prev.dir === "descending" ? "ascending" : "descending" };
      }
      const numeric = COLUMNS.find((c) => c.key === key)?.numeric;
      return { key, dir: numeric ? "descending" : "ascending" };
    });
  }, []);

  const handleFiles = useCallback(async (files) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      // Nothing was attempted, so there is nothing for Retry to redo.
      setRetryFiles(null);
      setError(
        "No image file found in that drop. Make sure you're dragging a saved screenshot file (not an image from inside a webpage or chat window) — or copy the screenshot and paste it here with Ctrl/Cmd+V."
      );
      return;
    }
    setLoading(true);
    setError("");
    try {
      // The first image replaces whatever was on screen; any further images in
      // the same drop merge into it.
      let extracted = 0;
      for (const [i, file] of images.entries()) {
        const base64 = await fileToBase64(file);
        const rows = await extractRows(base64, file.type || "image/png");
        extracted += rows.length;
        setRawRows(i === 0 ? rows : (prev) => mergeRows(prev, rows));
      }
      // Stamped only on a fresh read, never on a restore from storage — the
      // point is how old the prices are, not when the page was opened.
      setExtractedAt(Date.now());
      // A successful call that yields nothing used to leave the dropzone sitting
      // there with no message, which reads as "the drop didn't register".
      if (extracted === 0) {
        setRetryFiles(images);
        setError(
          "Read that screenshot, but found no position rows in it. Check the table is fully visible — including the Position column — and that at least one row has a position."
        );
      } else {
        setRetryFiles(null);
      }
    } catch (e) {
      setRetryFiles(images);
      // Only the "model couldn't parse the image" case is actually about crop
      // quality. Everything else — a bad key, a rate limit, an oversized image —
      // has a real reason from the server, and hiding it behind crop advice
      // sends you chasing the wrong problem.
      const detail = String(e?.message || "").trim();
      setError(
        /valid JSON/i.test(detail)
          ? "Couldn't read that screenshot — try a clearer crop, or one that includes the column headers."
          : `Couldn't read that screenshot — ${detail || "the request failed."}`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(Array.from(e.dataTransfer.files));
  };
  const onSelect = (e) => {
    handleFiles(Array.from(e.target.files));
    e.target.value = "";
  };
  const onPaste = useCallback(
    (e) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    },
    [handleFiles]
  );

  useEffect(() => {
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onPaste]);

  useEffect(() => {
    try {
      localStorage.setItem(ROWS_KEY, JSON.stringify(rawRows));
      localStorage.setItem(MANUAL_SPOTS_KEY, JSON.stringify(manualSpots));
      if (extractedAt != null) localStorage.setItem(EXTRACTED_AT_KEY, String(extractedAt));
    } catch {
      /* storage full or unavailable (private mode) — persistence is a nicety */
    }
  }, [rawRows, extractedAt, manualSpots]);

  const setSpot = useCallback((ticker, price) => {
    setManualSpots((prev) => ({ ...prev, [ticker]: price }));
  }, []);

  const symbolViews = buildSymbolViews(rawRows, manualSpots);
  const readyViews = symbolViews.filter((v) => v.ready);
  // The symbol on screen: the tab picked, or the first when that one is gone.
  const activeView = readyViews.find((v) => v.ticker === activeTicker) ?? readyViews[0];

  const hasData = rawRows.length > 0;
  const showResults = readyViews.length > 0;
  const tabbed = readyViews.length > 1;

  // Symbols missing only a spot get an input; anything else gets named. With
  // one symbol that's the whole story; with several it flags the odd one out
  // while the rest still render.
  const awaitingSpot = symbolViews.filter((v) => v.needsSpot);
  const skipped = symbolViews.filter((v) => v.issue).map((v) => v.issue);
  const loadIssue = !hasData || skipped.length === 0 ? null : `Read the screenshot. ${skipped.join(" ")}`;

  // One look for every failure (spec §06 States): a framed line, not red —
  // red is for losses — plus Retry when there is a read to redo. A symbol
  // still waiting on its spot asks for it underneath.
  const notices = (
    <>
      {error ? (
        <div className="blueprint state">
          <span className="micro">{error}</span>
          {retryFiles && (
            <button className="btn" type="button" onClick={() => handleFiles(retryFiles)}>
              Retry
            </button>
          )}
        </div>
      ) : (
        loadIssue && (
          <div className="blueprint state">
            <span className="micro">{loadIssue}</span>
          </div>
        )
      )}

      {!error &&
        awaitingSpot.map((v) => <SpotPrompt key={v.ticker} ticker={v.ticker} onSubmit={setSpot} />)}
    </>
  );

  return (
    <>
      <TopBar extractedAt={hasData ? extractedAt : null} />
      <div className="content">
      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onSelect} />

      {/* Results fill exactly one screen. Whatever has to show with them — a
          notice, the symbol tabs, "Reading…" — takes its row out of the chart
          and table rather than pushing them past the bottom edge. With nothing
          to show, including rows that loaded but weren't usable, the
          standalone dropzone takes the screen instead. */}
      {showResults ? (
        <div className="screen-wrap">
          {notices}
          {/* No toolbar in the resting state — screenshots come in by drop or
              paste. The row is there for the symbol tabs, and while a drop is
              being read, so there's still feedback during the wait. */}
          {(tabbed || loading) && (
            <div className="screen-bar">
              {tabbed && (
                <SymbolTabs
                  tickers={readyViews.map((v) => v.ticker)}
                  active={activeView.ticker}
                  onSelect={setActiveTicker}
                />
              )}
              {loading && <span className="micro screen-bar__status">Reading…</span>}
            </div>
          )}
          <PositionScreen
            view={activeView}
            {...(tabbed && { id: "symbol-panel", role: "tabpanel", "aria-labelledby": `tab-${activeView.ticker}` })}
            tableProps={{ columnWidths, startResize, activeColumn, sort, onSort: toggleSort }}
            dragOver={dragOver}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          />
        </div>
      ) : (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current.click()}
            className={`dropzone ${dragOver ? "is-dragover" : ""}`}
          >
            {loading ? (
              <span className="micro">Reading screenshot…</span>
            ) : (
              <div>
                <Upload size={22} className="dropzone__icon" />
                <p className="dropzone__title">Drop, paste (Ctrl/Cmd+V), or click to add an IBKR position screenshot</p>
                <p className="dropzone__subtitle">Include the column headers for best accuracy</p>
              </div>
            )}
          </div>
          {notices}
        </>
      )}
      </div>
    </>
  );
}
