import http from "node:http";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, init, verifyPassword } from "./lib.js";

const PORT = process.env.PORT || 10000, PROD = process.env.NODE_ENV === "production";
const ROOT = path.dirname(fileURLToPath(import.meta.url)), PUB = path.join(ROOT, "public");
const STATUS = ["new", "contacted", "scheduled", "won", "lost"];
const SECRET = process.env.SESSION_SECRET || (console.warn("SESSION_SECRET missing: sessions reset on restart"), randomBytes(32).toString("hex"));

if (pool) init().then(() => console.log("db ready")).catch(e => console.error("db init failed", e));
else console.warn("DATABASE_URL missing: bookings and login are disabled");

/* ---------- static files (whitelist only) ---------- */
const FILES = { "/": "index.html", "/index.html": "index.html", "/dashboard.html": "dashboard.html", "/dashboard": "dashboard.html",
  "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js", "/icons/icon.svg": "icons/icon.svg" };
const TYPES = { html: "text/html; charset=utf-8", webmanifest: "application/manifest+json", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0a0a0a"/><path d="M256 104l128 150h-84v154h-88V254h-84z" fill="#fff"/></svg>';
const assets = new Map();
for (const [url, f] of Object.entries(FILES)) {
  // يبحث في public/ ثم في الجذر (يتسامح مع الرفع المسطّح إلى GitHub)
  let buf = null;
  for (const fp of [path.join(PUB, f), path.join(ROOT, f), path.join(ROOT, path.basename(f))]) { try { buf = await readFile(fp); break } catch {} }
  if (!buf && f === "icons/icon.svg") buf = Buffer.from(ICON);
  if (!buf) { console.warn("missing file (skipped): " + f); continue; }
  assets.set(url, { buf, gz: gzipSync(buf), type: TYPES[f.split(".").pop()], cc: /\.(html|js)$/.test(f) ? "no-cache" : "public, max-age=86400" });
}

/* ---------- helpers ---------- */
const send = (res, code, obj, h = {}) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...h }); res.end(JSON.stringify(obj)); };
const err = (code, msg) => Object.assign(new Error(msg), { code });
const readBody = req => new Promise((ok, no) => {
  const c = []; let n = 0;
  req.on("data", d => { n += d.length; if (n <= 32768) c.push(d); });
  req.on("end", () => { if (n > 32768) return no(err(413, "too_large")); try { ok(JSON.parse(Buffer.concat(c).toString() || "{}")) } catch { no(err(400, "invalid_input")) } });
  req.on("error", no);
});
const s = (v, n) => String(v ?? "").trim().slice(0, n);
const pick = (o, max) => { const c = Number(o?.code); return Number.isInteger(c) && c >= 1 && c <= max ? [c, s(o.label, 80)] : null };
const ip = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();
const hits = new Map();
const limited = (k, max, ms) => { const t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < ms); a.push(t); hits.set(k, a); return a.length > max };
setInterval(() => hits.clear(), 36e5).unref();

/* ---------- session (signed HttpOnly cookie) ---------- */
const mac = d => createHmac("sha256", SECRET).update(d).digest("base64url");
const sign = p => { const d = Buffer.from(JSON.stringify(p)).toString("base64url"); return d + "." + mac(d) };
function unsign(t) {
  const [d, m] = String(t || "").split("."); if (!d || !m) return null;
  const e = mac(d); if (e.length !== m.length || !timingSafeEqual(Buffer.from(e), Buffer.from(m))) return null;
  try { const p = JSON.parse(Buffer.from(d, "base64url")); return p.x > Date.now() ? p : null } catch { return null }
}
const COOKIE = (v, age) => `sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${PROD ? "; Secure" : ""}`;
async function who(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ""), p = m && unsign(m[1]);
  if (!p || !pool) return null;
  return (await pool.query("select email, role from users where email=$1", [p.e])).rows[0] || null;
}

/* ---------- API ---------- */
async function bookings(req, res) {
  if (!pool) return send(res, 503, { error: "db_not_configured" });
  if (limited("b" + ip(req), 20, 36e5)) return send(res, 429, { error: "too_many_attempts" });
  const d = await readBody(req);
  const name = s(d.name, 120), wa = s(d.whatsapp, 24).replace(/[^\d+]/g, ""), email = s(d.email, 160).toLowerCase(), bid = s(d.booking_id, 64);
  const st = pick(d.current_status, 5), inc = pick(d.monthly_income, 4), rd = pick(d.ready_to_invest_over_10000, 3);
  if (name.length < 2 || !/^\+?\d{7,16}$/.test(wa) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !bid || !st || !inc || !rd)
    return send(res, 400, { error: "invalid_input" });
  const ss = new Date(d.session?.start), cc = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  const utm = Object.fromEntries(Object.entries(d.source?.utm || {}).slice(0, 10).map(([k, v]) => [s(k, 40), s(v, 200)]));
  await pool.query(
    `insert into bookings(booking_id,name,whatsapp,email,current_status,current_status_code,monthly_income,monthly_income_code,
       ready_to_invest,ready_to_invest_code,main_goal,biggest_challenge,session_start,session_tz,country,language,utm,referrer,page_url)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict(booking_id) do nothing`,
    [bid, name, wa, email, st[1], st[0], inc[1], inc[0], rd[1], rd[0], s(d.main_goal_12_months, 2000), s(d.biggest_challenge, 2000),
     isNaN(ss) ? null : ss, s(d.session?.tz, 60) || null, /^[A-Z]{2}$/.test(cc) && cc !== "XX" ? cc : null, s(d.language, 8) || null,
     utm, s(d.source?.referrer, 500) || null, s(d.source?.page_url, 500) || null]);
  send(res, 200, { ok: true });
}

async function login(req, res) {
  if (!pool) return send(res, 503, { error: "auth_not_configured" });
  if (limited("l" + ip(req), 10, 9e5)) return send(res, 429, { error: "too_many_attempts" });
  const d = await readBody(req), email = s(d.email, 160).toLowerCase(), pw = String(d.password ?? "");
  if (!email || !pw || pw.length > 200) return send(res, 400, { error: "invalid_input" });
  const u = (await pool.query("select email, password_hash, role from users where email=$1", [email])).rows[0];
  if (!u || !(await verifyPassword(pw, u.password_hash))) return send(res, 401, { error: "invalid_credentials" });
  const age = 7 * 864e2;
  send(res, 200, { redirect: "/dashboard.html" }, { "Set-Cookie": COOKIE(sign({ e: u.email, x: Date.now() + age * 1e3 }), age) });
}

async function me(req, res, u) {
  const q = u.searchParams;
  if (req.method === "POST" && !q.has("update")) return send(res, 200, { ok: true }, { "Set-Cookie": COOKIE("", 0) });
  const user = await who(req);
  if (!user) return send(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && q.has("bookings"))
    return send(res, 200, { bookings: (await pool.query("select * from bookings order by created_at desc limit 5000")).rows, migrated: true });
  if (req.method === "GET") return send(res, 200, { email: user.email, isAdmin: user.role === "admin", canView: true });
  if (req.method === "POST") {
    const b = await readBody(req), id = Number(b.id);
    if (!Number.isInteger(id) || (b.lead_status !== undefined && !STATUS.includes(b.lead_status)) || (b.notes !== undefined && typeof b.notes !== "string"))
      return send(res, 400, { error: "invalid_input" });
    const r = await pool.query("update bookings set lead_status=coalesce($2,lead_status), notes=coalesce($3,notes) where id=$1",
      [id, b.lead_status ?? null, b.notes === undefined ? null : b.notes.slice(0, 4000)]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: "not_found" });
  }
  send(res, 405, { error: "method_not_allowed" });
}

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    if (p === "/healthz") return send(res, 200, { ok: true });
    if (p === "/api/bookings" && req.method === "POST") return await bookings(req, res);
    if (p === "/api/login" && req.method === "POST") return await login(req, res);
    if (p === "/api/me") return await me(req, res, u);
    const a = assets.get(p);
    if (a && (req.method === "GET" || req.method === "HEAD")) {
      const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, { "Content-Type": a.type, "Cache-Control": a.cc, Vary: "Accept-Encoding", ...(gz && { "Content-Encoding": "gzip" }) });
      return res.end(req.method === "HEAD" ? undefined : gz ? a.gz : a.buf);
    }
    send(res, 404, { error: "not_found" });
  } catch (e) {
    if (!e.code || typeof e.code !== "number") console.error(e);
    send(res, typeof e.code === "number" ? e.code : 500, { error: typeof e.code === "number" ? e.message : "server_error" });
  }
}).listen(PORT, "0.0.0.0", () => console.log("listening on " + PORT));
