// Public usage stats: GET /stats and the daily KV rollup (cron).
//
// Sources (Workers Analytics Engine, queried through the SQL API with the
// CF_ANALYTICS_TOKEN secret, Account Analytics Read):
//   indexagentica_mcp   one row per MCP / REST request (src/analytics.js)
//   indexagentica_hits  one row per site beacon (src/hits.js)
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
const ROLLUP_VERSION = 1;
const KNOWN_TOOLS = ["search", "get_entry", "get_content", "list_categories"];
const KNOWN_OPS = ["search", "get_entry", "get_content", "list_content", "list_categories"];

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

export function emptyTotals() {
  return {
    site: { page_views: 0, outbound_clicks: 0, downloads: { total: 0, zip: 0, skill_md: 0 } },
    mcp: { requests: 0, tool_calls: 0, tool_calls_by_tool: {}, by_client: { agent: 0, human: 0 } },
    api: { requests: 0, by_operation: {}, by_client: { agent: 0, human: 0 } },
    agent_vs_human: { agent: 0, human: 0 },
  };
}

/** Deep numeric sum of totals objects (keys missing on either side count as 0). */
export function addTotals(a, b) {
  const out = Array.isArray(a) ? [] : {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if ((x && typeof x === "object") || (y && typeof y === "object")) out[k] = addTotals(x || {}, y || {});
    else out[k] = n(x) + n(y);
  }
  return out;
}

/** Turn SQL result rows into totals. classify(ua) is used for rows logged before ua_class existed. */
export function totalsFromRows(apiRows, legacyUaRows, hitRows, classify) {
  const t = emptyTotals();
  for (const r of apiRows) {
    const c = n(r.n);
    const route = r.route === "mcp" ? "mcp" : r.route === "rest" ? "api" : null;
    if (!route) continue;
    t[route].requests += c;
    if (route === "mcp" && r.method === "tools/call") {
      t.mcp.tool_calls += c;
      // Only the server's own tool names are published; anything a client invents is bucketed.
      const tool = KNOWN_TOOLS.includes(r.tool) ? r.tool : "unknown_tool";
      t.mcp.tool_calls_by_tool[tool] = (t.mcp.tool_calls_by_tool[tool] || 0) + c;
    }
    if (route === "api") {
      const op = KNOWN_OPS.includes(r.tool) ? r.tool : "other";
      t.api.by_operation[op] = (t.api.by_operation[op] || 0) + c;
    }
    if (r.cls === "human" || r.cls === "agent") {
      t[route].by_client[r.cls] += c;
      t.agent_vs_human[r.cls] += c;
    }
  }
  for (const r of legacyUaRows) {
    const c = n(r.n);
    const route = r.route === "mcp" ? "mcp" : r.route === "rest" ? "api" : null;
    if (!route) continue;
    const cls = classify(r.ua || "");
    t[route].by_client[cls] += c;
    t.agent_vs_human[cls] += c;
  }
  for (const r of hitRows) {
    const c = n(r.n);
    if (r.event === "pageview") t.site.page_views += c;
    else if (r.event === "click") t.site.outbound_clicks += c;
    else if (r.event === "download") {
      t.site.downloads.total += c;
      if (r.kind === "zip" || r.kind === "skill_md") t.site.downloads[r.kind] += c;
    }
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

/** Totals for one time condition (SQL WHERE fragment). */
export async function queryTotals(env, cond, classify) {
  const [apiRows, hitRows] = await Promise.all([
    sql(env, `SELECT blob1 AS route, blob3 AS method, blob4 AS tool, blob17 AS cls, SUM(_sample_interval) AS n FROM ${MCP_DS} WHERE ${cond} GROUP BY route, method, tool, cls FORMAT JSON`),
    sql(env, `SELECT blob1 AS event, blob5 AS kind, SUM(_sample_interval) AS n FROM ${HITS_DS} WHERE ${cond} GROUP BY event, kind FORMAT JSON`),
  ]);
  // Rows written before the ua_class column existed: classify from the stored (truncated) User-Agent.
  const legacy = apiRows.some((r) => r.cls !== "human" && r.cls !== "agent")
    ? await sql(env, `SELECT blob1 AS route, blob7 AS ua, SUM(_sample_interval) AS n FROM ${MCP_DS} WHERE ${cond} AND blob17 = '' GROUP BY route, ua FORMAT JSON`)
    : [];
  return totalsFromRows(apiRows, legacy, hitRows, classify);
}

const rangeCond = (fromMs, toMs) => `timestamp >= ${sqlTime(fromMs)}${toMs ? ` AND timestamp < ${sqlTime(toMs)}` : ""}`;

function firstDay(env) {
  const s = sinceOf(env);
  return isoDay(Math.min(Date.parse(s.site_beacon), Date.parse(s.mcp_api)));
}

/**
 * Store per-day totals in KV for completed, settled UTC days that are missing.
 * @returns {Promise<{stored: string[], skipped_expired: string[]}>}
 */
export async function rollup(env, classify, { now = Date.now(), maxDays = 100 } = {}) {
  const out = { stored: [], skipped_expired: [] };
  if (!env.STATS_KV || !env.CF_ANALYTICS_TOKEN) return out;
  for (let d = dayStart(firstDay(env)); d + DAY_MS + SETTLE_MS <= now && out.stored.length < maxDays; d += DAY_MS) {
    const key = `day:${isoDay(d)}`;
    if (await env.STATS_KV.get(key)) continue;
    if (now - d > RETENTION_DAYS * DAY_MS) { out.skipped_expired.push(isoDay(d)); continue; }
    const totals = await queryTotals(env, rangeCond(d, d + DAY_MS), classify);
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
      const raw = await env.STATS_KV.get(`day:${isoDay(d)}`);
      if (!raw) break;
      try { total = addTotals(total, JSON.parse(raw).totals); } catch { break; }
      stored++;
      lastStored = isoDay(d);
    }
  }
  const complete = now - d <= RETENTION_DAYS * DAY_MS;
  total = addTotals(total, await queryTotals(env, rangeCond(d), classify));
  return { totals: total, rollup: { days_stored: stored, last_stored_day: lastStored, live_from: new Date(d).toISOString(), complete } };
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
  "site.downloads": "Clicks on skill downloads (zip or raw SKILL.md) on the site. Direct downloads (curl, agents) are not counted.",
  "mcp.requests": "All POST /mcp requests (initialize, tools/list, tools/call, ...).",
  "mcp.tool_calls": "MCP tools/call requests, by tool.",
  "api.requests": "REST/JSON requests to the search API (search, get_entry, get_content, list_content, list_categories, other = landing, OpenAPI, server card, entry list, errors). /stats, /hit and /health are not counted.",
  agent_vs_human: "MCP + REST requests split by User-Agent: browser user agents count as human, everything else as agent/programmatic.",
};

export async function computeStats(env, classify, base, now = Date.now()) {
  await rollup(env, classify, { now, maxDays: 3 }); // lazy catch-up if the cron missed a day
  const [h24, d7, all] = await Promise.all([
    queryTotals(env, "timestamp > NOW() - INTERVAL '1' DAY", classify),
    queryTotals(env, "timestamp > NOW() - INTERVAL '7' DAY", classify),
    allTime(env, classify, now),
  ]);
  return {
    status: "ok",
    generated: new Date(now).toISOString(),
    since: sinceOf(env),
    windows: { last_24h: h24, last_7d: d7, all_time: all.totals },
    all_time_method: "Per-UTC-day totals stored in Workers KV (daily cron) plus a live Analytics Engine query from the first day not yet stored.",
    rollup: all.rollup,
    definitions: DEFINITIONS,
    caveats: [
      "Counting started at the `since` timestamps; nothing before them is included or estimated.",
      "The site is static (GitHub Pages) with no server logs: views without JavaScript (most crawlers and agents fetching HTML, llms.txt or JSON from indexagentica.com) are not counted.",
      "Human vs agent is a User-Agent heuristic, not identity.",
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
  const key = new Request(`${base}/stats?__v=1`, { method: "GET" });
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
