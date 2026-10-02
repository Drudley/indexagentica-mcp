// End-to-end tests against a running Worker (wrangler dev or deployed).
//   BASE=http://127.0.0.1:8787 [RL_BASE=http://127.0.0.1:8788] node test/e2e.mjs
const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const RL_BASE = process.env.RL_BASE ? process.env.RL_BASE.replace(/\/$/, "") : null;
const MODERN = "2026-07-28";

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

async function get(path, base = BASE) {
  const res = await fetch(base + path);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { res, body, text };
}

const ACCEPT = "application/json, text/event-stream";
async function rpcLegacy(method, params, id = 1, version = "2025-06-18") {
  const headers = { "content-type": "application/json", accept: ACCEPT };
  if (version) headers["mcp-protocol-version"] = version;
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (id !== null) msg.id = id;
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}
async function rpcModern(method, params = {}, { id = 1, headers: extra = {} } = {}) {
  const headers = { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": MODERN, "mcp-method": method };
  if (method === "tools/call") headers["mcp-name"] = params.name;
  Object.assign(headers, extra);
  const body = {
    jsonrpc: "2.0", id, method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
  };
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return { res, body: JSON.parse(await res.text()) };
}

console.log(`E2E against ${BASE}`);

console.log("REST");
await check("GET / landing", async () => {
  const { res, body } = await get("/");
  assert(res.status === 200, `status ${res.status}`);
  assert(body.mcp.endpoint.endsWith("/mcp"), "mcp endpoint link");
  assert(body.links.llms_txt.endsWith("/llms.txt"), "llms.txt link");
  assert(res.headers.get("access-control-allow-origin") === "*", "CORS");
});
await check("GET /search?q=browser automation", async () => {
  const { res, body } = await get("/search?q=browser%20automation&limit=5");
  assert(res.status === 200, `status ${res.status}`);
  assert(body.results.length > 0 && body.results.length <= 5, "results within limit");
  assert(body.results.every((r) => r.id && r.name && r.url), "result shape");
  assert(body.results[0].score >= body.results[body.results.length - 1].score, "sorted by score");
});
await check("GET /search category + tags filter", async () => {
  const { body: cats } = await get("/categories");
  const slug = cats.categories.find((c) => c.count > 0).slug;
  const { res, body } = await get(`/search?category=${slug}&limit=50`);
  assert(res.status === 200, `status ${res.status}`);
  assert(body.total === cats.categories.find((c) => c.slug === slug).count, "category listing count matches");
  assert(body.results.every((r) => r.category === slug), "category filter");
  const tag = body.results.find((r) => r.tags.length)?.tags[0];
  if (tag) {
    const t = await get(`/search?tags=${tag}&limit=50`);
    assert(t.body.results.every((r) => r.tags.includes(tag)), "tags filter");
  }
});
await check("GET /search bad input -> 400 JSON", async () => {
  const a = await get("/search?category=does-not-exist&q=x");
  assert(a.res.status === 400 && a.body.error.code === "bad_request", "unknown category");
  const b = await get("/search?q=x&limit=0");
  assert(b.res.status === 400, "limit 0");
  const c = await get("/search");
  assert(c.res.status === 400, "empty search");
});
await check("GET /entries/<id>", async () => {
  const { res, body } = await get("/entries/model-context-protocol");
  assert(res.status === 200 && body.id === "model-context-protocol" && body.links, "entry");
  assert(!("_s" in body), "no internal fields leak");
  const j = await get("/entries/model-context-protocol.json");
  assert(j.res.status === 200, ".json suffix works");
});
await check("GET /entries/<unknown> -> 404 with suggestions", async () => {
  const { res, body } = await get("/entries/model-context");
  assert(res.status === 404 && body.error.suggestions.includes("model-context-protocol"), "suggestions");
});
await check("GET /categories", async () => {
  const { res, body } = await get("/categories");
  assert(res.status === 200 && body.categories.length >= 1, "categories");
  assert(body.categories.reduce((n, c) => n + c.count, 0) === body.total, "counts add up");
});
await check("unknown route -> 404 JSON; OPTIONS preflight", async () => {
  const { res, body } = await get("/nope");
  assert(res.status === 404 && body.error.code === "not_found", "404");
  const p = await fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST" } });
  assert(p.status === 204 && p.headers.get("access-control-allow-headers").includes("mcp-protocol-version"), "preflight");
});
await check("GET /openapi.json", async () => {
  const { res, body } = await get("/openapi.json");
  assert(res.status === 200 && body.openapi === "3.1.0" && body.paths["/search"], "openapi");
});

console.log("MCP legacy era (initialize handshake, stateless)");
await check("initialize negotiates version, no session id", async () => {
  const { res, body } = await rpcLegacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 1, null);
  assert(res.status === 200, `status ${res.status}`);
  assert(body.result.protocolVersion === "2025-06-18", "echo supported version");
  assert(body.result.capabilities.tools, "tools capability");
  assert(!res.headers.get("mcp-session-id"), "no session id");
  const old = await rpcLegacy("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 2, null);
  assert(old.body.result.protocolVersion === "2025-11-25", "falls back to latest legacy");
});
await check("notifications/initialized -> 202", async () => {
  const { res } = await rpcLegacy("notifications/initialized", undefined, null);
  assert(res.status === 202, `status ${res.status}`);
});
await check("ping", async () => {
  const { body } = await rpcLegacy("ping", undefined, 3);
  assert(body.result && Object.keys(body.result).length === 0, "empty result");
});
await check("tools/list", async () => {
  const { body } = await rpcLegacy("tools/list", undefined, 4);
  const names = body.result.tools.map((t) => t.name);
  assert(["search", "get_entry", "list_categories"].every((n) => names.includes(n)), names.join(","));
  assert(body.result.tools.every((t) => t.inputSchema.type === "object" && t.outputSchema && t.annotations.readOnlyHint), "schemas");
});
await check("tools/call search", async () => {
  const { body } = await rpcLegacy("tools/call", { name: "search", arguments: { query: "payments", limit: 3 } }, 5);
  const r = body.result;
  assert(r.isError === false && r.structuredContent.results.length > 0, "results");
  assert(JSON.parse(r.content[0].text).total === r.structuredContent.total, "text mirrors structuredContent");
});
await check("tools/call get_entry (+ unknown id -> isError)", async () => {
  const ok = await rpcLegacy("tools/call", { name: "get_entry", arguments: { id: "model-context-protocol" } }, 6);
  assert(ok.body.result.structuredContent.entry.id === "model-context-protocol", "entry");
  const bad = await rpcLegacy("tools/call", { name: "get_entry", arguments: { id: "nope-nope" } }, 7);
  assert(bad.body.result.isError === true, "isError");
});
await check("tools/call list_categories", async () => {
  const { body } = await rpcLegacy("tools/call", { name: "list_categories", arguments: {} }, 8);
  assert(body.result.structuredContent.categories.length > 0, "categories");
});
await check("tools/call invalid args -> isError, unknown tool -> -32602", async () => {
  const a = await rpcLegacy("tools/call", { name: "search", arguments: { query: 42 } }, 9);
  assert(a.body.result.isError === true, "isError for bad arg");
  const b = await rpcLegacy("tools/call", { name: "nope", arguments: {} }, 10);
  assert(b.body.error.code === -32602, "unknown tool");
});
await check("unknown method -> -32601; parse error -> 400; GET /mcp -> 405", async () => {
  const a = await rpcLegacy("resources/list", undefined, 11);
  assert(a.body.error.code === -32601, "method not found");
  const p = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert(p.status === 400 && (await p.json()).error.code === -32700, "parse error");
  const g = await fetch(`${BASE}/mcp`, { headers: { accept: "text/event-stream" } });
  assert(g.status === 405, `GET status ${g.status}`);
});
await check("2025-03-26 batch", async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: ACCEPT },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]),
  });
  const body = await res.json();
  assert(Array.isArray(body) && body.length === 2 && body[1].result.tools, "batch responses");
});

console.log(`MCP modern era (${MODERN}, per-request _meta, no handshake)`);
await check("server/discover", async () => {
  const { res, body } = await rpcModern("server/discover");
  assert(res.status === 200, `status ${res.status}`);
  assert(body.result.resultType === "complete" && body.result.supportedVersions.includes(MODERN), "versions");
  assert(body.result._meta["io.modelcontextprotocol/serverInfo"].name === "indexagentica-mcp", "serverInfo in _meta");
  assert(body.result.ttlMs >= 0 && body.result.cacheScope === "public", "caching hints");
  assert(res.headers.get("mcp-protocol-version") === MODERN, "version header echoed");
});
await check("tools/list has caching hints", async () => {
  const { body } = await rpcModern("tools/list");
  assert(body.result.tools.length === 3 && body.result.ttlMs > 0 && body.result.cacheScope === "public", "tools + ttl");
});
await check("tools/call search / get_entry / list_categories", async () => {
  const s = await rpcModern("tools/call", { name: "search", arguments: { query: "mcp", category: "mcp-servers", limit: 5 } });
  assert(s.body.result.resultType === "complete" && s.body.result.structuredContent.results.every((r) => r.category === "mcp-servers"), "search");
  const g = await rpcModern("tools/call", { name: "get_entry", arguments: { id: "x402" } });
  assert(g.body.result.structuredContent.entry.id === "x402", "get_entry");
  const l = await rpcModern("tools/call", { name: "list_categories", arguments: {} });
  assert(l.body.result.structuredContent.total > 0, "list_categories");
});
await check("header validation (-32020) and version errors (-32022)", async () => {
  const a = await rpcModern("tools/call", { name: "search", arguments: { query: "x" } }, { headers: { "mcp-method": "tools/list" } });
  assert(a.res.status === 400 && a.body.error.code === -32020, "method mismatch");
  const b = await rpcModern("tools/call", { name: "search", arguments: { query: "x" } }, { headers: { "mcp-name": "get_entry" } });
  assert(b.res.status === 400 && b.body.error.code === -32020, "name mismatch");
  const enc = "=?base64?" + Buffer.from("search").toString("base64") + "?=";
  const c = await rpcModern("tools/call", { name: "search", arguments: { query: "x" } }, { headers: { "mcp-name": enc } });
  assert(c.res.status === 200, "base64 sentinel decoded");
  const d = await rpcModern("tools/list", {}, { headers: { "mcp-protocol-version": null } });
  assert(d.res.status === 400 && d.body.error.code === -32020, "missing version header");
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }),
  });
  const e = await res.json();
  assert(res.status === 400 && e.error.code === -32022 && e.error.data.supported.includes(MODERN), "unsupported version");
});
await check("modern unknown method / initialize -> HTTP 404 + -32601", async () => {
  const a = await rpcModern("initialize");
  assert(a.res.status === 404 && a.body.error.code === -32601, "initialize not in modern era");
});

if (RL_BASE) {
  console.log(`Rate limiting against ${RL_BASE}`);
  await check("burst beyond limit returns 429 with Retry-After (REST and MCP)", async () => {
    const landing = (await get("/", RL_BASE)).body;
    const limit = landing.rate_limit.requests;
    const statuses = [];
    let last429 = null;
    for (let i = 0; i < limit + 5; i++) {
      const r = await fetch(`${RL_BASE}/search?q=mcp`);
      statuses.push(r.status);
      if (r.status === 429) last429 = r;
      else await r.arrayBuffer();
    }
    assert(statuses.includes(429), `no 429 in ${statuses.join(",")}`);
    assert(last429.headers.get("retry-after"), "Retry-After header");
    const body = await last429.json();
    assert(body.error.code === "rate_limited", "JSON error body");
    const m = await fetch(`${RL_BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert(m.status === 429, `mcp status ${m.status}`);
    const mb = await m.json();
    assert(mb.jsonrpc === "2.0" && mb.error.code === -32000, "JSON-RPC 429 body");
    const h = await fetch(`${RL_BASE}/health`);
    assert(h.status === 200, "/health is unmetered");
    console.log(`       statuses: ${statuses.join(",")}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
