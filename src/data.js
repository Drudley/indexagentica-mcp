// Data layer: fetch the published directory index once, cache it, and
// pre-compute lowercase search fields. Read-only.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

let memo = null; // { loadedAt, index, entries, byId, categories }
let inflight = null;

function prepare(index) {
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const byId = new Map();
  for (const e of entries) {
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
  return { index, entries, byId, categories };
}

async function fetchIndex(env, ctx) {
  const url = `${env.DATA_BASE_URL || "https://indexagentica.com"}/api/index.json`;
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
  if (!res.ok) throw new Error(`upstream ${url} returned HTTP ${res.status}`);
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
    inflight = fetchIndex(env, ctx)
      .then((index) => {
        memo = { ...prepare(index), loadedAt: Date.now() };
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
  const { _s, ...rest } = e;
  return rest;
}
