import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, Loader2, Trash2, Plus } from "lucide-react";

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
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || "Extraction failed");
  }
  return data;
}

// ---------- parsing & math ----------

function parseLeg(description) {
  const match = (description || "").match(/(\d+(?:\.\d+)?)\s*(PUT|CALL)/i);
  if (!match) return null;
  return {
    ticker: description.trim().split(/\s+/)[0],
    strike: parseFloat(match[1]),
    type: match[2].toUpperCase(),
  };
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

// Smallest "nice" number (1/2/5 x a power of ten) at or above value, so the
// chart's y-axis scales to the data instead of a fixed step that can make
// small positions look visually flat.
function niceCeil(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

// ---------- chart ----------

function StepChart({ curve, ticker }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  if (!curve) return null;
  const { segments, domainMin, domainMax, strikes } = curve;
  const W = 1500, H = 230;
  const mL = 60, mR = 20, mT = 16, mB = 32;
  const plotW = W - mL - mR;
  const plotH = H - mT - mB;

  const maxAbs = Math.max(1, ...segments.map((s) => Math.abs(s.y)));
  const niceMax = niceCeil(maxAbs);

  const xScale = (p) => mL + ((p - domainMin) / (domainMax - domainMin)) * plotW;
  const priceAt = (x) => domainMin + ((x - mL) / plotW) * (domainMax - domainMin);
  const yScale = (v) => mT + ((niceMax - v) / (niceMax * 2)) * plotH;
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
      aria-label={`Step chart of net underlying position for ${ticker} across strike prices, ranging from ${fmtShort(-niceMax)} to ${fmtShort(niceMax)} shares`}
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
      <text x={mL - 10} y={mT + 10} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(niceMax)}</text>
      <text x={mL - 10} y={zeroY + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">0</text>
      <text x={mL - 10} y={H - mB + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(-niceMax)}</text>
      {strikes.map((k) => (
        <text key={k} x={xScale(k)} y={H - mB + 18} textAnchor="middle" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{k}</text>
      ))}
      {tip}
    </svg>
  );
}

// ---------- blueprint frame ----------

function Blueprint({ children, className = "" }) {
  return (
    <div className={`blueprint ${className}`}>
      <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
      {children}
    </div>
  );
}

// ---------- main ----------

export default function OptionsPositionAnalyzer() {
  const [rawRows, setRawRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const mergeRows = (prev, incoming) => {
    if (incoming.length === 0) return prev;
    const tickerOf = (r) => r.description.trim().split(/\s+/)[0];
    const prevTicker = prev.length > 0 ? tickerOf(prev[0]) : null;
    const nextTicker = tickerOf(incoming[0]);
    const base = prevTicker && prevTicker !== nextTicker ? [] : prev;
    const map = new Map(base.map((r) => [r.description, r]));
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
      for (const file of images) {
        const base64 = await fileToBase64(file);
        const rows = await extractRows(base64, file.type || "image/png");
        setRawRows((prev) => mergeRows(prev, rows));
      }
    } catch (e) {
      setError("Couldn't read that screenshot — try a clearer crop, or one that includes the column headers.");
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

  const underlyingRow = rawRows.find((r) => !parseLeg(r.description));
  const stockPrice = underlyingRow ? Number(underlyingRow.last) : null;
  const baselineShift =
    underlyingRow && underlyingRow.position !== null && underlyingRow.position !== ""
      ? Number(underlyingRow.position)
      : 0;

  const ticker = underlyingRow
    ? underlyingRow.description.trim().split(/\s+/)[0]
    : rawRows.find((r) => parseLeg(r.description))?.description.trim().split(/\s+/)[0] || "—";

  const { dollarMultiplier, sharesPerContract } = contractSpec(ticker);

  const legRows = rawRows
    .map((r) => {
      const leg = parseLeg(r.description);
      if (!leg || stockPrice == null) return null;
      const position = Number(r.position);
      const last = midOrLast(r);
      const intrinsic = leg.type === "PUT" ? Math.max(leg.strike - stockPrice, 0) : Math.max(stockPrice - leg.strike, 0);
      const extrinsic = last - intrinsic;
      const totalExtrinsic = extrinsic * Math.abs(position) * dollarMultiplier;
      return { ...leg, position, last, intrinsic, extrinsic, totalExtrinsic };
    })
    .filter(Boolean)
    .sort((a, b) => (a.type === b.type ? a.strike - b.strike : a.type === "PUT" ? -1 : 1));

  const curve = stockPrice != null && legRows.length > 0 ? buildCurve(legRows, baselineShift, sharesPerContract) : null;
  const netAtSpot = stockPrice != null ? netPositionAt(legRows, baselineShift, stockPrice, sharesPerContract) : null;

  const putsTotal = legRows.filter((r) => r.type === "PUT").reduce((s, r) => s + r.totalExtrinsic, 0);
  const callsTotal = legRows.filter((r) => r.type === "CALL").reduce((s, r) => s + r.totalExtrinsic, 0);
  const grandTotal = putsTotal + callsTotal;

  const hasData = rawRows.length > 0;

  return (
    <div className="content">
      <div className="app-header">
        <div>
          <p className="label" style={{ marginBottom: 4 }}>Options position analyzer</p>
          <h1 className="app-ticker">
            {ticker} {stockPrice != null && <span className="app-spot">· {stockPrice.toLocaleString()}</span>}
          </h1>
        </div>
        {hasData && (
          <button className="btn" onClick={() => setRawRows([])}>
            <Trash2 size={13} /> Clear all
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onSelect} />

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current.click()}
        className={`dropzone ${dragOver ? "dropzone--active" : ""} ${hasData ? "dropzone--compact" : ""}`}
      >
        {loading ? (
          <div className="dropzone__loading">
            <Loader2 size={16} className="spin" /> Reading screenshot…
          </div>
        ) : hasData ? (
          <div className="dropzone__add">
            <Plus size={14} /> Add another screenshot
          </div>
        ) : (
          <div>
            <Upload size={22} className="dropzone__icon" />
            <p className="dropzone__title">Drop, paste (Ctrl/Cmd+V), or click to add an IBKR position screenshot</p>
            <p className="dropzone__subtitle">Include the column headers for best accuracy</p>
          </div>
        )}
      </div>

      {error && <p className="app-error">{error}</p>}

      {hasData && legRows.length > 0 && stockPrice != null && (
        <>
          <div className="grid grid--kpi app-kpis">
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

          <Blueprint>
            <p className="label">Net position vs underlying price</p>
            <StepChart curve={curve} ticker={ticker} />
          </Blueprint>

          <Blueprint>
            <p className="label">Position detail</p>
            <table className="table">
              <thead>
                <tr><th>Strike</th><th className="text">Type</th><th>Qty</th><th>Last</th><th>Intrinsic</th><th>Extrinsic</th><th>Total extrinsic</th></tr>
              </thead>
              <tbody>
                {legRows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.strike}</td>
                    <td className="text">{r.type}</td>
                    <td>{r.position}</td>
                    <td>{r.last.toFixed(2)}</td>
                    <td>{r.intrinsic.toFixed(2)}</td>
                    <td>{r.extrinsic.toFixed(2)}</td>
                    <td className={signClass(r.totalExtrinsic)}>{fmtMoney(r.totalExtrinsic)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={6} className={signClass(putsTotal)}>Puts total extrinsic</td><td className={signClass(putsTotal)}>{fmtMoney(putsTotal)}</td></tr>
                <tr><td colSpan={6} className={signClass(callsTotal)}>Calls total extrinsic</td><td className={signClass(callsTotal)}>{fmtMoney(callsTotal)}</td></tr>
                <tr><td colSpan={6} className={signClass(grandTotal)}>Total extrinsic</td><td className={signClass(grandTotal)}>{fmtMoney(grandTotal)}</td></tr>
              </tfoot>
            </table>
          </Blueprint>
        </>
      )}
    </div>
  );
}
