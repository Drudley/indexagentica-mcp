// Direct skill downloads: GET/HEAD /skills/<id>.zip and /skills/<id>/SKILL.md on this host.
//
// Agents and scripts fetch skills with curl and never run the site's click beacon, so the published
// download links (llms.txt, /api/longform*.json, get_content) point here. Each request is recorded
// in the HITS dataset (index "hit:direct", same columns as site beacons plus `probe`) and then
// 302-redirected to the static file on the site (DATA_BASE_URL).
//
// - <id> must match a strict slug and be a published skill (site longform index, cached like all
//   other data); anything else is 404, so this is never an open redirect. The Location is built
//   from DATA_BASE_URL, never from the request.
// - Internal traffic (header / indexagentica UA, src/internal.js) is flagged and excluded from /stats.
// - HEAD requests and known crawler / link-checker / monitor UAs are recorded with probe=head|bot
//   and shown separately (site.direct_downloads.crawlers_and_probes), not as downloads.
// - Nothing else is stored: no IP, no referrer, no query string.
import { getData } from "./data.js";
import { uaClass } from "./ua.js";
import { internalRule } from "./internal.js";
import { checkRateLimit } from "./ratelimit.js";

export const SKILL_PATH_RE = /^\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)(\.zip|\/SKILL\.md)$/;
const MAX_ID = 64;
// Crawlers, link checkers, previewers and uptime monitors. Agent fetchers acting for a user
// (Claude-User, ChatGPT-User, curl, MCP clients) are not matched and count as downloads.
export const BOT_UA_RE =
  /bot\b|bot\/|crawl|spider|slurp|scrapy|facebookexternalhit|embedly|preview|uptime|monitor|pingdom|statuscake|linkcheck|link-check|validator|lighthouse|pagespeed|headless|phantomjs|archiver|feedfetcher|externalhit/i;

/** @returns {{id: string, kind: "zip"|"skill_md"} | null} for a /skills/... path, else null */
export function matchSkillPath(path) {
  const m = SKILL_PATH_RE.exec(path);
  if (!m || m[1].length > MAX_ID) return null;
  return { id: m[1], kind: m[2] === ".zip" ? "zip" : "skill_md" };
}

/** "head" for HEAD requests, "bot" for crawler / monitor UAs, "" for a counted download. */
export function probeOf(method, ua) {
  if (method === "HEAD") return "head";
  if (!ua || BOT_UA_RE.test(ua)) return ua ? "bot" : "";
  return "";
}

export function directDataPoint({ id, kind, path }, ua, cf = {}, rule = "", probe = "") {
  return {
    indexes: ["hit:direct"],
    // HIT_BLOBS order (src/hits.js) + probe (blob10).
    blobs: ["direct", path, id, "", kind, uaClass(ua), String(cf.country || "").slice(0, 4), rule ? "internal" : "outside", rule, probe],
    doubles: [1],
  };
}

const siteOf = (env) => (env.DATA_BASE_URL || "https://indexagentica.com").replace(/\/+$/, "");

export function targetUrl(env, { id, kind }) {
  const site = siteOf(env);
  return kind === "zip" ? `${site}/skills/${id}.zip` : `${site}/skills/${id}/SKILL.md`;
}

/**
 * Handle a matched skill path. reply(status, body) builds JSON errors; redirects are built here.
 * Never throws; recording never affects the response.
 */
export async function handleSkillDownload(request, env, ctx, match, path, reply, cors = {}) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return reply(405, { error: { status: 405, code: "method_not_allowed", message: "GET or HEAD only." } }, { allow: "GET, HEAD, OPTIONS" });
  }
  let d;
  try { d = await getData(env, ctx); } catch {
    return reply(503, { error: { status: 503, code: "unavailable", message: `Could not load the site index; try the static file on ${siteOf(env)}/skills/.` } }, { "retry-after": "60" });
  }
  if (!d.longformByKey || !d.longformByKey.has(`skill:${match.id}`)) {
    return reply(404, { error: { status: 404, code: "not_found", message: `No published skill "${match.id}". See ${siteOf(env)}/skills/.` } });
  }
  const ua = request.headers.get("user-agent") || "";
  // Own counter; over the limit the redirect still works, the request just isn't recorded.
  const rl = await checkRateLimit(request, env, "dl");
  const ds = env.HITS;
  if (rl.success && ds && typeof ds.writeDataPoint === "function") {
    try {
      ds.writeDataPoint(directDataPoint({ ...match, path }, ua, request.cf || {}, internalRule(request, env), probeOf(method, ua)));
    } catch { /* never affects the response */ }
  }
  return new Response(null, {
    status: 302,
    headers: { ...cors, location: targetUrl(env, match), "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
