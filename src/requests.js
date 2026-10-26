// Listing requests: agents ask for something to be added to the directory.
// Shared by the MCP tool `request_listing` and POST /v1/requests. Stored in D1 (REQUESTS_DB).
// Nothing is listed automatically: the Curator verifies each request and sets its status.
import { getData } from "./data.js";
import { clientKey } from "./ratelimit.js";
import { internalRule } from "./internal.js";

export const STATUSES = ["pending", "verified", "listed", "rejected"];
export const LIMITS = { wanted: 120, reason: 500, requester: 60, url: 300, perHour: 5, perDay: 20 };
const STOP = new Set(["mcp", "server", "servers", "the", "a", "an", "for", "tool", "skill", "agent", "api", "plugin", "please", "add"]);
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export class RequestError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export function normalizeWanted(s) {
  const words = String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).join(" ");
}

export function urlKey(u) {
  if (!u) return null;
  const x = new URL(u);
  const host = x.hostname.toLowerCase().replace(/^www\./, "");
  const path = x.pathname.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  return host + path;
}

function str(v, field, max, { required = false, single = true } = {}) {
  if (v == null || v === "") {
    if (required) throw new RequestError(400, "bad_request", `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new RequestError(400, "bad_request", `${field} must be a string`);
  const t = v.trim().replace(/[ \t]+/g, " ");
  if (!t) { if (required) throw new RequestError(400, "bad_request", `${field} is required`); return null; }
  if (CTRL.test(single ? t : t.replace(/\r?\n/g, " "))) throw new RequestError(400, "bad_request", `${field} contains control characters`);
  if (single && /[\r\n]/.test(t)) throw new RequestError(400, "bad_request", `${field} must be a single line`);
  if ([...t].length > max) throw new RequestError(400, "bad_request", `${field} must be at most ${max} characters`);
  return t;
}

export async function validCategories(env, ctx) {
  const d = await getData(env, ctx);
  return [...d.categories.map((c) => c.slug), "other"];
}

/** Validate tool/endpoint input. Returns cleaned fields. */
export async function validateInput(env, ctx, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RequestError(400, "bad_request", "body must be a JSON object");
  const allowed = new Set(["wanted", "category", "url", "reason", "requester"]);
  const extra = Object.keys(args).filter((k) => !allowed.has(k));
  if (extra.length) throw new RequestError(400, "bad_request", `unknown field(s): ${extra.join(", ")}`);
  const wanted = str(args.wanted, "wanted", LIMITS.wanted, { required: true });
  const category = str(args.category, "category", 40, { required: true }).toLowerCase();
  const cats = await validCategories(env, ctx);
  if (!cats.includes(category)) throw new RequestError(400, "bad_request", `category must be one of: ${cats.join(", ")}`);
  const url = str(args.url, "url", LIMITS.url);
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw new RequestError(400, "bad_request", "url must be an absolute http(s) URL"); }
    if (/\s/.test(url) || !["http:", "https:"].includes(u.protocol) || u.username || u.password || !u.hostname.includes(".")) throw new RequestError(400, "bad_request", "url must be an absolute http(s) URL");
  }
  const reason = str(args.reason, "reason", LIMITS.reason, { single: false });
  const requester = str(args.requester, "requester", LIMITS.requester);
  const norm = normalizeWanted(wanted);
  if (!norm) throw new RequestError(400, "bad_request", "wanted must contain letters or digits");
  return { wanted, category, url, reason, requester, norm, url_key: url ? urlKey(url) : null };
}

// IPv6 clients often rotate addresses inside their allocation (privacy extensions, relays), so hash
// prefixes instead of full addresses: /64 for one vote per client, /48 (+ User-Agent) for rate limits.
// IPv4 addresses are used whole. Only keyed HMACs are stored, never the address.
export function ipPrefix(ip, bits) {
  ip = String(ip || "unknown").trim().toLowerCase();
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, bits / 16).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + `::/${bits}`;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function db(env) {
  if (!env.REQUESTS_DB) throw new RequestError(503, "unavailable", "Request queue is not configured.");
  return env.REQUESTS_DB;
}

const pushCapped = (json, v) => {
  const a = JSON.parse(json || "[]");
  if (v && !a.includes(v) && a.length < 10) a.push(v);
  return JSON.stringify(a);
};

/** Create or merge a request. Never stores the raw IP. */
/** This server's public base (PUBLIC_BASE_URL, else the request origin), so self-hosted copies link to themselves. */
export function publicBase(env, request) {
  if (env && env.PUBLIC_BASE_URL) return String(env.PUBLIC_BASE_URL).replace(/\/+$/, "");
  try { return new URL(request.url).origin; } catch { return "https://mcp.indexagentica.com"; }
}

export async function submitRequest(env, ctx, request, args) {
  const D = db(env);
  const input = await validateInput(env, ctx, args);
  const salt = env.REQUESTS_IP_SALT || env.REQUESTS_ADMIN_TOKEN || "indexagentica";
  const ip = clientKey(request);
  const ipHash = await hmac(salt, "ip:" + ipPrefix(ip, 64));
  const ua = (request.headers.get("user-agent") || "").slice(0, 200);
  const rlKey = await hmac(salt, "rl:" + ipPrefix(ip, 48) + "|" + ua);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  // Rate limit: per IP hash (/48 for IPv6) + client (UA), 5/hour and 20/day; also 20/day per IP hash (/64) alone.
  const rl = await D.prepare(
    "SELECT COALESCE(SUM(CASE WHEN created_at>?2 THEN 1 ELSE 0 END),0) h, COUNT(*) d FROM submissions WHERE rl_key=?1 AND created_at>?3"
  ).bind(rlKey, nowMs - 3600e3, nowMs - 86400e3).first();
  const ipDay = await D.prepare("SELECT COUNT(*) n FROM submissions WHERE rl_key=?1 AND created_at>?2").bind("ip:" + ipHash, nowMs - 86400e3).first();
  if ((rl && rl.h >= LIMITS.perHour) || (rl && rl.d >= LIMITS.perDay) || (ipDay && ipDay.n >= LIMITS.perDay)) {
    const retry = rl && rl.h >= LIMITS.perHour ? 3600 : 86400;
    throw new RequestError(429, "rate_limited", `Too many listing requests (max ${LIMITS.perHour} per hour, ${LIMITS.perDay} per day per client).`, { retry_after: retry });
  }

  // Dedupe: same normalized text in the same category, or same URL host+path.
  let row = await D.prepare("SELECT * FROM requests WHERE category=?1 AND norm=?2 ORDER BY id LIMIT 1").bind(input.category, input.norm).first();
  if (!row && input.url_key) row = await D.prepare("SELECT * FROM requests WHERE url_key=?1 ORDER BY id LIMIT 1").bind(input.url_key).first();

  const internal = internalRule(request, env) ? 1 : 0;
  const stmts = [
    D.prepare("INSERT INTO submissions (rl_key, created_at) VALUES (?1, ?3), (?2, ?3)").bind(rlKey, "ip:" + ipHash, nowMs),
    D.prepare("DELETE FROM submissions WHERE created_at < ?1").bind(nowMs - 2 * 86400e3),
  ];
  let id, merged = false, counted = true;
  if (row) {
    merged = true;
    id = row.id;
    const ins = await D.prepare("INSERT OR IGNORE INTO votes (request_id, ip_hash, created_at) VALUES (?1, ?2, ?3)").bind(id, ipHash, now).run();
    counted = (ins.meta && ins.meta.changes) > 0;
    stmts.push(D.prepare(
      "UPDATE requests SET votes = votes + ?2, last_seen=?3, reasons=?4, requesters=?5, url=COALESCE(url, ?6), url_key=COALESCE(url_key, ?7) WHERE id=?1"
    ).bind(id, counted ? 1 : 0, now, pushCapped(row.reasons, input.reason), pushCapped(row.requesters, input.requester), input.url, input.url_key));
    await D.batch(stmts);
  } else {
    const r = await D.prepare(
      "INSERT INTO requests (wanted, norm, category, url, url_key, reasons, requesters, votes, status, internal, first_seen, last_seen) VALUES (?1,?2,?3,?4,?5,?6,?7,1,'pending',?8,?9,?9) RETURNING id"
    ).bind(input.wanted, input.norm, input.category, input.url, input.url_key, pushCapped("[]", input.reason), pushCapped("[]", input.requester), internal, now).first();
    id = r.id;
    stmts.push(D.prepare("INSERT OR IGNORE INTO votes (request_id, ip_hash, created_at) VALUES (?1, ?2, ?3)").bind(id, ipHash, now));
    await D.batch(stmts);
  }
  const cur = await D.prepare("SELECT * FROM requests WHERE id=?1").bind(id).first();
  return {
    ok: true,
    id,
    merged,
    vote_counted: counted,
    request: publicRow(cur),
    note: merged
      ? (counted ? "Merged into an existing request; your vote was added." : "Merged into an existing request; this client already voted for it.")
      : "Queued for review. The Curator verifies every request before anything is listed.",
    list: `${publicBase(env, request)}/v1/requests`,
  };
}

/** Public, sanitized view. URLs only once verified/listed. */
export function publicRow(r) {
  const o = { id: r.id, wanted: r.wanted, category: r.category, votes: r.votes, status: r.status, first_seen: r.first_seen, last_seen: r.last_seen };
  if ((r.status === "verified" || r.status === "listed") && r.url) o.url = r.url;
  if (r.status === "listed" && r.entry_id) o.entry_id = r.entry_id;
  return o;
}

export async function listPublic(env, { status, limit = 100 } = {}) {
  const D = db(env);
  if (status && !STATUSES.includes(status)) throw new RequestError(400, "bad_request", `status must be one of: ${STATUSES.join(", ")}`);
  const where = status ? "status=?1" : "status!='rejected'";
  const q = `SELECT * FROM requests WHERE ${where} ORDER BY votes DESC, last_seen DESC LIMIT ${Math.min(Math.max(1, limit | 0), 200)}`;
  const rows = (await (status ? D.prepare(q).bind(status) : D.prepare(q)).all()).results || [];
  return {
    generated: new Date().toISOString(),
    note: "Most-requested additions to Index Agentica. Pending requests are unverified; URLs appear only after Curator verification. Rejected requests are hidden.",
    statuses: STATUSES,
    total: rows.length,
    requests: rows.map(publicRow),
  };
}

// ---- admin ----
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export function isAdmin(request, env) {
  const t = env.REQUESTS_ADMIN_TOKEN;
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!(t && t.length >= 32 && m && timingSafeEq(m[1].trim(), t));
}

export async function listAdmin(env, status) {
  const D = db(env);
  if (status && status !== "all" && !STATUSES.includes(status)) throw new RequestError(400, "bad_request", "bad status");
  const rows = (await (status && status !== "all"
    ? D.prepare("SELECT * FROM requests WHERE status=?1 ORDER BY votes DESC, id").bind(status)
    : D.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 500")).all()).results || [];
  return { total: rows.length, requests: rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasons || "[]"), requesters: JSON.parse(r.requesters || "[]") })) };
}

export async function setStatus(env, id, body) {
  const D = db(env);
  if (!body || typeof body !== "object") throw new RequestError(400, "bad_request", "JSON body required");
  const { status, entry_id = null, note = null } = body;
  if (body.delete === true) {
    await D.batch([D.prepare("DELETE FROM votes WHERE request_id=?1").bind(id), D.prepare("DELETE FROM requests WHERE id=?1").bind(id)]);
    return { ok: true, id, deleted: true };
  }
  if (!STATUSES.includes(status)) throw new RequestError(400, "bad_request", `status must be one of: ${STATUSES.join(", ")}`);
  if (entry_id != null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry_id)) throw new RequestError(400, "bad_request", "entry_id must be a kebab-case id");
  if (status === "listed" && !entry_id) throw new RequestError(400, "bad_request", "entry_id is required when status is listed");
  const n = note == null ? null : str(note, "note", 500, { single: false });
  const r = await D.prepare("UPDATE requests SET status=?2, entry_id=COALESCE(?3, entry_id), note=COALESCE(?4, note) WHERE id=?1").bind(id, status, entry_id, n).run();
  if (!r.meta || !r.meta.changes) throw new RequestError(404, "not_found", `No request ${id}`);
  return { ok: true, request: await D.prepare("SELECT * FROM requests WHERE id=?1").bind(id).first() };
}
