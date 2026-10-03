// Per-request usage logging to Workers Analytics Engine (dataset `indexagentica_mcp`).
//
// Privacy (see README "Usage logging"): no IP addresses, no search query text,
// no tool arguments beyond low-cardinality filters and public catalog ids, no
// cookies or auth (there are none). User-Agent and client name/version are
// truncated. Country, colo and ASN come from Cloudflare's request.cf. ua_class
// ("human" for browser user agents, "agent" otherwise; src/ua.js) feeds /stats.
//
// No-op when the ANALYTICS binding is missing (local dev without the binding,
// unit tests, other environments), and never throws: logging must not affect
// responses.

import { uaClass } from "./ua.js";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Column layout. Keep in sync with the README table; append only, never reorder. */
export const BLOBS = [
  "route", "endpoint", "rpc_method", "tool", "client_name", "client_version", "user_agent",
  "protocol_version", "era", "outcome", "detail", "country", "colo", "type_filter",
  "category_filter", "target_id", "ua_class",
];
export const DOUBLES = ["http_status", "latency_ms", "asn", "result_count", "query_chars", "query_words"];

const cut = (v, n) => (v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, n));

/** Normalize a path to a low-cardinality endpoint label. */
export function endpointOf(path) {
  if (path === "/mcp") return "/mcp";
  if (/^\/entries\/[^/]+$/.test(path)) return "/entries/{id}";
  if (/^\/content\/[^/]+\/[^/]+$/.test(path)) return "/content/{type}/{id}";
  const known = ["/", "/search", "/entries", "/content", "/categories", "/openapi.json", "/.well-known/mcp/server-card.json"];
  return known.includes(path) ? path : "other";
}

export function newLog(request, path) {
  return {
    t0: Date.now(),
    route: path === "/mcp" ? "mcp" : "rest",
    endpoint: endpointOf(path),
    ua: request.headers.get("user-agent") || "",
    method: "", tool: "", clientName: "", clientVersion: "", protocol: "", era: "",
    detail: "", type: "", category: "", target: "",
    resultCount: NaN, queryChars: NaN, queryWords: NaN,
    rpcError: false, toolError: false,
  };
}

/** Record client identity from MCP params (2026-07-28 _meta clientInfo, or legacy initialize clientInfo). */
export function noteClient(log, params) {
  if (!log || !params || typeof params !== "object") return;
  const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const ci = meta["io.modelcontextprotocol/clientInfo"] || params.clientInfo;
  if (ci && typeof ci === "object") {
    if (typeof ci.name === "string") log.clientName = ci.name;
    if (typeof ci.version === "string") log.clientVersion = ci.version;
  }
}

/** Record privacy-safe facts about tool / REST arguments. */
export function noteArgs(log, tool, args) {
  if (!log) return;
  log.tool = tool || "";
  if (!args || typeof args !== "object") return;
  if (typeof args.query === "string") {
    log.queryChars = args.query.length;
    log.queryWords = args.query.trim() ? args.query.trim().split(/\s+/).length : 0;
  }
  const low = (v) => (typeof v === "string" && ID_RE.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : v == null || v === "" ? "" : "invalid");
  if (args.type != null) log.type = cut(low(args.type), 20);
  if (args.category != null) log.category = cut(low(args.category), 40);
  if (args.id != null) log.target = cut(low(args.id), 80);
}

export function outcomeOf(status, log) {
  if (status === 429) return "rate_limited";
  if (status >= 400 || log.rpcError || log.toolError) return "error";
  return "ok";
}

/** Build the Analytics Engine data point (exported for tests). */
export function dataPoint(log, status, cf = {}) {
  const outcome = outcomeOf(status, log);
  const blobs = [
    log.route, log.endpoint, cut(log.method, 40), cut(log.tool, 40), cut(log.clientName, 64), cut(log.clientVersion, 32),
    cut(log.ua, 128), cut(log.protocol, 16), log.era, outcome, cut(log.detail, 40), cut(cf.country, 4), cut(cf.colo, 8),
    log.type, log.category, log.target, uaClass(log.ua),
  ];
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const doubles = [status, Math.max(0, Date.now() - log.t0), num(Number(cf.asn)), num(log.resultCount), num(log.queryChars), num(log.queryWords)];
  const index = cut(`${log.route}:${log.tool || log.method || log.endpoint}`, 96);
  return { indexes: [index], blobs, doubles };
}

export function writeLog(env, request, log, status) {
  const ds = env && env.ANALYTICS;
  if (!ds || typeof ds.writeDataPoint !== "function" || !log) return false;
  try {
    ds.writeDataPoint(dataPoint(log, status, request.cf || {}));
    return true;
  } catch {
    return false;
  }
}
