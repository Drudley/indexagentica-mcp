// Usage stats: UA classification, /hit validation, /stats (collecting + aggregated), KV rollup.
import test from "node:test";
import assert from "node:assert/strict";
import { uaClass } from "../src/ua.js";
import { validateHit, knownPaths, entryHosts, hitDataPoint, HIT_BLOBS } from "../src/hits.js";
import { totalsFromRows, addTotals, emptyTotals, rollup, allTime, _resetStatsCache, queryTotals, API_INTERNAL, API_RETRO, HITS_INTERNAL, uaFamily, cleanName, sql, SNAPSHOT_KEY, CACHE_SECONDS, API_SELF, API_SESSIONS } from "../src/stats.js";
import { internalRule } from "../src/internal.js";
import { prepare } from "../src/data.js";
import { dataPoint, newLog, BLOBS } from "../src/analytics.js";
import worker from "../src/index.js";

const SITE = "https://site.test";
const INDEX = {
  categories: [{ slug: "apis", name: "APIs" }],
  entries: [{ id: "exa-api", name: "Exa API", category: "apis", summary: "Search API.", url: "https://exa.ai", repo: "https://github.com/exa-labs/exa-py", sources: ["https://docs.exa.ai/reference"], agent_access: { openapi: "https://api.exa.ai/openapi.json" } }],
};
const LONGFORM = { items: [{ type: "skill", id: "web-lookup", title: "Web lookup", summary: "s", links: {} }, { type: "guide", id: "add-mcp", title: "G", summary: "s", links: {} }] };

// Fake upstream: the site indexes plus the Analytics Engine SQL API.
const sqlCalls = [];
let sqlRows = () => [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${SITE}/api/index.json`) return new Response(JSON.stringify(INDEX));
  if (u === `${SITE}/api/longform.json`) return new Response(JSON.stringify(LONGFORM));
  if (u.includes("/analytics_engine/sql")) {
    sqlCalls.push({ q: String(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify({ data: sqlRows(String(init.body)) }));
  }
  return new Response("not found", { status: 404 });
};

const D = prepare(INDEX, LONGFORM);
const ORIGIN = { origin: "https://indexagentica.com" };
const BASE_ENV = { DATA_BASE_URL: SITE, HIT_ORIGINS: "https://indexagentica.com" };
const hit = (body, headers = ORIGIN, raw) => new Request("https://mcp.test/hit", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", ...headers }, body: raw ?? JSON.stringify(body) });
const recorder = () => { const points = []; return { points, HITS: { writeDataPoint: (p) => points.push(p) }, ANALYTICS: { writeDataPoint: () => { throw new Error("hits must not go to ANALYTICS"); } } }; };

test("UA classification: browsers are human, everything else agent", () => {
  const human = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  ];
  const agent = [
    "", "curl/8.5.0", "node", "python-httpx/0.27", "claude-code/2.1.0", "Go-http-client/2.0",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 ClaudeBot",
  ];
  for (const u of human) assert.equal(uaClass(u), "human", u);
  for (const u of agent) assert.equal(uaClass(u), "agent", u);
});

test("API request log carries ua_class (appended column, existing layout unchanged)", () => {
  assert.equal(BLOBS.indexOf("target_id"), 15, "existing columns keep their positions");
  assert.equal(BLOBS.indexOf("ua_class"), 16, "ua_class is blob17");
  const p = dataPoint(newLog(new Request("https://mcp.test/search", { headers: { "user-agent": "curl/8" } }), "/search"), 200, {});
  assert.equal(p.blobs[16], "agent");
  assert.ok(p.blobs.length <= 20);
});

test("hit validation: allowlisted events, known paths/ids/hosts, no extra fields", () => {
  assert.ok(knownPaths(D).has("/entries/exa-api/") && knownPaths(D).has("/skills/web-lookup/") && knownPaths(D).has("/guides/add-mcp/") && knownPaths(D).has("/categories/apis/"));
  assert.deepEqual([...entryHosts(D.byId.get("exa-api"))].sort(), ["api.exa.ai", "docs.exa.ai", "exa.ai", "github.com"]);
  const ok = (b) => validateHit(b, D).ok;
  assert.ok(ok({ t: "pageview", p: "/" }));
  assert.ok(ok({ t: "pageview", p: "/entries/exa-api/" }));
  assert.ok(ok({ t: "click", p: "/entries/exa-api/", id: "exa-api", h: "docs.exa.ai" }));
  assert.ok(ok({ t: "download", p: "/skills/web-lookup/", id: "web-lookup", k: "zip" }));
  assert.ok(ok({ t: "download", p: "/skills/", id: "web-lookup", k: "skill_md" }));
  for (const b of [
    null, [], {}, { t: "event", p: "/" }, { t: "pageview" }, { t: "pageview", p: "/nope/" }, { t: "pageview", p: "/?q=secret" },
    { t: "pageview", p: "/", uid: "abc" }, { t: "pageview", p: "/", id: "exa-api" }, { t: "pageview", p: "/" + "a".repeat(300) },
    { t: "click", p: "/entries/exa-api/", id: "exa-api", h: "evil.example" }, { t: "click", p: "/", id: "exa-api", h: "exa.ai" },
    { t: "click", p: "/entries/exa-api/", id: "nope", h: "exa.ai" }, { t: "click", p: "/entries/exa-api/", id: "exa-api", h: "exa.ai/x" },
    { t: "download", p: "/skills/", id: "add-mcp", k: "zip" }, { t: "download", p: "/skills/", id: "web-lookup", k: "tar" },
  ]) assert.equal(ok(b), false, JSON.stringify(b));
  const dp = hitDataPoint({ event: "click", path: "/entries/exa-api/", id: "exa-api", host: "exa.ai", kind: "" }, "curl/8", { country: "SE" });
  assert.equal(dp.indexes[0], "hit:click");
  assert.equal(dp.blobs.length, HIT_BLOBS.length);
  assert.equal(dp.blobs[HIT_BLOBS.indexOf("ua_class")], "agent");
});

test("POST /hit: 204 + one data point in HITS; rejects bad origin, size, JSON, method; never logs to ANALYTICS", async () => {
  const env = { ...BASE_ENV, ...recorder() };
  const r1 = await worker.fetch(hit({ t: "pageview", p: "/entries/exa-api/" }, { ...ORIGIN, "cf-connecting-ip": "10.1.1.1" }), env, {});
  assert.equal(r1.status, 204);
  assert.equal(env.points.length, 1);
  assert.equal(env.points[0].indexes[0], "hit:pageview");
  assert.ok(!JSON.stringify(env.points).includes("10.1.1.1"), "no IP stored");
  assert.equal((await worker.fetch(hit({ t: "pageview", p: "/" }, {}), env, {})).status, 403, "no Origin");
  assert.equal((await worker.fetch(hit({ t: "pageview", p: "/" }, { origin: "https://evil.example" }), env, {})).status, 403);
  assert.equal((await worker.fetch(hit(null, ORIGIN, "x".repeat(600)), env, {})).status, 413);
  assert.equal((await worker.fetch(hit(null, ORIGIN, "{not json"), env, {})).status, 400);
  const bad = await worker.fetch(hit({ t: "pageview", p: "/nope/" }), env, {});
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /published page/);
  assert.equal((await worker.fetch(new Request("https://mcp.test/hit"), env, {})).status, 405);
  assert.equal(env.points.length, 1, "rejected hits are not stored");
});

test("POST /hit is rate limited on its own counter", async () => {
  const env = { ...BASE_ENV, ...recorder(), RATE_LIMIT_REQUESTS: "2", RATE_LIMIT_PERIOD_SECONDS: "60" };
  const h = { ...ORIGIN, "cf-connecting-ip": "10.2.2.2" };
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await worker.fetch(hit({ t: "pageview", p: "/" }, h), env, {})).status);
  assert.deepEqual(codes, [204, 204, 429]);
  // The API budget for the same IP is untouched.
  assert.equal((await worker.fetch(new Request("https://mcp.test/categories", { headers: { "cf-connecting-ip": "10.2.2.2" } }), env, {})).status, 200);
});

test("GET /stats without the token: status collecting, no numbers", async () => {
  _resetStatsCache();
  const res = await worker.fetch(new Request("https://mcp.test/stats"), { ...BASE_ENV, STATS_BEACON_SINCE: "2026-10-03T05:00:00Z" }, {});
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.status, "collecting");
  assert.equal(b.windows, undefined);
  assert.equal(b.since.site_beacon, "2026-10-03T05:00:00Z");
  assert.equal(b.since.mcp_api, "2026-10-02T20:21:47Z");
  assert.match(res.headers.get("cache-control"), /max-age=60/);
});

test("totals: per-tool breakdown, unknown tools bucketed, legacy rows classified by UA, deep add", () => {
  const t = totalsFromRows({ api:
    [
      { route: "mcp", method: "tools/call", tool: "search", cls: "agent", n: "5" },
      { route: "mcp", method: "tools/call", tool: "<script>x", cls: "agent", n: "1" },
      { route: "mcp", method: "tools/call", tool: "request_listing", cls: "agent", n: "2" },
      { route: "mcp", method: "initialize", tool: "", cls: "human", n: "2" },
      { route: "rest", method: "", tool: "get_entry", cls: "agent", n: "3" },
      { route: "rest", method: "", tool: "", cls: "", n: "4" },
    ],
    legacy: [{ route: "rest", ua: "curl/8", n: "3" }, { route: "rest", ua: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", n: "1" }],
    hits: [{ event: "pageview", kind: "", n: "7" }, { event: "click", kind: "", id: "exa-api", n: "2" }, { event: "download", kind: "zip", id: "web-lookup", n: "1" }],
  }, uaClass);
  assert.equal(t.mcp.requests, 10);
  assert.equal(t.mcp.tool_calls, 8);
  assert.deepEqual(t.mcp.tool_calls_by_tool, { search: 5, unknown_tool: 1, request_listing: 2 });
  assert.equal(t.api.requests, 7);
  assert.deepEqual(t.api.by_operation, { get_entry: 3, other: 4 });
  assert.deepEqual(t.agent_vs_human, { agent: 6 + 2 + 3 + 3, human: 2 + 1 });
  assert.deepEqual(t.site, { page_views: 7, outbound_clicks: 2, outbound_clicks_by_entry: { "exa-api": 2 }, downloads: { total: 1, zip: 1, skill_md: 0, by_skill: { "web-lookup": 1 } }, direct_downloads: emptyTotals().site.direct_downloads });
  const sum = addTotals(t, t);
  assert.equal(sum.mcp.tool_calls_by_tool.search, 10);
  assert.equal(sum.site.downloads.zip, 2);
  assert.deepEqual(addTotals(emptyTotals(), emptyTotals()), emptyTotals());
});

// Route a mocked SQL query to rows by its shape (outside vs internal, api vs hits, breakdowns).
const byShape = (r) => (q) => {
  const hits = q.includes("indexagentica_hits");
  if (/AS rule/.test(q)) return (hits ? r.internalHits : r.internalApi) || [];
  if (hits) return r.hits || [];
  if (/AS client/.test(q)) return r.clients || [];
  if (/blob7 AS ua, SUM/.test(q) && !/AS route/.test(q)) return r.uas || [];
  if (/AS ua/.test(q)) return r.legacy || [];
  return r.api || [];
};

function fakeKV() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

test("rollup stores settled UTC days once; all-time = stored days + live remainder", async () => {
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "10" }], api: [{ route: "mcp", method: "tools/call", tool: "search", cls: "agent", n: "4" }] });
  sqlCalls.length = 0;
  const kv = fakeKV();
  const env = { ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", STATS_KV: kv, STATS_API_SINCE: "2026-10-02T20:21:47Z", STATS_BEACON_SINCE: "2026-10-03T05:00:00Z" };
  const now = Date.parse("2026-10-05T12:00:00Z");
  const r = await rollup(env, uaClass, { now });
  assert.deepEqual(r.stored, ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.match(sqlCalls[0].q, /timestamp >= toDateTime\('2026-10-02 00:00:00'\) AND timestamp < toDateTime\('2026-10-03 00:00:00'\)/);
  assert.match(sqlCalls[0].q, /SUM\(_sample_interval\)/);
  assert.equal(sqlCalls[0].auth, "Bearer tok");
  assert.deepEqual((await rollup(env, uaClass, { now })).stored, [], "idempotent");
  const a = await allTime(env, uaClass, now);
  assert.equal(a.rollup.days_stored, 3);
  assert.equal(a.rollup.live_from, "2026-10-05T00:00:00.000Z");
  assert.equal(a.totals.site.page_views, 40, "3 stored days + live today");
  assert.equal(a.totals.mcp.tool_calls_by_tool.search, 16);
  // A day that just ended is not rolled up before it settles.
  assert.deepEqual((await rollup({ ...env, STATS_KV: fakeKV() }, uaClass, { now: Date.parse("2026-10-03T00:10:00Z") })).stored, []);
});

test("GET /stats with the token: windows, since labels, definitions, cached", async () => {
  _resetStatsCache();
  sqlRows = byShape({
    hits: [{ event: "pageview", kind: "", n: "3" }, { event: "download", kind: "zip", id: "indexagentica-lookup", n: "2" },
      { event: "direct", kind: "zip", id: "indexagentica-lookup", probe: "", n: "4" }, { event: "direct", kind: "skill_md", id: "web-lookup", probe: "", n: "1" },
      { event: "direct", kind: "zip", id: "web-lookup", probe: "head", n: "3" }, { event: "direct", kind: "zip", id: "web-lookup", probe: "bot", n: "2" }],
    api: [{ route: "rest", method: "", tool: "search", cls: "human", n: "2" }],
    clients: [{ client: "Claude-Code", n: "5" }, { client: "rare<b>", n: "1" }],
    uas: [{ ua: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", n: "4" }, { ua: "python-httpx/0.27", n: "2" }],
    internalApi: [{ route: "mcp", rule: "header", n: "6" }, { route: "rest", rule: "", n: "9" }],
    internalHits: [{ event: "pageview", rule: "", n: "1" }],
  });
  sqlCalls.length = 0;
  const env = { ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "s3cr3t-Zq9", STATS_KV: fakeKV(), STATS_BEACON_SINCE: new Date(Date.now() - 3600e3).toISOString(), STATS_API_SINCE: new Date(Date.now() - 7200e3).toISOString() };
  const res = await worker.fetch(new Request("https://mcp.test/stats"), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /max-age=600/);
  const b = await res.json();
  assert.equal(b.status, "ok");
  for (const w of ["last_24h", "last_7d", "all_time"]) {
    assert.equal(b.windows[w].site.page_views, 3, w);
    assert.equal(b.windows[w].api.by_operation.search, 2, w);
    assert.deepEqual(b.windows[w].agent_vs_human, { agent: 0, human: 2 }, w);
  }
  const w = b.windows.all_time;
  assert.deepEqual(w.site.downloads.by_skill, { "indexagentica-lookup": 2 });
  assert.deepEqual(w.site.direct_downloads, { total: 5, zip: 4, skill_md: 1, by_skill: { "indexagentica-lookup": 4, "web-lookup": 1 }, crawlers_and_probes: { total: 5, head: 3, bot: 2 } });
  assert.deepEqual(w.site.skill_downloads, { total: 7, clicks: 2, direct: 5, by_skill: { "indexagentica-lookup": { total: 6, clicks: 2, direct: 4 }, "web-lookup": { total: 1, clicks: 0, direct: 1 } } });
  assert.deepEqual(w.mcp.top_clients, [{ client: "claude-code", requests: 5 }], "lowercased; names seen < 3 times hidden");
  assert.equal(w.mcp.clients, undefined, "raw client map not exposed");
  assert.deepEqual(w.top_user_agent_families, [{ family: "gptbot", requests: 4 }]);
  assert.deepEqual(w.internal_excluded, { mcp_requests: 6, api_requests: 9, page_views: 1, outbound_clicks: 0, downloads: 0, direct_downloads: 0, by_rule: { header: 6, ua: 0, ip: 0, retroactive: 10 } });
  assert.equal(b.traffic, "outside");
  assert.ok(b.internal_rules.header && b.internal_rules.retroactive);
  assert.ok(b.since.site_beacon && b.since.mcp_api && b.definitions && b.caveats.length);
  assert.ok(!JSON.stringify(b).includes("s3cr3t-Zq9"), "token never echoed");
  const n = sqlCalls.length;
  await worker.fetch(new Request("https://mcp.test/stats"), env, { waitUntil() {} });
  assert.equal(sqlCalls.length, n, "second request served from cache");
});

test("GET /stats when the SQL API fails: 503 unavailable, no numbers", async () => {
  _resetStatsCache();
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes("analytics_engine") ? new Response("denied", { status: 401 }) : prev(url, init));
  try {
    const res = await worker.fetch(new Request("https://mcp.test/stats"), { ...BASE_ENV, CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "bad" }, {});
    assert.equal(res.status, 503);
    const b = await res.json();
    assert.equal(b.status, "unavailable");
    assert.equal(b.windows, undefined);
  } finally { globalThis.fetch = prev; }
});

test("aliases /v1/usage and /v1/e behave like /stats and /hit; neither is logged to ANALYTICS", async () => {
  _resetStatsCache();
  const env = { ...BASE_ENV, ...recorder() };
  const st = await worker.fetch(new Request("https://mcp.test/v1/usage"), env, {});
  assert.equal(st.status, 200);
  assert.equal((await st.json()).status, "collecting");
  const h = await worker.fetch(new Request("https://mcp.test/v1/e", { method: "POST", headers: { ...ORIGIN, "content-type": "text/plain", "cf-connecting-ip": "10.3.3.3" }, body: JSON.stringify({ t: "pageview", p: "/agents/" }) }), env, {});
  assert.equal(h.status, 204);
  assert.equal(env.points.length, 1);
  assert.equal(env.points[0].indexes[0], "hit:pageview");
  // workers.dev host: same origin check, same result
  const w = await worker.fetch(new Request("https://indexagentica-mcp.indexagentica.workers.dev/v1/e", { method: "POST", headers: { ...ORIGIN, "content-type": "text/plain", "cf-connecting-ip": "10.3.3.4" }, body: JSON.stringify({ t: "pageview", p: "/" }) }), env, {});
  assert.equal(w.status, 204);
  assert.equal((await worker.fetch(new Request("https://mcp.test/v1/e", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), env, {})).status, 403);
});

test("SQL: outside windows exclude flagged + retroactive internal rows; internal rows counted separately", async () => {
  sqlRows = byShape({});
  sqlCalls.length = 0;
  const env = { ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" };
  await queryTotals(env, "timestamp > NOW() - INTERVAL '1' DAY", uaClass);
  const qs = sqlCalls.map((c) => c.q);
  const main = qs.find((q) => q.includes("AS cls"));
  assert.ok(main.includes(`AND NOT ${API_INTERNAL}`));
  assert.match(API_INTERNAL, /blob18 = 'internal'/);
  assert.match(API_RETRO, /blob18 = '' AND \(blob5 = 'e2e' OR \(blob12 = 'US'/);
  assert.match(API_RETRO, /2026-10-02 20:15:00/);
  assert.ok(qs.find((q) => q.includes("indexagentica_hits") && q.includes("AS id")).includes(`AND NOT ${HITS_INTERNAL}`));
  assert.ok(qs.some((q) => q.includes("AS rule") && q.includes(`AND ${API_INTERNAL}`)));
  assert.equal(qs.length, 6, "6 queries per window when no legacy rows (subrequest budget)");
});

test("rollup days from an older version are recomputed", async () => {
  sqlRows = byShape({ api: [{ route: "mcp", method: "initialize", tool: "", cls: "agent", n: "1" }] });
  const kv = fakeKV();
  kv.m.set("day:2026-10-03", JSON.stringify({ v: 1, day: "2026-10-03", totals: { mcp: { requests: 99 } } }));
  const env = { ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", STATS_KV: kv, STATS_API_SINCE: "2026-10-03T05:00:00Z", STATS_BEACON_SINCE: "2026-10-03T05:00:00Z" };
  const r = await rollup(env, uaClass, { now: Date.parse("2026-10-04T12:00:00Z") });
  assert.deepEqual(r.stored, ["2026-10-03"]);
  assert.equal(JSON.parse(kv.m.get("day:2026-10-03")).v, 4);
  assert.equal(JSON.parse(kv.m.get("day:2026-10-03")).totals.mcp.requests, 1);
});

test("internal rule: header, UA, IP ranges; flag written to both datasets", async () => {
  const req = (h) => new Request("https://mcp.test/health", { headers: h });
  assert.equal(internalRule(req({ "x-indexagentica-internal": "1" }), {}), "header");
  assert.equal(internalRule(req({ "user-agent": "indexagentica-steward/1" }), {}), "ua");
  assert.equal(internalRule(req({ "cf-connecting-ip": "2a04:4e41:80:1::5" }), { INTERNAL_IPS: "2a04:4e41:80::/48, 10.0.0.0/8" }), "ip");
  assert.equal(internalRule(req({ "cf-connecting-ip": "10.2.3.4" }), { INTERNAL_IPS: "2a04:4e41:80::/48, 10.0.0.0/8" }), "ip");
  assert.equal(internalRule(req({ "cf-connecting-ip": "11.2.3.4", "user-agent": "curl/8" }), { INTERNAL_IPS: "10.0.0.0/8" }), "");
  assert.equal(internalRule(req({ "x-indexagentica-internal": "0" }), {}), "");
  const env = { ...BASE_ENV, ...recorder() };
  await worker.fetch(hit({ t: "pageview", p: "/" }, { ...ORIGIN, "cf-connecting-ip": "10.9.9.9", "x-indexagentica-internal": "1" }), env, {});
  assert.deepEqual(env.points[0].blobs.slice(HIT_BLOBS.indexOf("traffic")), ["internal", "header"]);
  const dp = dataPoint({ ...newLog(new Request("https://mcp.test/mcp"), "/mcp"), rule: "ua" }, 200, {});
  assert.deepEqual(dp.blobs.slice(BLOBS.indexOf("traffic")), ["internal", "ua"]);
  assert.deepEqual(dataPoint(newLog(new Request("https://mcp.test/mcp"), "/mcp"), 200, {}).blobs.slice(BLOBS.indexOf("traffic")), ["outside", ""]);
});

test("UA families and client-name sanitizing", () => {
  assert.equal(uaFamily("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", uaClass), "claudebot");
  assert.equal(uaFamily("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36", uaClass), "headless-chrome");
  assert.equal(uaFamily("node", uaClass), "node");
  assert.equal(uaFamily("", uaClass), "(none)");
  assert.equal(cleanName("  Cursor <script>VS Code\n "), "cursor scriptvs code");
  assert.equal(cleanName("x".repeat(80)).length, 40);
});

// ---- direct skill downloads (src/downloads.js) ----
import { matchSkillPath, probeOf, BOT_UA_RE } from "../src/downloads.js";

test("skill download paths: strict slug, zip or SKILL.md only", () => {
  assert.deepEqual(matchSkillPath("/skills/web-lookup.zip"), { id: "web-lookup", kind: "zip" });
  assert.deepEqual(matchSkillPath("/skills/web-lookup/SKILL.md"), { id: "web-lookup", kind: "skill_md" });
  for (const p of ["/skills/Web-Lookup.zip", "/skills/web--lookup.zip", "/skills/-x.zip", "/skills/a/b.zip", "/skills/x/skill.md", "/skills/x/scripts/a.sh", "/skills/%2e%2e.zip", "/skills/x.zip.exe", `/skills/${"a".repeat(65)}.zip`, "/skills/"]) {
    assert.equal(matchSkillPath(p), null, p);
  }
  assert.equal(probeOf("HEAD", "curl/8"), "head");
  assert.equal(probeOf("GET", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"), "bot");
  assert.equal(probeOf("GET", "UptimeRobot/2.0"), "bot");
  for (const ua of ["curl/8.5.0", "Claude-User/1.0", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)", "python-httpx/0.27", ""]) assert.equal(probeOf("GET", ua), "", ua);
  assert.ok(!BOT_UA_RE.test("claude-code/2.1"));
});

test("GET/HEAD /skills/<id>.zip|SKILL.md: record in HITS then 302 to the site; unknown -> 404, nothing stored", async () => {
  const rec = recorder();
  const env = { ...BASE_ENV, HITS: rec.HITS, ANALYTICS: rec.ANALYTICS };
  const pts = rec.points;
  const req = (p, init = {}) => worker.fetch(new Request(`https://mcp.test${p}`, init), env, {});
  const r1 = await req("/skills/web-lookup.zip", { headers: { "user-agent": "curl/8.5.0", "cf-connecting-ip": "10.2.2.2" } });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get("location"), `${SITE}/skills/web-lookup.zip`);
  assert.equal(r1.headers.get("cache-control"), "no-store");
  const r2 = await req("/skills/web-lookup/SKILL.md", { headers: { "user-agent": "Claude-User/1.0" } });
  assert.equal(r2.headers.get("location"), `${SITE}/skills/web-lookup/SKILL.md`);
  const r3 = await req("/skills/web-lookup.zip", { method: "HEAD", headers: { "user-agent": "curl/8" } });
  assert.equal(r3.status, 302);
  await req("/skills/web-lookup.zip", { headers: { "user-agent": "GPTBot/1.2" } });
  await req("/skills/web-lookup.zip", { headers: { "x-indexagentica-internal": "1", "user-agent": "indexagentica-builder/1" } });
  const p = pts;
  assert.equal(p.length, 5);
  assert.deepEqual(p[0], { indexes: ["hit:direct"], blobs: ["direct", "/skills/web-lookup.zip", "web-lookup", "", "zip", "agent", "", "outside", "", ""], doubles: [1] });
  assert.equal(p[1].blobs[4], "skill_md");
  assert.equal(p[2].blobs[9], "head");
  assert.equal(p[3].blobs[9], "bot");
  assert.deepEqual([p[4].blobs[7], p[4].blobs[8]], ["internal", "header"]);
  assert.equal(HIT_BLOBS.length + 1, p[0].blobs.length, "HITS columns + probe");
  // Not a skill (a guide id), unknown, malformed, wrong method: no redirect, nothing stored.
  for (const path of ["/skills/add-mcp.zip", "/skills/nope.zip", "/skills/nope/SKILL.md", "/skills/WEB-LOOKUP.zip", "/skills/web-lookup/scripts/x.sh", "/skills/..%2Fevil.zip"]) {
    const r = await req(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("location"), null, path);
  }
  assert.equal((await req("/skills/web-lookup.zip", { method: "POST" })).status, 405);
  assert.equal(pts.length, 5, "rejected requests store nothing");
});

// ---- /stats snapshot: stale-while-revalidate, single flight, stale on error, timeouts ----
const keysDeep = (o, p = "") => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).flatMap((k) => [p + k, ...keysDeep(o[k], p + k + ".")]) : []);
const statsEnv = (kv = fakeKV()) => ({ ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", STATS_KV: kv, STATS_API_SINCE: new Date(Date.now() - 7200e3).toISOString(), STATS_BEACON_SINCE: new Date(Date.now() - 3600e3).toISOString() });
const pending = () => { const ps = []; return { ps, ctx: { waitUntil: (p) => ps.push(p) }, settle: () => Promise.all(ps) }; };
const getStats = (env, ctx, host = "https://mcp.test") => worker.fetch(new Request(`${host}/stats`), env, ctx);

test("/stats: stale snapshot served immediately, one background refresh, same JSON shape", async () => {
  _resetStatsCache();
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "3" }], api: [{ route: "rest", method: "", tool: "search", cls: "human", n: "2" }] });
  const env = statsEnv();
  const w = pending();
  const first = await (await getStats(env, w.ctx)).json(); // no snapshot yet: computed in the request
  assert.equal(first.status, "ok");
  const snap = JSON.parse(env.STATS_KV.m.get(SNAPSHOT_KEY));
  assert.equal(snap.body.generated, first.generated, "snapshot stored");
  // Age the snapshot past CACHE_SECONDS; new data upstream.
  snap.at -= (CACHE_SECONDS + 5) * 1000;
  env.STATS_KV.m.set(SNAPSHOT_KEY, JSON.stringify(snap));
  _resetStatsCache();
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "8" }], api: [{ route: "rest", method: "", tool: "search", cls: "human", n: "2" }] });
  sqlCalls.length = 0;
  const w2 = pending();
  const [r1, r2, r3] = await Promise.all([getStats(env, w2.ctx), getStats(env, w2.ctx), getStats(env, w2.ctx)]);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.status, 200);
    assert.equal((await r.json()).windows.last_24h.site.page_views, 3, "stale copy, no waiting");
    assert.match(r.headers.get("cache-control"), /max-age=60\b/, "stale copy cached briefly");
  }
  await w2.settle();
  assert.equal(sqlCalls.length, 18, "exactly one refresh (3 windows x 6 queries) for 3 concurrent stale requests");
  const fresh = await (await getStats(env, {})).json();
  assert.equal(fresh.windows.last_24h.site.page_views, 8, "refreshed snapshot served next");
  assert.deepEqual(keysDeep(fresh), keysDeep(first), "identical key set");
  // stats_url follows the host that served it; the snapshot is shared.
  const wd = await (await getStats({ ...env }, {}, "https://indexagentica-mcp.x.workers.dev")).json();
  assert.equal(wd.stats_url, "https://indexagentica-mcp.x.workers.dev/stats");
});

test("/stats: upstream failure keeps serving the last snapshot (no 503); KV lock blocks a second refresher", async () => {
  _resetStatsCache();
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "5" }] });
  const env = statsEnv();
  await getStats(env, {});
  const snap = JSON.parse(env.STATS_KV.m.get(SNAPSHOT_KEY));
  snap.at -= (CACHE_SECONDS + 5) * 1000;
  env.STATS_KV.m.set(SNAPSHOT_KEY, JSON.stringify(snap));
  _resetStatsCache();
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes("analytics_engine") ? new Response("upstream down", { status: 503 }) : prev(url, init));
  try {
    const w = pending();
    const r = await getStats(env, w.ctx);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).windows.last_24h.site.page_views, 5);
    await w.settle(); // refresh fails quietly
    assert.equal(JSON.parse(env.STATS_KV.m.get(SNAPSHOT_KEY)).at, snap.at, "failed refresh does not overwrite the snapshot");
    _resetStatsCache();
    const r2 = await getStats(env, {});
    assert.equal(r2.status, 200, "still the stale copy, not 503");
  } finally { globalThis.fetch = prev; }
  // Another isolate holds the lock: no SQL from this one.
  _resetStatsCache();
  env.STATS_KV.m.set(SNAPSHOT_KEY.replace("snapshot", "lock"), String(Date.now()));
  sqlCalls.length = 0;
  const w = pending();
  assert.equal((await getStats(env, w.ctx)).status, 200);
  await w.settle();
  assert.equal(sqlCalls.length, 0, "locked: no duplicate recompute");
});

test("sql(): a hung SQL API call is aborted by the per-query timeout and the overall budget", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const env = { CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" };
  try {
    const timings = [];
    const t0 = Date.now();
    await assert.rejects(sql(env, "SELECT 1", { timeoutMs: 50, timings, label: "x" }), /timed out after 50 ms/);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(timings[0].label, "x");
    assert.match(timings[0].error, /timed out/);
    const ctl = new AbortController();
    const p = sql(env, "SELECT 1", { signal: ctl.signal, timeoutMs: 60000 });
    ctl.abort(new Error("budget"));
    await assert.rejects(p, /budget/);
  } finally { globalThis.fetch = prev; }
});

test("cron: */5 precomputes the snapshot, 00:30 runs the daily rollup", async () => {
  _resetStatsCache();
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "2" }] });
  const env = statsEnv();
  const w = pending();
  await worker.scheduled({ cron: "*/5 * * * *" }, env, w.ctx);
  await w.settle();
  const snap = JSON.parse(env.STATS_KV.m.get(SNAPSHOT_KEY));
  assert.equal(snap.body.status, "ok");
  assert.equal(snap.body.stats_url, "https://mcp.indexagentica.com/stats");
  const w2 = pending();
  await worker.scheduled({ cron: "30 0 * * *" }, { ...env, STATS_API_SINCE: "2026-10-02T20:21:47Z" }, w2.ctx);
  await w2.settle();
  assert.ok([...env.STATS_KV.m.keys()].some((k) => k.startsWith("day:")), "rollup stored days");
  // Served without any SQL.
  _resetStatsCache();
  sqlCalls.length = 0;
  assert.equal((await getStats(env, {})).status, 200);
  assert.equal(sqlCalls.length, 0);
});

// ---- own tooling by self-identification + the 2026-10-24 session ----
test("internal SQL: own tooling patterns and the Oct 24 session are excluded from outside windows, exact patterns only", async () => {
  assert.ok(API_INTERNAL.includes(API_SELF) && API_INTERNAL.includes(API_SESSIONS));
  assert.match(API_SELF, /blob7 LIKE '%IndexAgenticaLinkCheck%'/);
  assert.match(API_SELF, /blob7 LIKE 'indexagentica-build%'/);
  assert.match(API_SELF, /blob5 LIKE 'indexagentica-%'/);
  assert.ok(!/LIKE '%indexagentica%'/i.test(API_INTERNAL), "no broad host-name match (third-party bots carry it in their UA)");
  assert.match(API_SESSIONS, /2026-10-24 05:10:00.*2026-10-24 05:15:00/);
  assert.match(API_SESSIONS, /blob12 = 'SE' AND double3 = 13335 AND \(blob7 = 'curl\/8.14.1' OR blob5 = 'ia-example'\)/);
  sqlRows = byShape({});
  sqlCalls.length = 0;
  await queryTotals({ ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" }, "timestamp > NOW() - INTERVAL '1' DAY", uaClass);
  const main = sqlCalls.map((c) => c.q).find((q) => q.includes("AS cls"));
  assert.ok(main.includes(`AND NOT ${API_INTERNAL}`), "outside = NOT (flag OR retro OR self OR session)");
});

test("by_rule: rule 'client' counts as ua; shape unchanged", () => {
  const t = totalsFromRows({ internalApi: [{ route: "mcp", rule: "client", n: "2" }, { route: "mcp", rule: "ua", n: "1" }, { route: "rest", rule: "", n: "4" }] }, uaClass);
  assert.deepEqual(t.internal_excluded.by_rule, { header: 0, ua: 3, ip: 0, retroactive: 4 });
  assert.deepEqual(Object.keys(t.internal_excluded), Object.keys(emptyTotals().internal_excluded));
});

test("log time: MCP clientInfo name indexagentica-* is flagged internal (rule client) even without header/UA", () => {
  const log = newLog(new Request("https://mcp.test/mcp", { headers: { "user-agent": "node" } }), "/mcp");
  log.clientName = "indexagentica-linkcheck";
  const dp = dataPoint(log, 200, {});
  assert.deepEqual(dp.blobs.slice(BLOBS.indexOf("traffic")), ["internal", "client"]);
  const other = newLog(new Request("https://mcp.test/mcp", { headers: { "user-agent": "node" } }), "/mcp");
  other.clientName = "my-indexagentica-fork";
  assert.deepEqual(dataPoint(other, 200, {}).blobs.slice(BLOBS.indexOf("traffic")), ["outside", ""], "prefix only");
  const hdr = { ...newLog(new Request("https://mcp.test/mcp"), "/mcp"), rule: "header", clientName: "indexagentica-e2e" };
  assert.equal(dataPoint(hdr, 200, {}).blobs[BLOBS.indexOf("internal_rule")], "header", "existing rule kept");
});

test("/stats after a ROLLUP_VERSION bump: previous snapshot served as stale while the new one is computed", async () => {
  _resetStatsCache();
  sqlRows = byShape({ hits: [{ event: "pageview", kind: "", n: "9" }] });
  const env = statsEnv();
  const prevKey = SNAPSHOT_KEY.replace(/v(\d+)$/, (_, v) => `v${Number(v) - 1}`);
  const old = { at: Date.now() - 60000, body: { status: "ok", generated: "2026-01-01T00:00:00.000Z", stats_url: "https://mcp.test/stats", windows: {} } };
  env.STATS_KV.m.set(prevKey, JSON.stringify(old));
  const w = pending();
  const r = await getStats(env, w.ctx);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).generated, "2026-01-01T00:00:00.000Z", "old body, immediately");
  assert.match(r.headers.get("cache-control"), /max-age=60\b/);
  await w.settle();
  const cur = JSON.parse(env.STATS_KV.m.get(SNAPSHOT_KEY));
  assert.equal(cur.body.windows.last_24h.site.page_views, 9, "new-version snapshot computed in the background");
  _resetStatsCache();
  assert.equal((await (await getStats(env, {})).json()).windows.last_24h.site.page_views, 9);
});
