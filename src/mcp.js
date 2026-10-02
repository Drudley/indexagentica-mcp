// Stateless, dual-era MCP over Streamable HTTP (JSON responses only).
//
// * Modern era (2026-07-28): no handshake; each request carries
//   _meta["io.modelcontextprotocol/protocolVersion"] plus the
//   MCP-Protocol-Version / Mcp-Method / Mcp-Name headers.
// * Legacy era (2025-03-26 .. 2025-11-25): initialize handshake, but we never
//   mint an Mcp-Session-Id, so every request is still independent.
//
// GET/DELETE on the endpoint -> 405 (allowed by every revision).

import { toolDefinitions, TOOL_IMPLS, ToolInputError, NotFoundError } from "./tools.js";
import { noteClient, noteArgs } from "./analytics.js";
import { getData } from "./data.js";

export const SERVER_INFO = {
  name: "indexagentica-mcp",
  title: "Index Agentica",
  version: "0.1.0",
  websiteUrl: "https://indexagentica.com",
};
export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const LIST_TTL_MS = 10 * 60 * 1000;

export const INSTRUCTIONS =
  "Index Agentica (https://indexagentica.com) is an agent-first directory of skills, agent harnesses, MCP servers, tools, protocols, APIs, information sources, finance/payment rails and other directories, plus long-form guides, comparisons, stacks and downloadable Agent Skills. " +
  "Use `search` to find resources by keywords, type (entry, guide, comparison, stack, skill), category and tags; `get_entry` for the full record of one directory entry; `get_content` (type + id) for a guide, comparison, stack or skill with its markdown; `list_categories` for the category slugs and counts. " +
  "Data is read-only, refreshed from the published site every ~10 minutes, and licensed CC BY 4.0. To add or correct an entry, see https://indexagentica.com/agents/#contribute.";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
};

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const bin = atob(m[1]);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Build the CallToolResult for a tool, never throwing for tool-level errors. */
async function callTool(env, ctx, name, args) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { rpcError: { code: ERR.INVALID_PARAMS, message: `Unknown tool: ${name}` } };
  try {
    const structured = await impl(env, ctx, args || {});
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: false,
      },
    };
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof NotFoundError) {
      const payload = { error: err.message, ...(err.extra || {}) };
      return { result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true } };
    }
    return {
      result: {
        content: [{ type: "text", text: `Upstream data error: ${err && err.message ? err.message : String(err)}. Try again shortly.` }],
        isError: true,
      },
    };
  }
}

async function categorySlugs(env, ctx) {
  try {
    const data = await getData(env, ctx);
    return data.categories.map((c) => c.slug);
  } catch {
    return [];
  }
}

/**
 * Dispatch one JSON-RPC request. Returns { status, body } where body is the
 * JSON-RPC response object, or null for notifications (-> 202).
 */
async function dispatch(env, ctx, msg, era, version, log = null) {
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const modern = era === "modern";
  const ok = (result) => {
    if (modern) {
      result = { resultType: "complete", ...result, _meta: { ...(result._meta || {}), "io.modelcontextprotocol/serverInfo": SERVER_INFO } };
    }
    return { status: 200, body: { jsonrpc: "2.0", id, result } };
  };
  const notFound = () => ({
    status: modern ? 404 : 200,
    body: rpcError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`),
  });

  switch (method) {
    case "initialize": {
      if (modern) return notFound();
      const requested = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return modern ? notFound() : ok({});
    case "server/discover":
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        ...(modern ? {} : { serverInfo: SERVER_INFO }),
        instructions: INSTRUCTIONS,
        ttlMs: LIST_TTL_MS,
        cacheScope: "public",
      });
    case "tools/list": {
      const tools = toolDefinitions(await categorySlugs(env, ctx));
      return ok(modern ? { tools, ttlMs: LIST_TTL_MS, cacheScope: "public" } : { tools });
    }
    case "tools/call": {
      if (typeof params.name !== "string") return { status: 200, body: rpcError(id, ERR.INVALID_PARAMS, "params.name (string) is required") };
      if (log) noteArgs(log, params.name, params.arguments);
      const r = await callTool(env, ctx, params.name, params.arguments);
      if (log && r.result) {
        if (r.result.isError) { log.toolError = true; log.detail = "tool_error"; }
        const sc = r.result.structuredContent;
        if (sc && Number.isFinite(sc.total)) log.resultCount = sc.total;
      }
      if (r.rpcError) return { status: 200, body: rpcError(id, r.rpcError.code, r.rpcError.message) };
      return ok(r.result);
    }
    default:
      return notFound();
  }
}

function isNotification(msg) {
  return msg && typeof msg === "object" && typeof msg.method === "string" && !("id" in msg);
}
function isResponse(msg) {
  return msg && typeof msg === "object" && !("method" in msg) && ("result" in msg || "error" in msg);
}
function validRequest(msg) {
  return (
    msg && typeof msg === "object" && !Array.isArray(msg) && msg.jsonrpc === "2.0" && typeof msg.method === "string" &&
    (typeof msg.id === "string" || typeof msg.id === "number")
  );
}

/**
 * Handle POST /mcp. `json(status, body, extraHeaders)` builds the response.
 */
export async function handleMcpPost(request, env, ctx, json0, empty, log = null) {
  // Wrap the response builder so JSON-RPC errors are recorded for usage logging.
  const json = (status, b, h) => {
    if (log && b && !Array.isArray(b) && b.error) { log.rpcError = true; log.detail = String(b.error.code); }
    return json0(status, b, h);
  };
  const raw = await request.text();
  if (raw.length > 64 * 1024) return json(413, rpcError(null, ERR.INVALID_REQUEST, "Request body too large (max 64 KiB)"));
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, ERR.PARSE, "Parse error: body must be a single JSON-RPC message"));
  }

  const hdrVersion = request.headers.get("mcp-protocol-version");
  if (log) {
    log.protocol = hdrVersion || "";
    if (Array.isArray(msg)) log.method = "batch";
    else if (msg && typeof msg.method === "string") log.method = msg.method;
    if (msg && !Array.isArray(msg)) noteClient(log, msg.params);
  }

  // Legacy (2025-03-26) JSON-RPC batch support.
  if (Array.isArray(msg)) {
    if (hdrVersion && hdrVersion !== "2025-03-26") {
      return json(400, rpcError(null, ERR.INVALID_REQUEST, "JSON-RPC batches are only supported for protocol version 2025-03-26"));
    }
    if (msg.length === 0) return json(400, rpcError(null, ERR.INVALID_REQUEST, "Empty batch"));
    const out = [];
    for (const m of msg) {
      if (isNotification(m) || isResponse(m)) continue;
      if (!validRequest(m)) {
        out.push(rpcError(m && m.id, ERR.INVALID_REQUEST, "Invalid JSON-RPC request"));
        continue;
      }
      out.push((await dispatch(env, ctx, m, "legacy", "2025-03-26")).body);
      if (log) log.era = "legacy";
    }
    return out.length ? json(200, out) : empty(202);
  }

  if (!msg || typeof msg !== "object") return json(400, rpcError(null, ERR.INVALID_REQUEST, "Invalid JSON-RPC message"));

  const metaVersion = msg.params && msg.params._meta ? msg.params._meta[META_VERSION] : undefined;

  // ---- era detection ----
  let era;
  let version;
  if (msg.method === "initialize" && metaVersion === undefined) {
    era = "legacy";
    version = msg.params && msg.params.protocolVersion;
  } else if (metaVersion !== undefined || (hdrVersion && !LEGACY_VERSIONS.includes(hdrVersion))) {
    // Modern request (or an unknown version): validate headers against body.
    if (!hdrVersion) {
      return json(400, rpcError(msg.id, ERR.HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header is required"));
    }
    if (metaVersion === undefined) {
      if (MODERN_VERSIONS.includes(hdrVersion)) {
        return json(400, rpcError(msg.id, ERR.HEADER_MISMATCH, `Header mismatch: _meta["${META_VERSION}"] is required for protocol version ${hdrVersion}`));
      }
      return json(400, rpcError(msg.id, ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: hdrVersion }));
    }
    if (hdrVersion !== metaVersion) {
      return json(400, rpcError(msg.id, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header '${hdrVersion}' does not match body value '${metaVersion}'`));
    }
    if (!MODERN_VERSIONS.includes(metaVersion)) {
      return json(400, rpcError(msg.id, ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: metaVersion }));
    }
    era = "modern";
    version = metaVersion;
  } else {
    era = "legacy";
    version = hdrVersion || "2025-03-26";
  }

  if (log) { log.era = era; log.protocol = version || log.protocol; }

  // ---- notifications & stray responses ----
  if (isNotification(msg)) return empty(202);
  if (isResponse(msg)) {
    return era === "legacy" ? empty(202) : json(400, rpcError(null, ERR.INVALID_REQUEST, "Clients must not send JSON-RPC responses"));
  }
  if (!validRequest(msg)) return json(400, rpcError(msg.id, ERR.INVALID_REQUEST, "Invalid JSON-RPC request"));

  if (era === "modern") {
    const hMethod = request.headers.get("mcp-method");
    if (hMethod !== msg.method) {
      return json(400, rpcError(msg.id, ERR.HEADER_MISMATCH, hMethod == null ? "Header mismatch: Mcp-Method header is required" : `Header mismatch: Mcp-Method header '${hMethod}' does not match body value '${msg.method}'`));
    }
    if (["tools/call", "resources/read", "prompts/get"].includes(msg.method)) {
      const bodyName = msg.params ? (msg.params.name ?? msg.params.uri) : undefined;
      const rawName = request.headers.get("mcp-name");
      const hName = decodeHeaderValue(rawName);
      if (hName !== bodyName) {
        return json(400, rpcError(msg.id, ERR.HEADER_MISMATCH, rawName == null ? "Header mismatch: Mcp-Name header is required" : `Header mismatch: Mcp-Name header '${hName}' does not match body value '${bodyName}'`));
      }
    }
  }

  const { status, body } = await dispatch(env, ctx, msg, era, version, log);
  return json(status, body, era === "modern" ? { "mcp-protocol-version": version } : {});
}
