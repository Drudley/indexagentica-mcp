// Rate limiting: Cloudflare Workers Rate Limiting binding when configured
// (env.RATE_LIMITER), otherwise a per-isolate token bucket fallback.

const buckets = new Map(); // key -> { tokens, updated }
const MAX_KEYS = 10000;

function fallbackLimit(key, limit, periodSec) {
  const now = Date.now();
  const rate = limit / (periodSec * 1000); // tokens per ms
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) buckets.clear(); // crude memory guard
    b = { tokens: limit, updated: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(limit, b.tokens + (now - b.updated) * rate);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { success: true };
  }
  return { success: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
}

export function clientKey(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/** @returns {Promise<{success: boolean, retryAfter: number, limit: number, period: number, mode: string}>} */
export async function checkRateLimit(request, env) {
  const limit = Number(env.RATE_LIMIT_REQUESTS) || 120;
  const period = Number(env.RATE_LIMIT_PERIOD_SECONDS) || 60;
  const key = `ip:${clientKey(request)}`;
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key });
      return { success, retryAfter: period, limit, period, mode: "binding" };
    } catch {
      /* fall through to in-isolate bucket */
    }
  }
  const r = fallbackLimit(key, limit, period);
  return { success: r.success, retryAfter: r.retryAfter || 0, limit, period, mode: "isolate" };
}
