// Crawlers, monitors and probes: one term list for direct downloads (BOT_UA_RE, src/downloads.js)
// and the API usage stats (API_PROBE, src/stats.js), so the two cannot drift apart.
//
// Analytics Engine SQL has no regex function, so every term is a plain case-insensitive substring
// (JS regex and SQL ILIKE '%term%' agree), except "bot", which only matches at the end of a word
// (regex bot\b; in SQL: "bot" at the end of the value or followed by a non-word character).

/** Shared crawler / link-checker / previewer / monitor tokens (the BOT_UA_RE list). */
export const BOT_TERMS = [
  "crawl", "spider", "slurp", "scrapy", "facebookexternalhit", "embedly", "preview", "uptime", "monitor", "pingdom",
  "statuscake", "linkcheck", "link-check", "validator", "lighthouse", "pagespeed", "headless", "phantomjs",
  "archiver", "feedfetcher", "externalhit",
];
/** Extra tokens for MCP / REST traffic only: registry liveness probes, conformance and security scanners.
 * Not used for direct downloads (their classification is unchanged). */
export const API_PROBE_TERMS = [
  "probe", "liveness", "health", "check", "verify", "conformance", "audit", "scan", "research", "census", "survey",
  "harvester", "collector", "indexer", "inventory", "observatory",
];

/** Fetchers acting for a user right now (not crawlers), never probes even though their UA links a
 * "/bot" page (ChatGPT-User: "+https://openai.com/bot"). */
export const USER_FETCHER_TERMS = ["chatgpt-user", "claude-user", "perplexity-user", "mistralai-user"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = (terms) => new RegExp(["bot\\b", "bot\\/", ...terms.map(esc)].join("|"), "i");

// Crawlers, link checkers, previewers and uptime monitors. Agent fetchers acting for a user
// (Claude-User, ChatGPT-User, curl, MCP clients) are not matched.
export const BOT_UA_RE = re(BOT_TERMS);
export const API_PROBE_RE = re([...BOT_TERMS, ...API_PROBE_TERMS]);

const USER_FETCHER_RE = new RegExp(USER_FETCHER_TERMS.map(esc).join("|"), "i");

/** True if an MCP / REST request row is a probe: its User-Agent or its MCP client name matches,
 * and the User-Agent is not a user-initiated fetcher. */
export function isApiProbe(ua, client) {
  const u = String(ua || ""), c = String(client || "");
  return (API_PROBE_RE.test(u) || API_PROBE_RE.test(c)) && !USER_FETCHER_RE.test(u);
}

// Non-word characters that can follow "bot" (\b). SQL-safe only: no quote, backslash, % or _.
const NON_WORD = " !\"#$&()*+,-./:;<=>?@[]^`{|}~".split("");
const likeCol = (col) => [
  `${col} ILIKE '%bot'`,
  ...NON_WORD.map((c) => `${col} ILIKE '%bot${c}%'`),
  ...[...BOT_TERMS, ...API_PROBE_TERMS].map((t) => `${col} ILIKE '%${t}%'`),
];
/** SQL condition on the MCP dataset, same as isApiProbe(blob7 = User-Agent, blob5 = client name). */
export const API_PROBE = `((${[...likeCol("blob7"), ...likeCol("blob5")].join(" OR ")}) AND NOT (${USER_FETCHER_TERMS.map((t) => `blob7 ILIKE '%${t}%'`).join(" OR ")}))`;
