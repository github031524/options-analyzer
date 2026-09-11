// Converts an IBKR price cell to a plain number. The vision model used to do
// this arithmetic itself and, on a screen full of options quoted in 64ths,
// halved a ZB underlying quoted in 32nds ("106'240" came back as 106.375
// instead of 106.75). The model now copies cell text verbatim and this code
// converts — code cannot be primed into the wrong denominator.
//
// Handles, in order:
//   bond tick notation  "106'240" → 106 + 24/32 (+ optional third digit in
//                       eighths of a 32nd, e.g. "111'044" → 111 + 4.5/32)
//   fractions           "6/64" → 0.09375, with IBKR's "c" close-price prefix
//   plain decimals      "7726.75" (commas stripped), and numbers pass through
export function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (s === "") return null;
  // "c60/64" marks a prior-close print; commas are thousands separators.
  s = s.replace(/^[a-z]+/i, "").replace(/,/g, "");

  const tick = s.match(/^(\d+)'(\d{2})(\d)?$/);
  if (tick) {
    const thirtySeconds = Number(tick[2]) + (tick[3] ? Number(tick[3]) / 8 : 0);
    return Number(tick[1]) + thirtySeconds / 32;
  }

  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/);
  if (frac && Number(frac[2]) !== 0) return Number(frac[1]) / Number(frac[2]);

  const plain = Number(s);
  return Number.isFinite(plain) ? plain : null;
}

// Replaces a row's price fields with parsed numbers, leaving everything else
// (description, position) untouched. Non-object rows pass through for the
// client's own filter to drop.
export function normalizeRow(row) {
  if (!row || typeof row !== "object") return row;
  return { ...row, last: parsePrice(row.last), bid: parsePrice(row.bid), ask: parsePrice(row.ask) };
}
