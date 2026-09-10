// The §10 access gate, per the platform spec's Node/Express reference: HTTP
// Basic on the first request, then a signed __Host- cookie for 30 days with
// sliding renewal, rate-limited failed logins, everything stateless.
import crypto from "node:crypto";

const { APP_USERNAME, APP_PASSWORD, SECRET_KEY } = process.env;
const MISSING = ["APP_USERNAME", "APP_PASSWORD", "SECRET_KEY"].filter((k) => !process.env[k]);
const COOKIE = "__Host-ncf_auth"; // __Host-: the browser refuses it unless Secure, Path=/ and no Domain
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const RENEW_BELOW = 60 * 60 * 24 * 7; // re-issue a valid cookie that has under 7 days left
const MAX_FAILS = 10, FAIL_WINDOW = 15 * 60 * 1000; // rule 12: 10 wrong passwords per address per 15 minutes
const fails = new Map(); // ip -> { n, until } — in memory, so it resets on every deploy; fine for a personal tool

if (MISSING.length) console.error(`[auth] missing env: ${MISSING.join(", ")} — all routes will 503`); // names only, never values

const b64 = (v) => Buffer.from(v).toString("base64url");
const sign = (payload) => crypto.createHmac("sha256", SECRET_KEY).update(payload).digest();

// Hash both sides to a fixed width so the compare is constant-time AND
// never throws on a length mismatch — the length itself leaks nothing.
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest(),
  );

const tooMany = (ip) => { const f = fails.get(ip); return !!f && f.n >= MAX_FAILS && Date.now() < f.until; };
function noteFail(ip) {
  const now = Date.now();
  for (const [k, f] of fails) if (f.until < now) fails.delete(k); // forget expired windows
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = now + FAIL_WINDOW; fails.set(ip, f);
}

// Returns the verified payload ({ u, exp }) or null — the caller needs exp for renewal.
function validCookie(token) {
  if (!token) return null;
  const [v, payload, sig] = token.split(".");
  if (v !== "v1" || !payload || !sig) return null;
  const expected = sign(payload);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof u === "string" && typeof exp === "number" && exp > Math.floor(Date.now() / 1000) ? { u, exp } : null;
  } catch {
    return null; // never trust an unverified payload
  }
}

function readCookie(req) {
  const hit = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : null;
}

function issueCookie(res, user) {
  const payload = b64(JSON.stringify({ u: user, exp: Math.floor(Date.now() / 1000) + MAX_AGE }));
  res.cookie(COOKIE, `v1.${payload}.${b64(sign(payload))}`, {
    httpOnly: true, secure: true, sameSite: "lax", maxAge: MAX_AGE * 1000, path: "/",
  });
}

export function requireAuth(req, res, next) {
  if (MISSING.length) return res.status(503).type("text/plain").send("Server not configured");
  const cookie = validCookie(readCookie(req));
  if (cookie) {
    if (cookie.exp - Math.floor(Date.now() / 1000) < RENEW_BELOW) issueCookie(res, cookie.u); // sliding renewal
    return next();
  }

  if (tooMany(req.ip)) return res.status(429).type("text/plain").send("Too many attempts — try again later");

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (safeEqual(user, APP_USERNAME) && safeEqual(rest.join(":"), APP_PASSWORD)) {
      fails.delete(req.ip);
      issueCookie(res, user);
      return next();
    }
    noteFail(req.ip); // credentials were presented and were wrong — the first, credential-less visit never counts
  }
  res.set("WWW-Authenticate", 'Basic realm="NC Futures", charset="UTF-8"');
  res.status(401).type("text/plain").send("Authentication required"); // never log `header`
}
