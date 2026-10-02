// Data layer: fetch the published directory index (/api/index.json) and the
// long-form index (/api/longform.json) once, cache them, and pre-compute
// lowercase search fields. Per-item long-form JSON is fetched on demand.
// Read-only.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const LONGFORM_TYPES = ["guide", "comparison", "stack", "skill"];
export const CONTENT_TYPES = ["entry", ...LONGFORM_TYPES];

let memo = null; // { loadedAt, index, entries, byId, categories, longform, longformByKey, longformAvailable }
let inflight = null;

export function prepare(index, lfIndex) {
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const byId = new Map();
  for (const e of entries) {
    e._type = "entry";
    e._s = {
      id: String(e.id || "").toLowerCase(),
      name: String(e.name || "").toLowerCase(),
      summary: String(e.summary || "").toLowerCase(),
      description: String(e.description || "").toLowerCase(),
      tags: (e.tags || []).map((t) => String(t).toLowerCase()),
      category: String(e.category || "").toLowerCase(),
    };
    byId.set(e.id, e);
  }
  // Categories: prefer the published list, but derive counts from entries so
  // new categories added by the build show up automatically.
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  const published = Array.isArray(index.categories) ? index.categories : [];
  const seen = new Set();
  const categories = [];
  for (const c of published) {
    seen.add(c.slug);
    categories.push({ ...c, count: counts[c.slug] || 0 });
  }
  for (const slug of Object.keys(counts).sort()) {
    if (!seen.has(slug)) categories.push({ slug, name: slug, count: counts[slug] });
  }
  // Long-form items (guides, comparisons, stacks, skills). Metadata only; the
  // markdown lives in each item's JSON (links.json).
  const longform = (lfIndex && Array.isArray(lfIndex.items) ? lfIndex.items : []).filter((x) => x && LONGFORM_TYPES.includes(x.type) && x.id);
  const longformByKey = new Map();
  for (const x of longform) {
    x._type = x.type;
    x._s = {
      id: String(x.id).toLowerCase(),
      name: String(x.title || x.id).toLowerCase(),
      summary: String(x.summary || "").toLowerCase(),
      description: [x.description, ...(x.entries || [])].filter(Boolean).join(" ").toLowerCase(),
      tags: (x.tags || []).map((t) => String(t).toLowerCase()),
      category: String(x.type).toLowerCase(),
    };
    longformByKey.set(`${x.type}:${x.id}`, x);
  }
  return { index, entries, byId, categories, longform, longformByKey, longformAvailable: !!lfIndex, longformGenerated: lfIndex?.generated };
}

const siteBase = (env) => env.DATA_BASE_URL || "https://indexagentica.com";

/** Fetch a JSON document from the site, via the Cache API when available. */
export async function fetchJson(env, ctx, url) {
  const ttlSec = Math.round(ttlMs(env) / 1000);
  const cacheKey = new Request(url, { method: "GET" });
  let cache = null;
  try {
    cache = typeof caches !== "undefined" ? caches.default : null;
  } catch {
    cache = null;
  }
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return await hit.json();
    } catch {
      /* Cache API unavailable (e.g. workers.dev) – fall through */
    }
  }
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "indexagentica-mcp/0.1 (+https://indexagentica.com)" },
    cf: { cacheTtl: ttlSec, cacheEverything: true },
  });
  if (!res.ok) {
    const e = new Error(`upstream ${url} returned HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const text = await res.text();
  const json = JSON.parse(text);
  if (cache) {
    const put = cache
      .put(cacheKey, new Response(text, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSec}` } }))
      .catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return json;
}

function ttlMs(env) {
  const n = Number(env.CACHE_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_TTL_MS;
}

/** Returns { index, entries, byId, categories, loadedAt, stale? } */
export async function getData(env, ctx) {
  const now = Date.now();
  if (memo && now - memo.loadedAt < ttlMs(env)) return memo;
  if (!inflight) {
    const base = siteBase(env);
    inflight = Promise.all([
      fetchJson(env, ctx, `${base}/api/index.json`),
      // Long-form is optional: if it can't be loaded, entries still work.
      fetchJson(env, ctx, `${base}/api/longform.json`).catch(() => null),
    ])
      .then(([index, lfIndex]) => {
        memo = { ...prepare(index, lfIndex), loadedAt: Date.now() };
        return memo;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    if (memo) return { ...memo, stale: true }; // serve stale on upstream failure
    throw err;
  }
}

/** Public view of an entry (strip internal search fields). */
export function publicEntry(e) {
  if (!e) return e;
  const { _s, _type, ...rest } = e;
  return rest;
}

export const ROUTES = { guide: "guides", comparison: "compare", stack: "stacks", skill: "skills" };

/** Full JSON of one long-form item (front matter, markdown, links, ...). */
export async function getLongformItem(env, ctx, item) {
  // Built from DATA_BASE_URL (not taken from the data) so we only ever fetch from the configured site.
  const url = `${siteBase(env)}/api/longform/${ROUTES[item.type]}/${encodeURIComponent(item.id)}.json`;
  return fetchJson(env, ctx, url);
}
