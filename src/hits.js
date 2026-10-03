// Site usage beacons: POST /hit from the static site's inline script (navigator.sendBeacon).
//
// Accepted events (anything else is rejected with 400 and not stored):
//   {"t":"pageview","p":"/entries/x402/"}
//   {"t":"click","p":"/entries/x402/","id":"x402","h":"www.x402.org"}   outbound link on an entry page
//   {"t":"download","p":"/skills/web-lookup/","id":"web-lookup","k":"zip"|"skill_md"}
// "p" must be a page the site actually publishes, "id" a published entry / skill id, and
// "h" a host that entry links to. No cookies, IPs, referrers, query strings or client ids
// are accepted or stored. Data points go to the Analytics Engine dataset bound as HITS
// (indexagentica_hits), index "hit:<event>".
import { getData, ROUTES } from "./data.js";
import { uaClass } from "./ua.js";

export const HIT_EVENTS = ["pageview", "click", "download"];
export const DOWNLOAD_KINDS = ["zip", "skill_md"];
/** Column layout of indexagentica_hits. Append only, never reorder. */
export const HIT_BLOBS = ["event", "path", "entry_id", "dest_host", "download_kind", "ua_class", "country"];
export const MAX_HIT_BYTES = 512;
const DEFAULT_ORIGINS = "https://indexagentica.com,https://www.indexagentica.com";
const ALLOWED_KEYS = { pageview: ["t", "p"], click: ["t", "p", "id", "h"], download: ["t", "p", "id", "k"] };
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const pathCache = new WeakMap();
/** Every HTML page path the site publishes, derived from the published indexes. */
export function knownPaths(d) {
  let s = pathCache.get(d);
  if (s) return s;
  s = new Set(["/", "/agents/", "/schema/", "/404.html"]);
  for (const c of d.categories || []) s.add(`/categories/${c.slug}/`);
  for (const e of d.entries || []) s.add(`/entries/${e.id}/`);
  for (const r of Object.values(ROUTES)) s.add(`/${r}/`);
  for (const x of d.longform || []) if (ROUTES[x.type]) s.add(`/${ROUTES[x.type]}/${x.id}/`);
  pathCache.set(d, s);
  return s;
}

/** Hosts an entry page links to (website, repo, docs, llms.txt, OpenAPI, sources). */
export function entryHosts(e) {
  const aa = (e && e.agent_access) || {};
  const urls = [e.url, e.repo, e.docs, aa.llms_txt, aa.openapi, ...(Array.isArray(e.sources) ? e.sources : [])];
  const hosts = new Set();
  for (const u of urls) {
    if (typeof u !== "string") continue;
    try { hosts.add(new URL(u).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  return hosts;
}

/** Strict validation. @returns {{ok: true, hit: object} | {ok: false, error: string}} */
export function validateHit(body, d) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const t = body.t;
  if (!HIT_EVENTS.includes(t)) return { ok: false, error: `t must be one of: ${HIT_EVENTS.join(", ")}` };
  const extra = Object.keys(body).filter((k) => !ALLOWED_KEYS[t].includes(k));
  if (extra.length) return { ok: false, error: `unexpected field(s) for ${t}: ${extra.slice(0, 5).join(", ")}` };
  const p = body.p;
  if (typeof p !== "string" || p.length > 200 || !knownPaths(d).has(p)) return { ok: false, error: "p must be the path of a published page" };
  const hit = { event: t, path: p, id: "", host: "", kind: "" };
  if (t === "click") {
    const e = typeof body.id === "string" && d.byId ? d.byId.get(body.id) : null;
    if (!e) return { ok: false, error: "id must be a published entry id" };
    if (p !== `/entries/${e.id}/`) return { ok: false, error: "clicks are only counted on the entry's own page" };
    const h = typeof body.h === "string" ? body.h.toLowerCase() : "";
    if (!HOST_RE.test(h) || !entryHosts(e).has(h)) return { ok: false, error: "h must be a host this entry links to" };
    hit.id = e.id;
    hit.host = h;
  } else if (t === "download") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!d.longformByKey || !d.longformByKey.has(`skill:${id}`)) return { ok: false, error: "id must be a published skill id" };
    if (!DOWNLOAD_KINDS.includes(body.k)) return { ok: false, error: `k must be one of: ${DOWNLOAD_KINDS.join(", ")}` };
    hit.id = id;
    hit.kind = body.k;
  }
  return { ok: true, hit };
}

export function hitDataPoint(hit, ua, cf = {}) {
  return {
    indexes: [`hit:${hit.event}`],
    blobs: [hit.event, hit.path, hit.id, hit.host, hit.kind, uaClass(ua), String(cf.country || "").slice(0, 4)],
    doubles: [1],
  };
}

export function originOk(request, env) {
  const origin = request.headers.get("origin");
  const allowed = String(env.HIT_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  return !!origin && allowed.includes(origin);
}

/**
 * Handle POST /hit. `reply(status, body?)` builds the response (204 when body is undefined).
 * Never stores anything for rejected input.
 */
export async function handleHit(request, env, ctx, reply) {
  if (!originOk(request, env)) return reply(403, { error: { status: 403, code: "forbidden_origin", message: "Hits are accepted only from the Index Agentica site." } });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_HIT_BYTES) return reply(413, { error: { status: 413, code: "too_large", message: `Body must be at most ${MAX_HIT_BYTES} bytes.` } });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_HIT_BYTES) return reply(413, { error: { status: 413, code: "too_large", message: `Body must be at most ${MAX_HIT_BYTES} bytes.` } });
  let body;
  try { body = JSON.parse(text); } catch { return reply(400, { error: { status: 400, code: "bad_request", message: "Body must be JSON." } }); }
  let d;
  try { d = await getData(env, ctx); } catch { return reply(503, { error: { status: 503, code: "unavailable", message: "Could not load the site index to validate the hit." } }); }
  const v = validateHit(body, d);
  if (!v.ok) return reply(400, { error: { status: 400, code: "bad_request", message: v.error } });
  const ds = env.HITS;
  if (ds && typeof ds.writeDataPoint === "function") {
    try { ds.writeDataPoint(hitDataPoint(v.hit, request.headers.get("user-agent") || "", request.cf || {})); } catch { /* never affects the response */ }
  }
  return reply(204);
}
