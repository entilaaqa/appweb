import pg from "pg";
import { scrypt as _scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(_scrypt);

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + (await scrypt(pw, salt, 64)).toString("hex");
}
export async function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(":");
  if (!s || !h) return false;
  const a = Buffer.from(h, "hex"), b = await scrypt(pw, Buffer.from(s, "hex"), a.length);
  return a.length === b.length && timingSafeEqual(a, b);
}

const url = process.env.DATABASE_URL;
const host = url ? new URL(url).hostname : "";
// Render internal URLs (no dots) and localhost need no SSL; external hosts (Render external, Supabase) do.
const ssl = process.env.PGSSL !== "off" && host.includes(".") && !/^127\./.test(host) ? { rejectUnauthorized: false } : false;
export const pool = url ? new pg.Pool({ connectionString: url, max: 5, ssl }) : null;

export async function init() {
  await pool.query(`
    create table if not exists bookings(
      id bigserial primary key, booking_id text unique not null,
      created_at timestamptz not null default now(),
      name text not null, whatsapp text not null, email text not null,
      current_status text, current_status_code int,
      monthly_income text, monthly_income_code int,
      ready_to_invest text, ready_to_invest_code int,
      main_goal text, biggest_challenge text,
      session_start timestamptz, session_tz text, country text, language text,
      utm jsonb not null default '{}', referrer text, page_url text,
      lead_status text not null default 'new', notes text);
    create index if not exists bookings_created on bookings(created_at desc);
    create table if not exists users(
      email text primary key, password_hash text not null,
      role text not null default 'team' check (role in ('admin','team')),
      created_at timestamptz not null default now());`);
  const { ADMIN_EMAIL: e, ADMIN_PASSWORD: p } = process.env;
  if (e && p) await upsertUser(e, p, "admin");
}
export async function upsertUser(email, password, role) {
  await pool.query(
    `insert into users(email,password_hash,role) values($1,$2,$3)
     on conflict(email) do update set password_hash=excluded.password_hash, role=excluded.role`,
    [email.trim().toLowerCase(), await hashPassword(password), role]);
}
