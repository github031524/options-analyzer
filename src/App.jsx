import { useState, useCallback, useRef, useEffect, Fragment } from "react";
import { Upload, Loader2 } from "lucide-react";

const ACCENT = "#5980a6";
const ACCENT_TINT = "#dbe4ee";
const ACCENT_TEXT = "#32485e";
const HAIRLINE = "#c9cacc";
const LOSS = "#a6595e";

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
  return data;
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

// Price at which the delta-weighted position nets to zero. Each leg's vol is
// backed out once at the current spot and then held fixed while the price is
// varied (the standard sticky-vol assumption) — so this is a snapshot, and it
// drifts toward the step curve's crossing as expiry approaches.
function deltaNeutralPrice(legs, baselineShift, sharesPerContract, spot) {
  if (!(spot > 0) || legs.length === 0) return null;
  const now = Date.now();
  const priced = legs.map((leg) => {
    const T = leg.expiry != null ? (leg.expiry - now) / (365.25 * 24 * 3600 * 1000) : 0;
    return { ...leg, T, iv: impliedVol(leg.type, spot, leg.strike, T, leg.last) };
  });
  // Every leg expired (or none dated) means the step curve already is the answer.
  if (priced.every((l) => !(l.T > 0) || l.iv == null)) return null;

  const netDelta = (F) =>
    baselineShift +
    priced.reduce((sum, l) => sum + l.position * black76Delta(l.type, F, l.strike, l.T, l.iv) * sharesPerContract, 0);

  const strikes = legs.map((l) => l.strike);
  let lo = Math.min(...strikes) * 0.5;
  let hi = Math.max(...strikes) * 1.5;
  let fLo = netDelta(lo), fHi = netDelta(hi);

  // Far from the strikes every option delta underflows toward zero, so a
  // near-zero value at a bracket edge is the tail flattening out, not a
  // crossing. Without this a position that never actually crosses — short puts
  // and nothing else, whose net delta stays positive and only decays — would
  // report the bracket edge itself as its neutral price.
  const size = legs.reduce((s, l) => s + Math.abs(l.position), 0) * sharesPerContract;
  const eps = Math.max(size * 1e-4, 1e-9);
  if (Math.abs(fLo) < eps || Math.abs(fHi) < eps) return null;
  if (fLo > 0 === fHi > 0) return null; // no crossing in range

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = netDelta(mid);
    if (fMid === 0) return mid;
    if (fLo > 0 === fMid > 0) { lo = mid; fLo = fMid; } else { hi = mid; fHi = fMid; }
  }
  return (lo + hi) / 2;
}

// ---------- per-symbol grouping ----------

// A screenshot can hold several symbols, each with its own underlying row and
// its own legs. Everything downstream (spot, multiplier, curve, totals) is
// per-symbol, so split first and compute each group independently — a strike is
// only meaningful against its own underlying's price.
function buildSymbolViews(rawRows) {
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
    const underlyingRow = rows.find((r) => !parseLeg(r.description));
    const price = underlyingRow ? Number(underlyingRow.last) : NaN;
    // A price that won't parse is as unusable as a missing row, and letting NaN
    // through would render every figure in the section as NaN.
    const stockPrice = Number.isFinite(price) ? price : null;
    const baselineShift =
      underlyingRow && underlyingRow.position !== null && underlyingRow.position !== ""
        ? Number(underlyingRow.position) || 0
        : 0;
    const { dollarMultiplier, sharesPerContract } = contractSpec(ticker);

    const legRows =
      stockPrice == null
        ? []
        : rows
            .map((r) => {
              const leg = parseLeg(r.description);
              if (!leg) return null;
              const position = Number(r.position);
              const last = midOrLast(r);
              if (!Number.isFinite(position) || !Number.isFinite(last)) return null;
              const intrinsic =
                leg.type === "PUT" ? Math.max(leg.strike - stockPrice, 0) : Math.max(stockPrice - leg.strike, 0);
              const extrinsic = last - intrinsic;
              return {
                ...leg,
                position,
                last,
                intrinsic,
                extrinsic,
                totalExtrinsic: extrinsic * Math.abs(position) * dollarMultiplier,
              };
            })
            .filter(Boolean)
            .sort((a, b) => (a.type === b.type ? a.strike - b.strike : a.type === "PUT" ? -1 : 1));

    const putsTotal = legRows.filter((r) => r.type === "PUT").reduce((s, r) => s + r.totalExtrinsic, 0);
    const callsTotal = legRows.filter((r) => r.type === "CALL").reduce((s, r) => s + r.totalExtrinsic, 0);
    const ready = stockPrice != null && legRows.length > 0;

    return {
      ticker,
      stockPrice,
      legRows,
      putsTotal,
      callsTotal,
      grandTotal: putsTotal + callsTotal,
      curve: ready ? buildCurve(legRows, baselineShift, sharesPerContract) : null,
      netAtSpot: ready ? netPositionAt(legRows, baselineShift, stockPrice, sharesPerContract) : null,
      neutralPrice: ready ? deltaNeutralPrice(legRows, baselineShift, sharesPerContract, stockPrice) : null,
      ready,
      issue: ready
        ? null
        : stockPrice == null
          ? `${ticker}: couldn't read the underlying row — the ticker and price line above the options (e.g. "NQ Sep18'26 @CME"). Its price is what every strike is measured against; check nothing is covering it.`
          : `${ticker}: no option rows with a position.`,
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

function buildCurve(legs, baselineShift, sharesPerContract) {
  if (legs.length === 0) return null;
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const minK = strikes[0];
  const maxK = strikes[strikes.length - 1];
  const pad = strikes.length > 1 ? (maxK - minK) * 0.15 : Math.max(minK * 0.05, 5);
  const domainMin = minK - pad;
  const domainMax = maxK + pad;
  const xs = [domainMin, ...strikes, domainMax];

  const segments = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2;
    segments.push({ x0: xs[i], x1: xs[i + 1], y: netPositionAt(legs, baselineShift, mid, sharesPerContract) });
  }
  return { segments, domainMin, domainMax, strikes };
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString()}`;
}

function signClass(n) {
  if (n > 0) return "gain";
  if (n < 0) return "loss";
  return "kpi__figure--accent";
}

function fmtShort(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return abs >= 1000 ? `${sign}${Math.round(abs / 1000)}K` : `${sign}${Math.round(abs)}`;
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

function StepChart({ curve, ticker, neutralPrice, spotPrice, spotNet }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  if (!curve) return null;
  const { segments, domainMin, domainMax, strikes } = curve;
  const W = 1500, H = 230;
  // Bottom margin carries the strike labels plus a band under the plot floor
  // for negative steps' value labels, which sit below their own step.
  const mL = 60, mR = 20, mT = 16, mB = 46;
  const strikeLabelY = H - mB + 32;
  const plotW = W - mL - mR;
  const plotH = H - mT - mB;

  // Size each side of zero independently — a position that never goes negative
  // shouldn't spend half the chart on an empty negative half. Zero always stays
  // on the axis (it's the reference the whole chart is about), just not forced
  // to the middle.
  const values = segments.map((s) => s.y);
  const dataMax = Math.max(0, ...values);
  const dataMin = Math.min(0, ...values);
  let yMax = dataMax > 0 ? niceCeil(dataMax) : 0;
  let yMin = dataMin < 0 ? -niceCeil(-dataMin) : 0;
  if (yMax === yMin) { yMax = 1; yMin = -1; }  // curve is flat on zero

  const xScale = (p) => mL + ((p - domainMin) / (domainMax - domainMin)) * plotW;
  const priceAt = (x) => domainMin + ((x - mL) / plotW) * (domainMax - domainMin);
  const yScale = (v) => mT + ((yMax - v) / (yMax - yMin)) * plotH;
  const zeroY = yScale(0);
  const segmentAt = (price) => segments.find((s) => price >= s.x0 && price <= s.x1) || segments[segments.length - 1];

  let line = "";
  segments.forEach((s, i) => {
    const x0 = xScale(s.x0), x1 = xScale(s.x1), y = yScale(s.y);
    line += (i === 0 ? `M${x0},${y} ` : `L${x0},${y} `) + `L${x1},${y} `;
  });

  let area = `M${xScale(segments[0].x0)},${zeroY} `;
  segments.forEach((s) => {
    const x0 = xScale(s.x0), x1 = xScale(s.x1), y = yScale(s.y);
    area += `L${x0},${y} L${x1},${y} `;
  });
  area += `L${xScale(segments[segments.length - 1].x1)},${zeroY} Z`;

  const handleMove = (e) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    const x = Math.min(Math.max(loc.x, mL), W - mR);
    const price = priceAt(x);
    setHover({ x, price, netPosition: segmentAt(price).y });
  };
  const handleLeave = () => setHover(null);

  let tip = null;
  if (hover) {
    const tipW = 122, tipH = 40;
    const tipX = hover.x + 10 + tipW > W - mR ? hover.x - 10 - tipW : hover.x + 10;
    const tipY = mT + 4;
    tip = (
      <g pointerEvents="none">
        <line x1={hover.x} y1={mT} x2={hover.x} y2={H - mB} stroke={ACCENT} strokeWidth="1" strokeDasharray="3 3" />
        <circle cx={hover.x} cy={yScale(hover.netPosition)} r="3.5" fill={ACCENT} stroke="#fff" strokeWidth="1.5" />
        <rect x={tipX} y={tipY} width={tipW} height={tipH} rx="3" fill="#fff" stroke={HAIRLINE} strokeWidth="1" />
        <text x={tipX + 8} y={tipY + 16} fontSize="10.5" fontWeight="600" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">
          {hover.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </text>
        <text x={tipX + 8} y={tipY + 30} fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">
          {fmtMoney(hover.netPosition)}
        </text>
      </g>
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Step chart of net underlying position for ${ticker} across strike prices, ranging from ${fmtShort(yMin)} to ${fmtShort(yMax)} shares`}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ cursor: "crosshair" }}
    >
      {strikes.map((k) => (
        <line key={k} x1={xScale(k)} y1={mT} x2={xScale(k)} y2={H - mB} stroke={HAIRLINE} strokeWidth="1" />
      ))}
      <line x1={mL} y1={zeroY} x2={W - mR} y2={zeroY} stroke={ACCENT_TEXT} strokeWidth="1.75" />
      <path d={area} fill={ACCENT_TINT} />
      <path d={line} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinejoin="miter" />
      {yMax !== 0 && (
        <text x={mL - 10} y={yScale(yMax) + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(yMax)}</text>
      )}
      <text x={mL - 10} y={zeroY + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">0</text>
      {yMin !== 0 && (
        <text x={mL - 10} y={yScale(yMin) + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(yMin)}</text>
      )}
      {strikes.map((k) => (
        <text key={k} x={xScale(k)} y={strikeLabelY} textAnchor="middle" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{k}</text>
      ))}
      {/* Net position value for each step, centered above its own segment. */}
      {segments.map((s, i) => (
        <text
          key={`v${i}`}
          x={(xScale(s.x0) + xScale(s.x1)) / 2}
          y={s.y < 0 ? yScale(s.y) + 15 : yScale(s.y) - 6}
          textAnchor="middle"
          fontSize="10.5"
          fill={ACCENT_TEXT}
          fontFamily="Inter, sans-serif"
        >
          {fmtMoney(s.y)}
        </text>
      ))}
      {neutralPrice != null && neutralPrice >= domainMin && neutralPrice <= domainMax && (
        <g pointerEvents="none">
          <line
            x1={xScale(neutralPrice)} y1={mT} x2={xScale(neutralPrice)} y2={H - mB}
            stroke={ACCENT} strokeWidth="1.25" strokeDasharray="4 3"
          />
          <text
            x={xScale(neutralPrice)} y={mT - 4}
            textAnchor="middle" fontSize="10.5" fill={ACCENT} fontFamily="Inter, sans-serif"
          >
            {`Δ0 ${neutralPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          </text>
        </g>
      )}
      {/* Current spot, sitting on the step at its net position — drawn after the
          Δ0 marker so it stays legible on top when the two nearly coincide.
          Filled from the gain/loss tokens via CSS so it always matches the
          "net position at spot" tile rather than drifting from it. */}
      {spotPrice != null && spotNet != null && spotPrice >= domainMin && spotPrice <= domainMax && (
        <circle
          className={`spot-dot ${spotNet > 0 ? "spot-dot--gain" : spotNet < 0 ? "spot-dot--loss" : ""}`}
          cx={xScale(spotPrice)} cy={yScale(spotNet)} r="7"
          stroke="#fff" strokeWidth="2" pointerEvents="none"
        />
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

const COLUMNS = [
  { key: "strike", label: "Strike", width: 110 },
  { key: "type", label: "Type", width: 110 },
  { key: "qty", label: "Qty", width: 110 },
  { key: "last", label: "Last", width: 130 },
  { key: "intrinsic", label: "Intrinsic", width: 150 },
  { key: "extrinsic", label: "Extrinsic", width: 150 },
  { key: "totalExtrinsic", label: "Total extrinsic", width: 190 },
];

const COLUMN_WIDTHS_KEY = "options-analyzer:column-widths";
const ROWS_KEY = "options-analyzer:rows";
const MIN_COLUMN_WIDTH = 40;

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

  const startResize = (index, e) => {
    e.preventDefault();
    setActiveIndex(index);
    const startX = e.clientX;
    const startWidth = widths[index];
    const onMove = (ev) => {
      const next = Math.max(MIN_COLUMN_WIDTH, startWidth + ev.clientX - startX);
      setWidths((prev) => prev.map((w, i) => (i === index ? next : w)));
    };
    const onUp = () => {
      setActiveIndex(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return { widths, startResize, activeIndex };
}

// ---------- shell ----------

// Copied constant, not fetched — there is no shared backend (spec §04b).
const MODULES = [
  { name: "Options Analyzer", url: "https://options-analyzer-production-24d8.up.railway.app/", current: true },
  { name: "Earnings Tracker", url: "https://earnings-tracker-production-2c77.up.railway.app/#/" },
  { name: "Custom Indexer", url: "https://indexer-production-83a6.up.railway.app/#/" },
  { name: "Stock Screener", url: "https://parabolic-screener-production.up.railway.app/" },
  { name: "Stock Dashboard", url: "https://stock-dashboard-server-production-6c1c.up.railway.app/" },
  { name: "PEAD", url: "https://pead-watchlist-e1a53.up.railway.app/" },
  { name: "AI Screener", url: "https://nc-futures-screener-server-production.up.railway.app/" },
];

const CURRENT_MODULE = MODULES.find((m) => m.current);

function TopBar() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
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
      <span className="topbar__brand">
        <img src="/logo.svg" alt="NC Futures" />
      </span>
      <div className="topbar__modules" ref={wrapRef}>
        <button
          className="btn topbar__modules-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {CURRENT_MODULE.name} ▾
        </button>
        <div className="topbar__modules-menu blueprint blueprint--solid" role="menu" hidden={!open}>
          {MODULES.map((m) =>
            m.current ? (
              <span key={m.name} className="topbar__modules-item" role="menuitem" aria-current="page">
                {m.name}
              </span>
            ) : (
              <a
                key={m.name}
                className="topbar__modules-item"
                role="menuitem"
                target="_blank"
                rel="noopener"
                href={m.url}
              >
                {m.name}
              </a>
            )
          )}
        </div>
      </div>
    </header>
  );
}

// ---------- main ----------

// One symbol's block: its KPI row, its chart, its table. The chart panel is a
// drop target like the others, so a screenshot can be dropped anywhere.
function PositionSection({ view, columnWidths, startResize, activeColumn, dragOver, onDragOver, onDragLeave, onDrop }) {
  const { ticker, stockPrice, legRows, putsTotal, callsTotal, grandTotal, curve, netAtSpot, neutralPrice } = view;

  return (
    <section className="symbol-block">
      <div className="app-kpis">
        <Blueprint>
          <div className="kpi">
            <p className="kpi__label kpi__label--lead">
              <a
                className="symbol"
                href={`https://www.tradingview.com/chart/3Ojf0qKU/?symbol=${ticker.toLowerCase()}`}
                target="_blank"
                rel="noopener"
              >
                {ticker}
              </a>
            </p>
            <p className="kpi__figure">{stockPrice.toLocaleString()}</p>
          </div>
        </Blueprint>
        <Blueprint>
          <div className="kpi">
            <p className="kpi__label">Net position at spot</p>
            <p className={`kpi__figure ${signClass(netAtSpot)}`}>{fmtMoney(netAtSpot)}</p>
          </div>
        </Blueprint>
        <Blueprint>
          <div className="kpi">
            <p className={`kpi__label ${signClass(putsTotal)}`}>Puts total extrinsic</p>
            <p className={`kpi__figure ${signClass(putsTotal)}`}>{fmtMoney(putsTotal)}</p>
          </div>
        </Blueprint>
        <Blueprint>
          <div className="kpi">
            <p className={`kpi__label ${signClass(callsTotal)}`}>Calls total extrinsic</p>
            <p className={`kpi__figure ${signClass(callsTotal)}`}>{fmtMoney(callsTotal)}</p>
          </div>
        </Blueprint>
        <Blueprint>
          <div className="kpi">
            <p className={`kpi__label ${signClass(grandTotal)}`}>Total extrinsic</p>
            <p className={`kpi__figure ${signClass(grandTotal)}`}>{fmtMoney(grandTotal)}</p>
          </div>
        </Blueprint>
      </div>

      <Blueprint
        className={dragOver ? "blueprint--drop" : ""}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <StepChart
          curve={curve}
          ticker={ticker}
          neutralPrice={neutralPrice}
          spotPrice={stockPrice}
          spotNet={netAtSpot}
        />
      </Blueprint>

      <Blueprint>
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
                <th key={c.key} className={`is-resizable${c.key === "type" ? " text" : ""}`}>
                  {c.label}
                  <span
                    className={`resize-handle${activeColumn === i ? " resize-handle--active" : ""}`}
                    onMouseDown={(e) => startResize(i, e)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {legRows.map((r, i) => (
              <Fragment key={i}>
                <tr className={r.type === "PUT" ? "row-put" : "row-call"}>
                  <td>{r.strike}</td>
                  <td className="text">{r.type}</td>
                  <td>{r.position}</td>
                  <td>{r.last.toFixed(2)}</td>
                  <td>{r.intrinsic.toFixed(2)}</td>
                  <td>{r.extrinsic.toFixed(2)}</td>
                  <td className={signClass(r.totalExtrinsic)}>{fmtMoney(r.totalExtrinsic)}</td>
                </tr>
                {/* Puts subtotal sits with the puts rather than in the footer;
                    the calls subtotal already falls directly under the calls. */}
                {r.type === "PUT" && legRows[i + 1]?.type !== "PUT" && (
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
      </Blueprint>
    </section>
  );
}

export default function OptionsPositionAnalyzer() {
  const [rawRows, setRawRows] = useState(loadStoredRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const { widths: columnWidths, startResize, activeIndex: activeColumn } = useColumnWidths();

  // Only used to combine several images dropped together — a new drop always
  // starts from scratch, so rows from an earlier screenshot never linger.
  const mergeRows = (prev, incoming) => {
    const map = new Map(prev.map((r) => [r.description, r]));
    for (const r of incoming) map.set(r.description, r);
    return Array.from(map.values());
  };

  const handleFiles = useCallback(async (files) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      setError(
        "No image file found in that drop. Make sure you're dragging a saved screenshot file (not an image from inside a webpage or chat window) — or copy the screenshot and paste it here with Ctrl/Cmd+V."
      );
      return;
    }
    setLoading(true);
    setError("");
    try {
      let replaced = false;
      for (const file of images) {
        const base64 = await fileToBase64(file);
        const rows = await extractRows(base64, file.type || "image/png");
        if (replaced) {
          setRawRows((prev) => mergeRows(prev, rows));
        } else {
          setRawRows(rows);
          replaced = true;
        }
      }
    } catch (e) {
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
    } catch {
      /* storage full or unavailable (private mode) — persistence is a nicety */
    }
  }, [rawRows]);

  const symbolViews = buildSymbolViews(rawRows);
  const readyViews = symbolViews.filter((v) => v.ready);

  const hasData = rawRows.length > 0;
  const showResults = readyViews.length > 0;

  // Name every symbol that couldn't be drawn. With one symbol that's the whole
  // story; with several it flags the odd one out while the rest still render.
  const skipped = symbolViews.filter((v) => !v.ready).map((v) => v.issue);
  const loadIssue = !hasData || skipped.length === 0 ? null : `Read the screenshot. ${skipped.join(" ")}`;

  return (
    <>
      <TopBar />
      <div className="content">
      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onSelect} />

      {/* Once results are on screen the chart panel becomes the drop target, so
          the standalone dropzone is only needed when there's nothing to show —
          including the case where rows loaded but weren't usable. */}
      {!showResults && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current.click()}
          className={`dropzone ${dragOver ? "dropzone--active" : ""}`}
        >
          {loading ? (
            <div className="dropzone__loading">
              <Loader2 size={16} className="spin" /> Reading screenshot…
            </div>
          ) : (
            <div>
              <Upload size={22} className="dropzone__icon" />
              <p className="dropzone__title">Drop, paste (Ctrl/Cmd+V), or click to add an IBKR position screenshot</p>
              <p className="dropzone__subtitle">Include the column headers for best accuracy</p>
            </div>
          )}
        </div>
      )}

      {error ? <p className="app-error">{error}</p> : loadIssue && <p className="app-error">{loadIssue}</p>}

      {showResults && (
        <>
          {/* One action for the page rather than one per symbol — with several
              sections a button in each chart panel just repeats itself. */}
          {/* No toolbar in the resting state — screenshots come in by drop or
              paste. The row only appears while a drop is being read, so there's
              still feedback during the wait without costing a row otherwise. */}
          {loading && (
            <div className="panel-head">
              <span className="dropzone__loading"><Loader2 size={12} className="spin" /> Reading…</span>
            </div>
          )}

          {readyViews.map((view) => (
            <PositionSection
              key={view.ticker}
              view={view}
              columnWidths={columnWidths}
              startResize={startResize}
              activeColumn={activeColumn}
              dragOver={dragOver}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            />
          ))}
        </>
      )}
      </div>
    </>
  );
}
