/* خادم انطلاقة: يقدّم الموقع (مجلد public) + واجهة API على PostgreSQL
   متغيرات البيئة: DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET (اختياري) */
const express = require("express"), crypto = require("crypto"), path = require("path"), { Pool } = require("pg");
const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const PORT = process.env.PORT || 3000, PROD = process.env.NODE_ENV === "production";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("ent|" + (ADMIN_PASSWORD || "")).digest("hex");
const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL && process.env.PGSSL !== "off" && !/localhost|127\.0\.0\.1/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false });
const app = express(); app.set("trust proxy", 1); app.disable("x-powered-by"); app.use(express.json({ limit: "100kb" }));
app.use((q, r, n) => { r.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" }); if (q.path.startsWith("/api")) r.set("Cache-Control", "no-store"); n(); });

/* ---- الجلسات ---- */
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const mk = () => { const b = Buffer.from(JSON.stringify({ e: Date.now() + 7 * 864e5 })).toString("base64url"); return b + "." + sign(b); };
const valid = t => { if (!t) return false; const [b, s] = t.split("."); if (!b || !s) return false; const a = Buffer.from(sign(b)), c = Buffer.from(s); if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return false; try { return JSON.parse(Buffer.from(b, "base64url")).e > Date.now(); } catch { return false; } };
const cookies = q => Object.fromEntries((q.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
const authed = q => valid(cookies(q).ent_sid);
const auth = (q, r, n) => authed(q) ? n() : r.status(401).json({ error: "unauthorized" });
const wrap = f => (q, r, n) => Promise.resolve(f(q, r, n)).catch(e => { console.error(e.message); r.status(["23502", "22P02", "23503", "22007", "22003"].includes(e.code) ? 400 : 500).json({ error: e.code ? "invalid_input" : "server_error" }); });
const hits = new Map(), limited = (key, max, win) => { const h = hits.get(key) || { n: 0, t: Date.now() }; if (Date.now() - h.t > win) { h.n = 0; h.t = Date.now(); } h.n++; hits.set(key, h); return h.n > max; };
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());

app.post("/api/login", (q, r) => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return r.status(503).json({ error: "auth_not_configured" });
  if (limited("l" + q.ip, 8, 9e5)) return r.status(429).json({ error: "too_many_attempts" });
  const { email, password } = q.body || {}, a = same(String(email || "").trim().toLowerCase(), ADMIN_EMAIL.trim().toLowerCase()), b = same(password || "", ADMIN_PASSWORD);
  if (!(a && b)) return r.status(401).json({ error: "invalid_credentials" });
  r.cookie("ent_sid", mk(), { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 864e5, path: "/" });
  r.json({ ok: true, redirect: "/dashboard.html" });
});
app.post("/api/logout", (q, r) => { r.clearCookie("ent_sid", { path: "/" }); r.json({ ok: true }); });
app.get("/api/me", auth, (q, r) => r.json({ ok: true }));
app.get("/healthz", (q, r) => r.send("ok"));

/* ---- الجداول ---- */
const init = () => pool.query(`
create table if not exists ent_bookings(id bigserial primary key, booking_id text unique, name text not null, whatsapp text, email text, current_status int, income int, ready int, goal text, challenge text, language text, stage text not null default 'new', notes text, session jsonb, source jsonb, created_at timestamptz not null default now());
create table if not exists ent_projects(id bigserial primary key, name text not null, client text, stage int not null default 1, total numeric not null default 0, started_at date default current_date, notes text, created_at timestamptz not null default now());
create table if not exists ent_payments(id bigserial primary key, project_id bigint not null references ent_projects(id) on delete cascade, item int not null default 0, amount numeric not null default 0, due_at date, status text not null default 'due', created_at timestamptz not null default now());`);
const M = {
  bookings: { t: "ent_bookings", cols: ["name", "whatsapp", "email", "income", "ready", "stage", "goal", "challenge", "notes"] },
  projects: { t: "ent_projects", cols: ["name", "client", "stage", "total", "started_at", "notes"] },
  payments: { t: "ent_payments", cols: ["project_id", "item", "amount", "due_at", "status"] }
};
const pick = (m, b) => { const o = {}; for (const c of m.cols) if (b[c] !== undefined) o[c] = b[c] === "" ? null : b[c]; return o; };
const insert = async (m, b) => { const o = pick(m, b || {}), k = Object.keys(o); if (!k.length) { const e = new Error("empty"); e.code = "22P02"; throw e; } return (await pool.query(`insert into ${m.t}(${k.join(",")}) values(${k.map((_, i) => "$" + (i + 1))}) returning *`, k.map(c => o[c]))).rows[0]; };

/* حجز جديد: مفتوح للموقع العام (نموذج الحجز)، ويقبل كل الحقول من لوحة التحكم بعد تسجيل الدخول */
app.post("/api/bookings", wrap(async (q, r) => {
  const b = q.body || {};
  if (authed(q)) return r.status(201).json(await insert(M.bookings, b));
  if (limited("b" + q.ip, 20, 36e5)) return r.status(429).json({ error: "too_many_attempts" });
  const name = String(b.name || "").trim(), email = String(b.email || "").trim().toLowerCase(), wa = String(b.whatsapp || "").replace(/[^\d+]/g, "");
  if (name.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || wa.replace(/\D/g, "").length < 6) return r.status(400).json({ error: "invalid_input" });
  const c = x => (x && Number.isInteger(+x.code) ? +x.code : null), s = x => String(x || "").slice(0, 2000);
  await pool.query(`insert into ent_bookings(booking_id,name,whatsapp,email,current_status,income,ready,goal,challenge,language,session,source) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(booking_id) do nothing`,
    [String(b.booking_id || crypto.randomUUID()).slice(0, 80), name.slice(0, 120), wa.slice(0, 20), email.slice(0, 160), c(b.current_status), c(b.monthly_income), c(b.ready_to_invest_over_10000), s(b.main_goal_12_months), s(b.biggest_challenge), String(b.language || "").slice(0, 5), JSON.stringify(b.session || null), JSON.stringify(b.source || null)]);
  r.status(201).json({ ok: true });
}));
for (const [k, m] of Object.entries(M)) {
  const base = "/api/" + k;
  app.get(base, auth, wrap(async (q, r) => r.json((await pool.query(`select * from ${m.t} order by id desc`)).rows)));
  if (k !== "bookings") app.post(base, auth, wrap(async (q, r) => r.status(201).json(await insert(m, q.body))));
  app.put(base + "/:id(\\d+)", auth, wrap(async (q, r) => {
    const o = pick(m, q.body || {}), ks = Object.keys(o); if (!ks.length) return r.status(400).json({ error: "invalid_input" });
    const row = (await pool.query(`update ${m.t} set ${ks.map((c, i) => c + "=$" + (i + 1))} where id=$${ks.length + 1} returning *`, [...ks.map(c => o[c]), q.params.id])).rows[0];
    row ? r.json(row) : r.status(404).json({ error: "not_found" });
  }));
  app.delete(base + "/:id(\\d+)", auth, wrap(async (q, r) => { await pool.query(`delete from ${m.t} where id=$1`, [q.params.id]); r.status(204).end(); }));
}
app.use("/api", (q, r) => r.status(404).json({ error: "not_found" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

if (!DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
init().then(() => app.listen(PORT, () => console.log("Entilaaqa running on :" + PORT))).catch(e => { console.error(e); process.exit(1); });
