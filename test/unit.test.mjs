// Pure unit tests (no network): node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { search, tokenize, normalizeTags } from "../src/search.js";
import { checkRateLimit } from "../src/ratelimit.js";
import { prepare } from "../src/data.js";
import { runSearch, runGetContent, runGetEntry, toolDefinitions, ToolInputError, NotFoundError } from "../src/tools.js";

function fixture() {
  const entries = [
    { id: "playwright-mcp", name: "Playwright MCP", category: "mcp-servers", summary: "Browser automation MCP server.", tags: ["browser", "automation"] },
    { id: "browser-use", name: "Browser Use", category: "tools", summary: "Let agents control a web browser.", tags: ["browser", "python"] },
    { id: "x402", name: "x402", category: "finance-payments", summary: "HTTP 402 payments protocol.", tags: ["payments", "http"] },
  ];
  for (const e of entries) {
    e._s = { id: e.id, name: e.name.toLowerCase(), summary: e.summary.toLowerCase(), description: "", tags: e.tags, category: e.category };
  }
  return { entries, longform: [] };
}

// Index + long-form fixture shaped like the published /api/index.json and /api/longform.json.
const SITE = "https://site.test";
const INDEX = {
  generated: "2026-10-02T00:00:00Z",
  categories: [{ slug: "mcp-servers", name: "MCP Servers" }, { slug: "apis", name: "APIs" }],
  entries: [
    { id: "exa-api", name: "Exa API", category: "apis", summary: "Search API for agents.", tags: ["web-search"] },
    { id: "tavily-api", name: "Tavily API", category: "apis", summary: "Web search for agents.", tags: ["web-search"] },
    { id: "playwright-mcp", name: "Playwright MCP", category: "mcp-servers", summary: "Browser automation MCP server.", tags: ["browser"] },
  ],
};
const lf = (type, route, id, title, summary, tags, entries) => ({
  type, id, title, summary, tags, entries, author: "Test", last_verified: "2026-10-02",
  links: { html: `${SITE}/${route}/${id}/`, markdown: `${SITE}/${route}/${id}.md`, json: `${SITE}/api/longform/${route}/${id}.json` },
});
const LONGFORM = {
  generated: "2026-10-02T00:00:00Z",
  items: [
    lf("guide", "guides", "add-mcp-servers", "Add MCP servers to Claude Code", "Connect remote and local MCP servers.", ["mcp"], ["playwright-mcp"]),
    lf("comparison", "compare", "web-search-apis", "Web search APIs for agents", "Tavily and Exa compared for web search.", ["web-search"], ["exa-api", "tavily-api"]),
    lf("stack", "stacks", "coding-agent-starter", "Coding agent starter stack", "Harness plus browser tools.", ["coding"], ["playwright-mcp"]),
    lf("skill", "skills", "web-lookup", "Web lookup", "Search the web with Exa.", ["web-search"], ["exa-api"]),
  ],
};
const ITEMS = {
  [`${SITE}/api/longform/compare/web-search-apis.json`]: { ...LONGFORM.items[1], front_matter: { id: "web-search-apis" }, markdown: "Body with [Exa](https://site.test/entries/exa-api/).", raw: "---\nid: web-search-apis\n---\nBody", html: "<p>Body</p>", comparison: { criteria: ["Index"], table: [{ entry: "exa-api", values: { Index: "own" } }] } },
  [`${SITE}/api/longform/skills/web-lookup.json`]: { ...LONGFORM.items[3], front_matter: { name: "web-lookup" }, markdown: "# Web lookup", raw: "---\nname: web-lookup\n---\n# Web lookup", html: "<h3>Web lookup</h3>" },
};
const fetched = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  const body = u === `${SITE}/api/index.json` ? INDEX : u === `${SITE}/api/longform.json` ? LONGFORM : ITEMS[u];
  return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
};
const ENV = { DATA_BASE_URL: SITE };

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

test("prepare indexes long-form items for search", () => {
  const d = prepare(INDEX, LONGFORM);
  assert.equal(d.longform.length, 4);
  assert.ok(d.longformByKey.get("comparison:web-search-apis"));
  assert.equal(prepare(INDEX, null).longform.length, 0, "missing longform.json is tolerated");
});

test("search covers long-form with a type filter", () => {
  const d = prepare(INDEX, LONGFORM);
  const all = search(d, { query: "web search" });
  assert.equal(all.type, "all");
  const types = new Set(all.results.map((r) => r.type));
  assert.ok(types.has("entry") && types.has("comparison") && types.has("skill"), [...types].join(","));
  const cmp = search(d, { query: "web search", type: "comparison" });
  assert.deepEqual(cmp.results.map((r) => [r.type, r.id]), [["comparison", "web-search-apis"]]);
  assert.equal(cmp.results[0].url, `${SITE}/compare/web-search-apis/`);
  assert.deepEqual(cmp.results[0].entries, ["exa-api", "tavily-api"]);
  assert.ok(search(d, { query: "web search", type: "entry" }).results.every((r) => r.type === "entry" && r.category));
  assert.deepEqual(search(d, { query: "", type: "guide" }).results.map((r) => r.id), ["add-mcp-servers"]);
  // a referenced entry id finds the long-form items that discuss it
  assert.ok(search(d, { query: "playwright", type: "stack" }).results.some((r) => r.id === "coding-agent-starter"));
  // category implies entries
  const c = search(d, { query: "search", category: "apis" });
  assert.equal(c.type, "entry");
  assert.ok(c.results.every((r) => r.type === "entry"));
});

test("runSearch validates type and category combinations", async () => {
  await assert.rejects(runSearch(ENV, null, { query: "x", type: "video" }), ToolInputError);
  await assert.rejects(runSearch(ENV, null, { query: "x", type: "guide", category: "apis" }), ToolInputError);
  await assert.rejects(runSearch(ENV, null, {}), ToolInputError);
  const r = await runSearch(ENV, null, { type: "skill" });
  assert.deepEqual(r.results.map((x) => x.id), ["web-lookup"]);
  assert.ok(fetched.includes(`${SITE}/api/longform.json`), "longform.json fetched alongside index.json");
});

test("get_content returns metadata + markdown; skills include SKILL.md", async () => {
  const { content } = await runGetContent(ENV, null, { type: "comparison", id: "web-search-apis" });
  assert.equal(content.title, "Web search APIs for agents");
  assert.match(content.markdown, /Exa/);
  assert.ok(content.comparison.table.length === 1);
  assert.equal(content.html, undefined, "html omitted by default");
  assert.equal(content.raw, undefined);
  const withHtml = await runGetContent(ENV, null, { type: "comparison", id: "web-search-apis", include_html: true });
  assert.equal(withHtml.content.html, "<p>Body</p>");
  const skill = await runGetContent(ENV, null, { type: "skill", id: "web-lookup" });
  assert.match(skill.content.skill_md, /^---\nname: web-lookup/);
});

test("get_content errors: bad type, wrong type, unknown id", async () => {
  await assert.rejects(runGetContent(ENV, null, { type: "entry", id: "exa-api" }), (e) => e instanceof ToolInputError && /get_entry/.test(e.message));
  await assert.rejects(runGetContent(ENV, null, { type: "guide", id: "web-search-apis" }), (e) => e instanceof NotFoundError && e.extra.type === "comparison");
  await assert.rejects(runGetContent(ENV, null, { type: "guide", id: "nope-nope" }), NotFoundError);
  await assert.rejects(runGetContent(ENV, null, { type: "guide" }), ToolInputError);
  // listed in the index but its JSON is gone -> not found, not an upstream error
  await assert.rejects(runGetContent(ENV, null, { type: "stack", id: "coding-agent-starter" }), NotFoundError);
});

test("get_entry still works and tool list includes get_content", async () => {
  assert.equal((await runGetEntry(ENV, null, { id: "exa-api" })).entry.id, "exa-api");
  const defs = toolDefinitions(["apis"]);
  assert.deepEqual(defs.map((t) => t.name), ["search", "get_entry", "get_content", "list_categories"]);
  assert.ok(defs[0].inputSchema.properties.type.enum.includes("skill"));
});
