import { useState, useCallback, useRef } from "react";
import { Upload, Loader2, Trash2, Plus } from "lucide-react";

const ACCENT = "#5980a6";
const ACCENT_TINT = "#edf2f7";
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

function netPositionAt(legs, baselineShift, price) {
  let v = baselineShift || 0;
  for (const leg of legs) {
    const short = leg.position < 0;
    const qty = Math.abs(leg.position);
    if (leg.type === "PUT") {
      if (short) { if (price < leg.strike) v += 100 * qty; }
      else { if (price < leg.strike) v -= 100 * qty; }
    } else {
      if (short) { if (price > leg.strike) v -= 100 * qty; }
      else { if (price > leg.strike) v += 100 * qty; }
    }
  }
  return v;
}

function buildCurve(legs, baselineShift) {
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
    segments.push({ x0: xs[i], x1: xs[i + 1], y: netPositionAt(legs, baselineShift, mid) });
  }
  return { segments, domainMin, domainMax, strikes };
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString()}`;
}

function fmtShort(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return abs >= 1000 ? `${sign}${Math.round(abs / 1000)}K` : `${sign}${Math.round(abs)}`;
}

// ---------- chart ----------

function StepChart({ curve, ticker }) {
  if (!curve) return null;
  const { segments, domainMin, domainMax, strikes } = curve;
  const W = 1500, H = 230;
  const mL = 60, mR = 20, mT = 16, mB = 32;
  const plotW = W - mL - mR;
  const plotH = H - mT - mB;

  const maxAbs = Math.max(1, ...segments.map((s) => Math.abs(s.y)));
  const niceMax = Math.ceil(maxAbs / 5000) * 5000 || 5000;

  const xScale = (p) => mL + ((p - domainMin) / (domainMax - domainMin)) * plotW;
  const yScale = (v) => mT + ((niceMax - v) / (niceMax * 2)) * plotH;
  const zeroY = yScale(0);

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

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Step chart of net underlying position for ${ticker} across strike prices, ranging from ${fmtShort(-niceMax)} to ${fmtShort(niceMax)} shares`}
    >
      {strikes.map((k) => (
        <line key={k} x1={xScale(k)} y1={mT} x2={xScale(k)} y2={H - mB} stroke={HAIRLINE} strokeWidth="1" />
      ))}
      <line x1={mL} y1={zeroY} x2={W - mR} y2={zeroY} stroke={HAIRLINE} strokeWidth="1" strokeDasharray="2 3" />
      <path d={area} fill={ACCENT_TINT} />
      <path d={line} fill="none" stroke={ACCENT} strokeWidth="2" strokeLinejoin="miter" />
      <text x={mL - 10} y={mT + 10} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(niceMax)}</text>
      <text x={mL - 10} y={zeroY + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">0</text>
      <text x={mL - 10} y={H - mB + 4} textAnchor="end" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{fmtShort(-niceMax)}</text>
      {strikes.map((k) => (
        <text key={k} x={xScale(k)} y={H - mB + 18} textAnchor="middle" fontSize="10.5" fill={ACCENT_TEXT} fontFamily="Inter, sans-serif">{k}</text>
      ))}
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
    const map = new Map(prev.map((r) => [r.description, r]));
    for (const r of incoming) map.set(r.description, r);
    return Array.from(map.values());
  };

  const handleFiles = useCallback(async (files) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
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

  const underlyingRow = rawRows.find((r) => !parseLeg(r.description));
  const stockPrice = underlyingRow ? Number(underlyingRow.last) : null;
  const baselineShift =
    underlyingRow && underlyingRow.position !== null && underlyingRow.position !== ""
      ? Number(underlyingRow.position)
      : 0;

  const legRows = rawRows
    .map((r) => {
      const leg = parseLeg(r.description);
      if (!leg || stockPrice == null) return null;
      const position = Number(r.position);
      const last = Number(r.last);
      const intrinsic = leg.type === "PUT" ? Math.max(leg.strike - stockPrice, 0) : Math.max(stockPrice - leg.strike, 0);
      const extrinsic = last - intrinsic;
      const totalExtrinsic = extrinsic * Math.abs(position) * 100;
      return { ...leg, position, last, intrinsic, extrinsic, totalExtrinsic };
    })
    .filter(Boolean)
    .sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));

  const curve = stockPrice != null && legRows.length > 0 ? buildCurve(legRows, baselineShift) : null;
  const netAtSpot = stockPrice != null ? netPositionAt(legRows, baselineShift, stockPrice) : null;

  const putsTotal = legRows.filter((r) => r.type === "PUT").reduce((s, r) => s + r.totalExtrinsic, 0);
  const callsTotal = legRows.filter((r) => r.type === "CALL").reduce((s, r) => s + r.totalExtrinsic, 0);
  const grandTotal = putsTotal + callsTotal;

  const ticker = underlyingRow
    ? underlyingRow.description.trim().split(/\s+/)[0]
    : legRows[0]?.ticker || "—";

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
            <p className="dropzone__title">Drop an IBKR position screenshot here</p>
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
                <p className={`kpi__figure ${netAtSpot < 0 ? "loss" : "kpi__figure--accent"}`}>{fmtMoney(netAtSpot)}</p>
              </div>
            </Blueprint>
            <Blueprint>
              <div className="kpi">
                <p className="kpi__label">Puts total extrinsic</p>
                <p className="kpi__figure">{fmtMoney(putsTotal)}</p>
              </div>
            </Blueprint>
            <Blueprint>
              <div className="kpi">
                <p className="kpi__label">Calls total extrinsic</p>
                <p className="kpi__figure">{fmtMoney(callsTotal)}</p>
              </div>
            </Blueprint>
            <Blueprint>
              <div className="kpi">
                <p className="kpi__label">Total extrinsic</p>
                <p className="kpi__figure">{fmtMoney(grandTotal)}</p>
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
                    <td>{fmtMoney(r.totalExtrinsic)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={6}>Puts total extrinsic</td><td>{fmtMoney(putsTotal)}</td></tr>
                <tr><td colSpan={6}>Calls total extrinsic</td><td>{fmtMoney(callsTotal)}</td></tr>
                <tr><td colSpan={6}>Total extrinsic</td><td>{fmtMoney(grandTotal)}</td></tr>
              </tfoot>
            </table>
          </Blueprint>
        </>
      )}
    </div>
  );
}
