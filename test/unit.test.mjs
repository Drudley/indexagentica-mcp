// Pure unit tests (no network): node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { search, tokenize, normalizeTags } from "../src/search.js";
import { checkRateLimit } from "../src/ratelimit.js";

function fixture() {
  const entries = [
    { id: "playwright-mcp", name: "Playwright MCP", category: "mcp-servers", summary: "Browser automation MCP server.", tags: ["browser", "automation"] },
    { id: "browser-use", name: "Browser Use", category: "tools", summary: "Let agents control a web browser.", tags: ["browser", "python"] },
    { id: "x402", name: "x402", category: "finance-payments", summary: "HTTP 402 payments protocol.", tags: ["payments", "http"] },
  ];
  for (const e of entries) {
    e._s = { id: e.id, name: e.name.toLowerCase(), summary: e.summary.toLowerCase(), description: "", tags: e.tags, category: e.category };
  }
  return { entries };
}

test("tokenize and normalizeTags", () => {
  assert.deepEqual(tokenize("Browser-Automation, MCP!"), ["browser", "automation", "mcp"]);
  assert.deepEqual(normalizeTags("a, B ,,c"), ["a", "b", "c"]);
  assert.deepEqual(normalizeTags(["X"]), ["x"]);
});

test("search ranks name/tag matches and applies filters", () => {
  const d = fixture();
  const r = search(d, { query: "browser automation" });
  assert.equal(r.results[0].id, "playwright-mcp");
  assert.equal(r.total, 2);
  assert.deepEqual(search(d, { query: "browser", category: "tools" }).results.map((x) => x.id), ["browser-use"]);
  assert.deepEqual(search(d, { query: "", tags: ["browser", "python"] }).results.map((x) => x.id), ["browser-use"]);
  assert.equal(search(d, { query: "nothing-matches-this" }).total, 0);
  assert.equal(search(d, { query: "browser", limit: 1 }).results.length, 1);
  assert.equal(search(d, { query: "browser", limit: 999 }).limit, 50);
});

test("fallback token bucket limits per key", async () => {
  const env = { RATE_LIMIT_REQUESTS: "3", RATE_LIMIT_PERIOD_SECONDS: "60" };
  const req = (ip) => new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await checkRateLimit(req("10.0.0.1"), env)).success);
  assert.deepEqual(results, [true, true, true, false, false]);
  const blocked = await checkRateLimit(req("10.0.0.1"), env);
  assert.equal(blocked.mode, "isolate");
  assert.ok(blocked.retryAfter >= 1);
  assert.equal((await checkRateLimit(req("10.0.0.2"), env)).success, true, "other IPs unaffected");
});
