// Public usage stats: GET /stats and the daily KV rollup (cron).
//
// Sources (Workers Analytics Engine, queried through the SQL API with the
// CF_ANALYTICS_TOKEN secret, Account Analytics Read):
//   indexagentica_mcp   one row per MCP / REST request (src/analytics.js)
//   indexagentica_hits  one row per site beacon (src/hits.js) and per direct skill download
//                       (src/downloads.js, event "direct", blob10 = probe: ''|head|bot)
// Counts always use SUM(_sample_interval), never COUNT(), because Analytics Engine
// may sample. Analytics Engine keeps 3 months, so all-time = per-UTC-day totals
// stored in KV (binding STATS_KV, key day:YYYY-MM-DD) + a live query for the days
// not stored yet. Nothing is backfilled or estimated: windows only contain what was
// logged after the `since` timestamps.

const SQL_URL = (acct) => `https://api.cloudflare.com/client/v4/accounts/${acct}/analytics_engine/sql`;
const DAY_MS = 86400000;
const RETENTION_DAYS = 90;
const SETTLE_MS = 30 * 60 * 1000; // a UTC day is rolled up 30 min after it ends (ingestion lag)
export const CACHE_SECONDS = 600;
export const DEFAULT_API_SINCE = "2026-10-02T20:21:47Z"; // first deploy with request logging on
const MCP_DS = "indexagentica_mcp";
const HITS_DS = "indexagentica_hits";
const ROLLUP_VERSION = 3; // v2: internal traffic excluded, breakdowns added; v3: retro rule without the colo gate (older days are recomputed)
// Canonical tool names + unadvertised aliases come from src/tools.js so the stats can't drift
// from the server (request_listing was missing here, so its calls were bucketed as unknown_tool).
import { canonicalToolName } from "./tools.js";
const KNOWN_OPS = ["search", "get_entry", "get_content", "list_content", "list_categories"];
const TOP_N = 10;
const TOP_MIN = 3; // client names / UA families are only published once seen this many times
const KEEP_PER_DAY = 200;

export class StatsError extends Error {}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00Z`);
const sqlTime = (ms) => `toDateTime('${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}')`;

export function sinceOf(env) {
  const api = env.STATS_API_SINCE || DEFAULT_API_SINCE;
  const site = env.STATS_BEACON_SINCE || api;
  return { site_beacon: site, mcp_api: api };
}

// ---- internal traffic (src/internal.js) ----
// Rows logged since 2026-10-12 carry traffic = internal|outside (API blob18, hits blob8).
// Older rows (traffic = '') are matched retroactively by the signature of our own sessions:
// our E2E suite calls itself "e2e" (clientInfo), and the documented verification sessions below
// used curl, node, Python or headless Chrome from the US (our shared box; the Cloudflare colo
// varies, so it is not part of the rule). Outside traffic in those windows with the same
// generic clients cannot be told apart and is excluded too (documented as a caveat).
export const RETRO_WINDOWS = [
  ["2026-10-02 20:15:00", "2026-10-02 20:45:00"], // launch: deploy + live verification
  ["2026-10-03 04:55:00", "2026-10-03 05:50:00"], // usage-stats feature: live E2E, beacon and footer checks
];
const inWindows = RETRO_WINDOWS.map(([a, b]) => `(timestamp >= toDateTime('${a}') AND timestamp < toDateTime('${b}'))`).join(" OR ");
const BOX_UA = "(blob7 LIKE 'curl/%' OR blob7 = 'node' OR blob7 LIKE 'python%' OR blob7 LIKE '%HeadlessChrome%' OR blob7 LIKE 'indexagentica%')";
export const API_RETRO = `(blob18 = '' AND (blob5 = 'e2e' OR (blob12 = 'US' AND ${BOX_UA} AND (${inWindows}))))`;
export const API_INTERNAL = `(blob18 = 'internal' OR ${API_RETRO})`;
// Site beacons before the flag: our own curl + headless-browser checks during the beacon launch session.
export const HITS_RETRO = "(blob8 = '' AND blob7 = 'US' AND timestamp >= toDateTime('2026-10-03 05:00:00') AND timestamp < toDateTime('2026-10-03 05:50:00'))";
export const HITS_INTERNAL = `(blob8 = 'internal' OR ${HITS_RETRO})`;

export function emptyTotals() {
  return {
    site: {
      page_views: 0, outbound_clicks: 0, outbound_clicks_by_entry: {},
      downloads: { total: 0, zip: 0, skill_md: 0, by_skill: {} }, // clicks on the site (beacon)
      direct_downloads: { total: 0, zip: 0, skill_md: 0, by_skill: {}, crawlers_and_probes: { total: 0, head: 0, bot: 0 } }, // GET /skills/* on this host
    },
    mcp: { requests: 0, tool_calls: 0, tool_calls_by_tool: {}, by_client: { agent: 0, human: 0 }, clients: {} },
    api: { requests: 0, by_operation: {}, by_client: { agent: 0, human: 0 } },
    agent_vs_human: { agent: 0, human: 0 },
    user_agent_families: {},
    internal_excluded: { mcp_requests: 0, api_requests: 0, page_views: 0, outbound_clicks: 0, downloads: 0, direct_downloads: 0, by_rule: { header: 0, ua: 0, ip: 0, retroactive: 0 } },
  };
}

/** Deep numeric sum of totals objects (keys missing on either side count as 0). */
export function addTotals(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if ((x && typeof x === "object") || (y && typeof y === "object")) out[k] = addTotals(x || {}, y || {});
    else out[k] = n(x) + n(y);
  }
  return out;
}

/** Self-reported MCP client name -> safe, low-cardinality label. */
export function cleanName(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9._ -]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** User-Agent -> family label (bot name, "browser", "headless-chrome", or the product token). */
export function uaFamily(ua, classify) {
  const s = String(ua || "");
  if (!s) return "(none)";
  const bot = /([a-z0-9._-]*(?:bot|crawler|spider))\b/i.exec(s);
  if (bot && bot[1]) return cleanName(bot[1]) || "bot";
  if (/HeadlessChrome/i.test(s)) return "headless-chrome";
  if (classify(s) === "human") return "browser";
  const m = /^([A-Za-z0-9._-]+)/.exec(s);
  return (m && cleanName(m[1])) || "other";
}

const bump = (o, k, c) => { o[k] = (o[k] || 0) + c; };
const ID_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Turn SQL result rows into totals. classify(ua) is used for rows logged before ua_class existed. */
export function totalsFromRows({ api = [], legacy = [], hits = [], clients = [], uas = [], internalApi = [], internalHits = [] }, classify) {
  const t = emptyTotals();
  for (const r of api) {
    const c = n(r.n);
    const route = r.route === "mcp" ? "mcp" : r.route === "rest" ? "api" : null;
    if (!route) continue;
    t[route].requests += c;
    if (route === "mcp" && r.method === "tools/call") {
      t.mcp.tool_calls += c;
      // Only the server's own tool names are published; anything a client invents is bucketed.
      bump(t.mcp.tool_calls_by_tool, canonicalToolName(r.tool) || "unknown_tool", c);
    }
    if (route === "api") bump(t.api.by_operation, KNOWN_OPS.includes(r.tool) ? r.tool : "other", c);
    if (r.cls === "human" || r.cls === "agent") {
      t[route].by_client[r.cls] += c;
      t.agent_vs_human[r.cls] += c;
    }
  }
  for (const r of legacy) {
    const c = n(r.n);
    const route = r.route === "mcp" ? "mcp" : r.route === "rest" ? "api" : null;
    if (!route) continue;
    const cls = classify(r.ua || "");
    t[route].by_client[cls] += c;
    t.agent_vs_human[cls] += c;
  }
  for (const r of hits) {
    const c = n(r.n);
    if (r.event === "pageview") t.site.page_views += c;
    else if (r.event === "click") {
      t.site.outbound_clicks += c;
      if (ID_OK.test(r.id || "")) bump(t.site.outbound_clicks_by_entry, r.id, c);
    } else if (r.event === "download") {
      t.site.downloads.total += c;
      if (r.kind === "zip" || r.kind === "skill_md") t.site.downloads[r.kind] += c;
      if (ID_OK.test(r.id || "")) bump(t.site.downloads.by_skill, r.id, c);
    } else if (r.event === "direct") {
      const dd = t.site.direct_downloads;
      if (r.probe === "head" || r.probe === "bot") {
        dd.crawlers_and_probes.total += c;
        dd.crawlers_and_probes[r.probe] += c;
        continue;
      }
      dd.total += c;
      if (r.kind === "zip" || r.kind === "skill_md") dd[r.kind] += c;
      if (ID_OK.test(r.id || "")) bump(dd.by_skill, r.id, c);
    }
  }
  for (const r of clients) { const k = cleanName(r.client); if (k) bump(t.mcp.clients, k, n(r.n)); }
  for (const r of uas) bump(t.user_agent_families, uaFamily(r.ua, classify), n(r.n));
  const ex = t.internal_excluded;
  for (const r of internalApi) {
    const c = n(r.n);
    if (r.route === "mcp") ex.mcp_requests += c; else if (r.route === "rest") ex.api_requests += c; else continue;
    bump(ex.by_rule, ["header", "ua", "ip"].includes(r.rule) ? r.rule : "retroactive", c);
  }
  for (const r of internalHits) {
    const c = n(r.n);
    const key = r.event === "pageview" ? "page_views" : r.event === "click" ? "outbound_clicks" : r.event === "download" ? "downloads" : r.event === "direct" ? "direct_downloads" : null;
    if (!key) continue;
    ex[key] += c;
    bump(ex.by_rule, ["header", "ua", "ip"].includes(r.rule) ? r.rule : "retroactive", c);
  }
  return t;
}

export async function sql(env, query) {
  const res = await fetch(SQL_URL(env.CF_ACCOUNT_ID), {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "text/plain" },
    body: query,
  });
  const text = await res.text();
  if (!res.ok) {
    if (/unknown table|does not exist|not found/i.test(text) && query.includes(HITS_DS)) return []; // no beacon written yet
    throw new StatsError(`Analytics Engine SQL API returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new StatsError("Analytics Engine SQL API returned non-JSON"); }
  return Array.isArray(j.data) ? j.data : [];
}

/**
 * Admin diagnostics (GET /v1/admin/tool-calls, Bearer REQUESTS_ADMIN_TOKEN): outside tools/call
 * rows of the last `hours` grouped by requested tool name and client, so unknown names can be
 * investigated without exposing them on the public /stats.
 */
export async function toolCallBreakdown(env, hours = 48, now = Date.now()) {
  const h = Math.min(Math.max(Math.round(Number(hours) || 48), 1), 24 * 90);
  const cond = `timestamp >= ${sqlTime(now - h * 3600000)} AND blob1 = 'mcp' AND blob3 = 'tools/call' AND NOT ${API_INTERNAL}`;
  const rows = await sql(env, `SELECT blob4 AS tool, blob5 AS client, blob6 AS client_version, blob7 AS ua, blob10 AS outcome, blob11 AS detail, SUM(_sample_interval) AS n, MIN(timestamp) AS first, MAX(timestamp) AS last FROM ${MCP_DS} WHERE ${cond} GROUP BY tool, client, client_version, ua, outcome, detail ORDER BY n DESC LIMIT 500 FORMAT JSON`);
  const by_tool = {};
  const unknown = [];
  for (const r of rows) {
    const c = n(r.n);
    const canon = canonicalToolName(r.tool);
    bump(by_tool, r.tool || "(empty)", c);
    if (canon !== r.tool) unknown.push({ tool: r.tool, resolves_to: canon, client: r.client, client_version: r.client_version, ua: r.ua, outcome: r.outcome, detail: r.detail, n: c, first: r.first, last: r.last });
  }
  return { hours: h, generated: new Date(now).toISOString(), by_tool, non_canonical: unknown, rows: rows.length };
}

/** Totals for one time condition (SQL WHERE fragment): outside traffic, plus what was excluded. */
export async function queryTotals(env, cond, classify) {
  const out = `${cond} AND NOT ${API_INTERNAL}`;
  const hout = `${cond} AND NOT ${HITS_INTERNAL}`;
  const S = "SUM(_sample_interval) AS n";
  const [api, hits, clients, uas, internalApi, internalHits] = await Promise.all([
    sql(env, `SELECT blob1 AS route, blob3 AS method, blob4 AS tool, blob17 AS cls, ${S} FROM ${MCP_DS} WHERE ${out} GROUP BY route, method, tool, cls FORMAT JSON`),
    sql(env, `SELECT blob1 AS event, blob5 AS kind, blob3 AS id, blob10 AS probe, ${S} FROM ${HITS_DS} WHERE ${hout} GROUP BY event, kind, id, probe FORMAT JSON`),
    sql(env, `SELECT blob5 AS client, ${S} FROM ${MCP_DS} WHERE ${out} AND blob1 = 'mcp' AND blob5 != '' GROUP BY client ORDER BY n DESC LIMIT ${KEEP_PER_DAY} FORMAT JSON`),
    sql(env, `SELECT blob7 AS ua, ${S} FROM ${MCP_DS} WHERE ${out} GROUP BY ua ORDER BY n DESC LIMIT 500 FORMAT JSON`),
    sql(env, `SELECT blob1 AS route, blob19 AS rule, ${S} FROM ${MCP_DS} WHERE ${cond} AND ${API_INTERNAL} GROUP BY route, rule FORMAT JSON`),
    sql(env, `SELECT blob1 AS event, blob9 AS rule, ${S} FROM ${HITS_DS} WHERE ${cond} AND ${HITS_INTERNAL} GROUP BY event, rule FORMAT JSON`),
  ]);
  // Rows written before the ua_class column existed: classify from the stored (truncated) User-Agent.
  const legacy = api.some((r) => r.cls !== "human" && r.cls !== "agent")
    ? await sql(env, `SELECT blob1 AS route, blob7 AS ua, ${S} FROM ${MCP_DS} WHERE ${out} AND blob17 = '' GROUP BY route, ua FORMAT JSON`)
    : [];
  return totalsFromRows({ api, legacy, hits, clients, uas, internalApi, internalHits }, classify);
}

const rangeCond = (fromMs, toMs) => `timestamp >= ${sqlTime(fromMs)}${toMs ? ` AND timestamp < ${sqlTime(toMs)}` : ""}`;

function firstDay(env) {
  const s = sinceOf(env);
  return isoDay(Math.min(Date.parse(s.site_beacon), Date.parse(s.mcp_api)));
}

const topMap = (m, k) => Object.fromEntries(Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, k));

function readDay(raw) {
  try { const d = JSON.parse(raw); return d && d.v === ROLLUP_VERSION ? d : null; } catch { return null; }
}

/**
 * Store per-day totals in KV for completed, settled UTC days that are missing or from an older
 * rollup version (so rule changes apply retroactively while the raw data is still retained).
 * @returns {Promise<{stored: string[], skipped_expired: string[]}>}
 */
export async function rollup(env, classify, { now = Date.now(), maxDays = 5 } = {}) {
  const out = { stored: [], skipped_expired: [] };
  if (!env.STATS_KV || !env.CF_ANALYTICS_TOKEN) return out;
  for (let d = dayStart(firstDay(env)); d + DAY_MS + SETTLE_MS <= now && out.stored.length < maxDays; d += DAY_MS) {
    const key = `day:${isoDay(d)}`;
    if (readDay(await env.STATS_KV.get(key))) continue;
    if (now - d > RETENTION_DAYS * DAY_MS) { out.skipped_expired.push(isoDay(d)); continue; }
    const totals = await queryTotals(env, rangeCond(d, d + DAY_MS), classify);
    totals.mcp.clients = topMap(totals.mcp.clients, KEEP_PER_DAY);
    totals.user_agent_families = topMap(totals.user_agent_families, KEEP_PER_DAY);
    await env.STATS_KV.put(key, JSON.stringify({ v: ROLLUP_VERSION, day: isoDay(d), computed_at: new Date(now).toISOString(), totals }));
    out.stored.push(isoDay(d));
  }
  return out;
}

/** All-time: stored days (contiguous from the first day) + live query from the first unstored day. */
export async function allTime(env, classify, now = Date.now()) {
  let total = emptyTotals();
  let d = dayStart(firstDay(env));
  let stored = 0, lastStored = null;
  if (env.STATS_KV) {
    for (; d < dayStart(isoDay(now)); d += DAY_MS) {
      const day = readDay(await env.STATS_KV.get(`day:${isoDay(d)}`));
      if (!day) break;
      total = addTotals(total, day.totals);
      stored++;
      lastStored = isoDay(d);
    }
  }
  const complete = now - d <= RETENTION_DAYS * DAY_MS;
  total = addTotals(total, await queryTotals(env, rangeCond(d), classify));
  return { totals: total, rollup: { version: ROLLUP_VERSION, days_stored: stored, last_stored_day: lastStored, live_from: new Date(d).toISOString(), complete } };
}

const topList = (m, key) => Object.entries(m || {}).filter(([, c]) => c >= TOP_MIN).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_N).map(([name, c]) => ({ [key]: name, requests: c }));
const sortMap = (m) => Object.fromEntries(Object.entries(m || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

/** Skill downloads overall and per skill: site clicks + direct downloads (probes not included). */
export function skillDownloads(site) {
  const clicks = (site && site.downloads) || {}, direct = (site && site.direct_downloads) || {};
  const by = {};
  for (const [id, c] of Object.entries(clicks.by_skill || {})) (by[id] ||= { total: 0, clicks: 0, direct: 0 }).clicks += n(c);
  for (const [id, c] of Object.entries(direct.by_skill || {})) (by[id] ||= { total: 0, clicks: 0, direct: 0 }).direct += n(c);
  for (const v of Object.values(by)) v.total = v.clicks + v.direct;
  const sorted = Object.fromEntries(Object.entries(by).sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1)));
  return { total: n(clicks.total) + n(direct.total), clicks: n(clicks.total), direct: n(direct.total), by_skill: sorted };
}

/** Public shape of one window: full maps become ranked top lists; nothing raw is exposed. */
export function presentWindow(t) {
  const { clients, ...mcp } = t.mcp;
  const { user_agent_families, ...rest } = t;
  const dd = addTotals(emptyTotals().site.direct_downloads, t.site.direct_downloads || {}); // days stored before direct downloads existed
  const site = { ...t.site, direct_downloads: { ...dd, by_skill: sortMap(dd.by_skill) } };
  return {
    ...rest,
    site: { ...site, outbound_clicks_by_entry: sortMap(t.site.outbound_clicks_by_entry), downloads: { ...t.site.downloads, by_skill: sortMap(t.site.downloads.by_skill) }, skill_downloads: skillDownloads(site) },
    mcp: { ...mcp, top_clients: topList(clients, "client") },
    top_user_agent_families: topList(user_agent_families, "family"),
  };
}

export function collectingBody(env, base, message) {
  return {
    status: "collecting",
    message,
    since: sinceOf(env),
    generated: new Date().toISOString(),
    stats_url: `${base}/stats`,
    privacy: "https://indexagentica.com/agents/#privacy",
  };
}

const DEFINITIONS = {
  "site.page_views": "Page views reported by the site's inline beacon (browsers with JavaScript; skipped for navigator.webdriver, Do Not Track and Global Privacy Control).",
  "site.outbound_clicks": "Clicks on a listing's outbound links (website, repo, docs, sources) on its entry page.",
  "site.downloads": "Clicks on skill downloads (zip or raw SKILL.md) on the site (browser beacon). Direct downloads are in site.direct_downloads.",
  "site.direct_downloads": "Direct skill downloads: GET requests to https://mcp.indexagentica.com/skills/<id>.zip or /skills/<id>/SKILL.md (the links in llms.txt, the JSON API and MCP get_content), which then redirect to the static file. Counted since the route went live (2026-10-19). HEAD requests and crawler / link-checker / monitor User-Agents are not downloads; they are counted in crawlers_and_probes (head, bot). Fetching the static files on indexagentica.com directly is not counted.",
  "site.skill_downloads": "Total skill downloads = site.downloads (clicks) + site.direct_downloads (excluding crawlers_and_probes), overall and by skill. A click on the site that is then fetched through a counted link is not double-counted, because the site's own buttons link to the static files.",
  "mcp.requests": "All POST /mcp requests (initialize, tools/list, tools/call, ...).",
  "mcp.tool_calls": "MCP tools/call requests, by tool.",
  "api.requests": "REST/JSON requests to the search API (search, get_entry, get_content, list_content, list_categories, other = landing, OpenAPI, server card, entry list, errors). /stats, /hit and /health are not counted.",
  agent_vs_human: "MCP + REST requests split by User-Agent: browser user agents count as human, everything else as agent/programmatic.",
  "site.downloads.by_skill": "Skill download clicks by skill id.",
  "site.direct_downloads.by_skill": "Direct skill downloads by skill id.",
  "site.outbound_clicks_by_entry": "Outbound link clicks by listing id.",
  "mcp.top_clients": `Most frequent MCP client names (clientInfo.name sent on initialize, self-reported, lowercased and stripped to [a-z0-9._ -]); top ${TOP_N}, only names seen at least ${TOP_MIN} times.`,
  top_user_agent_families: `MCP + REST requests by User-Agent family (bot/crawler name, "browser", "headless-chrome", or the first product token); top ${TOP_N}, only families seen at least ${TOP_MIN} times.`,
  internal_excluded: "Requests and beacons from our own testing and agents, excluded from every other number in the window, with the rule that matched (see internal_rules).",
};

const INTERNAL_RULES = {
  header: "Request carries the header X-Indexagentica-Internal: 1 (our tests, monitors and agents send it).",
  ua: "User-Agent contains \"indexagentica\" (our own clients identify themselves, e.g. indexagentica-e2e/1).",
  ip: "Client IP inside a configured internal range (INTERNAL_IPS secret; unset unless our egress is stable).",
  retroactive: "Logged before 2026-10-12, when the flag did not exist yet: matched by the signature of our own sessions (MCP client name e2e, our test suite; or curl/node/python/headless-Chrome from the US during the documented launch and verification windows 2026-10-02 20:15-20:45 and 2026-10-03 04:55-05:50 UTC; site beacons from the US between 05:00 and 05:50 UTC on 2026-10-03).",
};

export async function computeStats(env, classify, base, now = Date.now()) {
  // Lazy catch-up if the cron missed a day. Each day is ~7 SQL subrequests; 3 windows use ~21 more,
  // so 2 days keeps one invocation under the Workers Free limit of 50 subrequests.
  await rollup(env, classify, { now, maxDays: 2 });
  const [h24, d7, all] = await Promise.all([
    queryTotals(env, "timestamp > NOW() - INTERVAL '1' DAY", classify),
    queryTotals(env, "timestamp > NOW() - INTERVAL '7' DAY", classify),
    allTime(env, classify, now),
  ]);
  return {
    status: "ok",
    generated: new Date(now).toISOString(),
    since: sinceOf(env),
    windows: { last_24h: presentWindow(h24), last_7d: presentWindow(d7), all_time: presentWindow(all.totals) },
    traffic: "outside",
    internal_rules: INTERNAL_RULES,
    all_time_method: "Per-UTC-day totals stored in Workers KV (daily cron) plus a live Analytics Engine query from the first day not yet stored.",
    rollup: all.rollup,
    definitions: DEFINITIONS,
    caveats: [
      "Counting started at the `since` timestamps; nothing before them is included or estimated.",
      "The site is static (GitHub Pages) with no server logs: views without JavaScript (most crawlers and agents fetching HTML, llms.txt or JSON from indexagentica.com) are not counted.",
      "Human vs agent is a User-Agent heuristic, not identity.",
      "Our own traffic is excluded by the rules in internal_rules. Before 2026-10-12 it is matched retroactively by session signature, which is a best effort: internal sessions that looked like outside traffic (e.g. other clients or other times) may still be counted, outside requests with the same generic clients inside those windows are excluded, and the owner's own browser visits are not identifiable.",
      "MCP client names are self-reported by the client and can be anything.",
      "Analytics Engine data can lag a few minutes; this response is cached for up to 10 minutes.",
    ],
    privacy: "https://indexagentica.com/agents/#privacy",
    stats_url: `${base}/stats`,
    cache_seconds: CACHE_SECONDS,
  };
}

// ---- GET /stats with in-memory + Cache API caching and request coalescing ----
let memo = null; // { at, body, status }
let inflight = null;

export function _resetStatsCache() { memo = null; inflight = null; }

export async function statsResponse(request, env, ctx, base, classify) {
  const now = Date.now();
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return { status: 200, ttl: 60, body: collectingBody(env, base, "Usage is being logged, but aggregate numbers are not published yet: the stats query token (CF_ANALYTICS_TOKEN) is not configured on the server.") };
  }
  if (memo && now - memo.at < memo.ttl * 1000) return memo;
  let cache = null;
  const key = new Request(`${base}/stats?__v=${ROLLUP_VERSION}.dl`, { method: "GET" });
  try { cache = typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        memo = { at: now, ttl: 60, status: 200, body: await hit.json() }; // short local memo; the edge copy holds the 10 min
        return memo;
      }
    } catch { /* workers.dev has no Cache API; fall through */ }
  }
  if (!inflight) {
    inflight = computeStats(env, classify, base, now)
      .then((body) => {
        memo = { at: Date.now(), ttl: CACHE_SECONDS, status: 200, body };
        if (cache) {
          const put = cache.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(put);
        }
        return memo;
      })
      .catch((err) => {
        const r = { at: Date.now(), ttl: 60, status: 503, body: { status: "unavailable", message: `Usage stats are temporarily unavailable: ${err && err.message ? err.message : err}`, since: sinceOf(env), generated: new Date().toISOString() } };
        memo = r;
        return r;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
