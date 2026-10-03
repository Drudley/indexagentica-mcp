// Usage stats: UA classification, /hit validation, /stats (collecting + aggregated), KV rollup.
import test from "node:test";
import assert from "node:assert/strict";
import { uaClass } from "../src/ua.js";
import { validateHit, knownPaths, entryHosts, hitDataPoint, HIT_BLOBS } from "../src/hits.js";
import { totalsFromRows, addTotals, emptyTotals, rollup, allTime, _resetStatsCache } from "../src/stats.js";
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
  const t = totalsFromRows(
    [
      { route: "mcp", method: "tools/call", tool: "search", cls: "agent", n: "5" },
      { route: "mcp", method: "tools/call", tool: "<script>x", cls: "agent", n: "1" },
      { route: "mcp", method: "initialize", tool: "", cls: "human", n: "2" },
      { route: "rest", method: "", tool: "get_entry", cls: "agent", n: "3" },
      { route: "rest", method: "", tool: "", cls: "", n: "4" },
    ],
    [{ route: "rest", ua: "curl/8", n: "3" }, { route: "rest", ua: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", n: "1" }],
    [{ event: "pageview", kind: "", n: "7" }, { event: "click", kind: "", n: "2" }, { event: "download", kind: "zip", n: "1" }],
    uaClass,
  );
  assert.equal(t.mcp.requests, 8);
  assert.equal(t.mcp.tool_calls, 6);
  assert.deepEqual(t.mcp.tool_calls_by_tool, { search: 5, unknown_tool: 1 });
  assert.equal(t.api.requests, 7);
  assert.deepEqual(t.api.by_operation, { get_entry: 3, other: 4 });
  assert.deepEqual(t.agent_vs_human, { agent: 6 + 3 + 3, human: 2 + 1 });
  assert.deepEqual(t.site, { page_views: 7, outbound_clicks: 2, downloads: { total: 1, zip: 1, skill_md: 0 } });
  const sum = addTotals(t, t);
  assert.equal(sum.mcp.tool_calls_by_tool.search, 10);
  assert.equal(sum.site.downloads.zip, 2);
  assert.deepEqual(addTotals(emptyTotals(), emptyTotals()), emptyTotals());
});

function fakeKV() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
}

test("rollup stores settled UTC days once; all-time = stored days + live remainder", async () => {
  sqlRows = (q) => (q.includes("indexagentica_hits") ? [{ event: "pageview", kind: "", n: "10" }] : [{ route: "mcp", method: "tools/call", tool: "search", cls: "agent", n: "4" }]);
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
  sqlRows = (q) => (q.includes("indexagentica_hits") ? [{ event: "pageview", kind: "", n: "3" }] : [{ route: "rest", method: "", tool: "search", cls: "human", n: "2" }]);
  sqlCalls.length = 0;
  const env = { ...BASE_ENV, CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok", STATS_KV: fakeKV(), STATS_BEACON_SINCE: new Date(Date.now() - 3600e3).toISOString(), STATS_API_SINCE: new Date(Date.now() - 7200e3).toISOString() };
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
  assert.ok(b.since.site_beacon && b.since.mcp_api && b.definitions && b.caveats.length);
  assert.ok(!JSON.stringify(b).includes("tok"), "token never echoed");
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
