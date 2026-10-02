// Index Agentica MCP + REST Worker.
import { handleMcpPost, SERVER_INFO, SUPPORTED_VERSIONS, INSTRUCTIONS } from "./mcp.js";
import { runSearch, runGetEntry, runGetContent, runListCategories, toolDefinitions, ToolInputError, NotFoundError } from "./tools.js";
import { summarizeLongform } from "./search.js";
import { checkRateLimit } from "./ratelimit.js";
import { getData } from "./data.js";
import { openapi } from "./openapi.js";
import { newLog, noteArgs, writeLog } from "./analytics.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, retry-after, x-ratelimit-limit, x-ratelimit-period",
  "access-control-max-age": "86400",
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers },
  });
}
function empty(status, headers = {}) {
  return new Response(null, { status, headers: { ...CORS, ...headers } });
}
function errorJson(status, code, message, extra = {}, headers = {}) {
  return json(status, { error: { status, code, message, ...extra } }, headers);
}

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return "invalid"; }
}

function baseUrl(request, env) {
  return env.PUBLIC_BASE_URL || new URL(request.url).origin;
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS || "*").trim();
  if (!origin || allowed === "*") return true;
  return allowed.split(",").map((s) => s.trim()).includes(origin);
}

/**
 * Static MCP server card (Smithery's scan fallback, SEP-1649 shape), generated
 * from the same tool definitions as tools/list so it can't drift.
 */
export function serverCard(request, env) {
  return {
    serverInfo: { ...SERVER_INFO },
    description: "Read-only search over the Index Agentica directory of agent tools, MCP servers, APIs, protocols and skills, plus guides, comparisons, stacks and downloadable skills.",
    instructions: INSTRUCTIONS,
    transport: { type: "streamable-http", url: `${baseUrl(request, env)}/mcp` },
    protocolVersions: SUPPORTED_VERSIONS,
    authentication: { required: false },
    capabilities: { tools: { listChanged: false } },
    tools: toolDefinitions(),
    resources: [],
    prompts: [],
  };
}

function landing(request, env) {
  const base = baseUrl(request, env);
  const site = env.DATA_BASE_URL || "https://indexagentica.com";
  return {
    name: "Index Agentica MCP & search API",
    description:
      "Read-only remote MCP server and REST search API for Index Agentica, an agent-first directory of skills, harnesses, MCP servers, tools, protocols and APIs, plus guides, comparisons, stacks and downloadable skills. No auth. CORS open.",
    version: SERVER_INFO.version,
    mcp: {
      endpoint: `${base}/mcp`,
      transport: "streamable-http",
      protocol_versions: SUPPORTED_VERSIONS,
      tools: toolDefinitions().map((t) => t.name),
      notes: "Stateless: POST JSON-RPC to /mcp. Works with the 2026-07-28 per-request _meta model and with the legacy initialize handshake (no session id is issued). GET /mcp returns 405.",
    },
    rest: {
      search: `${base}/search?q={query}&type={entry|guide|comparison|stack|skill|all}&category={slug}&tags={a,b}&limit={1-50}`,
      entry: `${base}/entries/{id}`,
      content: `${base}/content/{type}/{id}`,
      content_list: `${base}/content?type={guide|comparison|stack|skill}`,
      categories: `${base}/categories`,
      openapi: `${base}/openapi.json`,
      server_card: `${base}/.well-known/mcp/server-card.json`,
    },
    rate_limit: {
      requests: Number(env.RATE_LIMIT_REQUESTS) || 120,
      period_seconds: Number(env.RATE_LIMIT_PERIOD_SECONDS) || 60,
      scope: "per client IP, per Cloudflare location; HTTP 429 with Retry-After when exceeded",
    },
    links: {
      site,
      llms_txt: `${site}/llms.txt`,
      agents: `${site}/agents/`,
      api_index: `${site}/api/index.json`,
      api_longform: `${site}/api/longform.json`,
      schema: `${site}/schema/entry.schema.json`,
      repository: "https://github.com/Drudley/indexagentica",
      contribute: `${site}/agents/#contribute`,
    },
    license: { content: "CC-BY-4.0", code: "MIT" },
  };
}

async function rest(fn, ok = (r) => json(200, r, { "cache-control": "public, max-age=300" })) {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ToolInputError) return errorJson(400, "bad_request", err.message);
    if (err instanceof NotFoundError) return errorJson(404, "not_found", err.message, err.extra || {});
    return errorJson(502, "upstream_error", `Could not load directory data: ${err && err.message ? err.message : err}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // One Analytics Engine data point per request, except preflights and unmetered housekeeping.
    const skip = request.method.toUpperCase() === "OPTIONS" || ["/health", "/favicon.ico", "/robots.txt"].includes(path);
    const log = skip ? null : newLog(request, path);
    const res = await handle(request, env, ctx, url, path, log);
    if (log) {
      if (res.status >= 400 && !log.detail) log.detail = String(res.status);
      writeLog(env, request, log, res.status);
    }
    return res;
  },
};

async function handle(request, env, ctx, url, path, log) {
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return empty(204);

    if (!originAllowed(request, env)) {
      return json(403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Forbidden origin" } });
    }

    // Cheap, unmetered endpoints.
    if (path === "/health" && method === "GET") return json(200, { ok: true, version: SERVER_INFO.version });
    if (path === "/favicon.ico" || path === "/robots.txt") {
      return path === "/robots.txt"
        ? new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain", ...CORS } })
        : empty(404);
    }

    const rl = await checkRateLimit(request, env);
    const rlHeaders = { "x-ratelimit-limit": String(rl.limit), "x-ratelimit-period": String(rl.period) };
    if (!rl.success) {
      const h = { ...rlHeaders, "retry-after": String(rl.retryAfter) };
      if (path === "/mcp") {
        return json(429, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Rate limit exceeded (${rl.limit} requests per ${rl.period}s). Retry after ${rl.retryAfter}s.` } }, h);
      }
      return errorJson(429, "rate_limited", `Rate limit exceeded (${rl.limit} requests per ${rl.period}s per client).`, { retry_after: rl.retryAfter }, h);
    }

    const withRl = async (p) => {
      const res = await p;
      for (const [k, v] of Object.entries(rlHeaders)) res.headers.set(k, v);
      return res;
    };

    if (path === "/mcp") {
      if (method === "POST") return withRl(handleMcpPost(request, env, ctx, json, empty, log));
      return errorJson(405, "method_not_allowed", "The MCP endpoint accepts POST only (stateless Streamable HTTP; no GET/SSE stream, no sessions).", {}, { allow: "POST, OPTIONS" });
    }

    if (method !== "GET" && method !== "HEAD") {
      return errorJson(405, "method_not_allowed", `${method} not allowed on ${path}`, {}, { allow: "GET, HEAD, OPTIONS" });
    }

    if (path === "/") return withRl(Promise.resolve(json(200, landing(request, env), { "cache-control": "public, max-age=300" })));
    if (path === "/.well-known/mcp/server-card.json") return withRl(Promise.resolve(json(200, serverCard(request, env), { "cache-control": "public, max-age=3600" })));
    if (path === "/openapi.json") return withRl(Promise.resolve(json(200, openapi(baseUrl(request, env)), { "cache-control": "public, max-age=3600" })));

    if (path === "/search") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      const category = url.searchParams.get("category") || undefined;
      const tagsParam = url.searchParams.getAll("tags").concat(url.searchParams.getAll("tag")).join(",");
      const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const limitParam = url.searchParams.get("limit");
      const type = url.searchParams.get("type") || undefined;
      noteArgs(log, "search", { query: q, type, category });
      return withRl(rest(async () => {
        const r = await runSearch(env, ctx, { query: q, type, category, tags, limit: limitParam == null || limitParam === "" ? undefined : Number(limitParam) });
        if (log) log.resultCount = r.total;
        return r;
      }));
    }

    const m = /^\/entries\/([^/]+?)(?:\.json)?$/.exec(path);
    if (m) {
      noteArgs(log, "get_entry", { id: safeDecode(m[1]) });
      return withRl(rest(async () => (await runGetEntry(env, ctx, { id: decodeURIComponent(m[1]) })).entry));
    }

    const c = /^\/content\/([^/]+)\/([^/]+?)(?:\.json)?$/.exec(path);
    if (c) {
      const includeHtml = ["1", "true"].includes(url.searchParams.get("include_html") || "");
      noteArgs(log, "get_content", { type: safeDecode(c[1]), id: safeDecode(c[2]) });
      return withRl(rest(async () => (await runGetContent(env, ctx, { type: decodeURIComponent(c[1]), id: decodeURIComponent(c[2]), include_html: includeHtml })).content));
    }

    if (path === "/content") {
      return withRl(rest(async () => {
        const type = url.searchParams.get("type");
        noteArgs(log, "list_content", { type });
        if (type && !["guide", "comparison", "stack", "skill"].includes(type)) throw new ToolInputError("type must be one of: guide, comparison, stack, skill");
        const d = await getData(env, ctx);
        const items = d.longform.filter((x) => !type || x.type === type).map((x) => summarizeLongform(x));
        return { ...(type ? { type } : {}), total: items.length, generated: d.longformGenerated, items };
      }));
    }

    if (path === "/categories") {
      noteArgs(log, "list_categories", null);
      return withRl(rest(() => runListCategories(env, ctx)));
    }

    if (path === "/entries") {
      return withRl(rest(async () => {
        const d = await getData(env, ctx);
        return { total: d.entries.length, ids: d.entries.map((e) => e.id) };
      }));
    }

    return errorJson(404, "not_found", `No route for ${path}. See / for the list of endpoints.`);
}
