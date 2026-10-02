// Simple, deterministic relevance scoring over name / id / tags / summary /
// description. Designed for a few hundred to a few thousand items. Covers
// directory entries and long-form items (guides, comparisons, stacks, skills).

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export function tokenize(q) {
  return String(q || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function scoreEntry(s, tokens, phrase) {
  let score = 0;
  let matched = 0;
  for (const t of tokens) {
    let ts = 0;
    if (s.id === t || s.name === t) ts += 12;
    if (s.id.split("-").includes(t)) ts += 6;
    if (s.name.includes(t)) ts += 5;
    if (s.tags.includes(t)) ts += 4;
    else if (s.tags.some((tag) => tag.includes(t))) ts += 2;
    if (s.category.includes(t)) ts += 1.5;
    if (s.summary.includes(t)) ts += 2;
    if (s.description.includes(t)) ts += 1;
    if (ts > 0) matched++;
    score += ts;
  }
  if (tokens.length > 1 && phrase) {
    if (s.name.includes(phrase)) score += 8;
    else if (s.summary.includes(phrase) || s.description.includes(phrase)) score += 3;
  }
  if (tokens.length > 0) {
    if (matched === 0) return 0;
    score *= matched / tokens.length; // favour entries that match every term
  }
  return Math.round(score * 100) / 100;
}

export function normalizeTags(tags) {
  if (tags == null) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(",");
  return arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

/**
 * @param data   result of getData()
 * @param params { query, category, tags, limit, type }
 *   type: "entry" | "guide" | "comparison" | "stack" | "skill" | "all" (default "all").
 *   category applies to entries only, so a category filter implies type "entry".
 * @returns { query, type, category, tags, limit, total, results: [...] }
 */
export function search(data, { query = "", category, tags, limit, type } = {}) {
  const tokens = tokenize(query);
  const phrase = String(query || "").toLowerCase().trim();
  const cat = category ? String(category).trim().toLowerCase() : null;
  const wantTags = normalizeTags(tags);
  let lim = Number.parseInt(limit ?? DEFAULT_LIMIT, 10);
  if (!Number.isFinite(lim) || lim < 1) lim = DEFAULT_LIMIT;
  lim = Math.min(lim, MAX_LIMIT);

  const typ = type ? String(type).trim().toLowerCase() : "all";
  const pool = typ === "entry" || cat ? data.entries
    : typ === "all" ? data.entries.concat(data.longform || [])
    : (data.longform || []).filter((x) => x.type === typ);

  const hits = [];
  for (const e of pool) {
    const s = e._s;
    if (cat && s.category !== cat) continue;
    if (wantTags.length && !wantTags.every((t) => s.tags.includes(t))) continue;
    const score = tokens.length ? scoreEntry(s, tokens, phrase) : 1;
    if (score <= 0) continue;
    hits.push({ e, score });
  }
  const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  hits.sort((a, b) => b.score - a.score || byName(a.e._s.name, b.e._s.name));
  return {
    query: String(query || ""),
    type: cat && typ === "all" ? "entry" : typ,
    ...(cat ? { category: cat } : {}),
    tags: wantTags,
    limit: lim,
    total: hits.length,
    results: hits.slice(0, lim).map(({ e, score }) => summarize(e, score)),
  };
}

export function summarize(e, score) {
  if (e._type && e._type !== "entry") return summarizeLongform(e, score);
  const out = {
    type: "entry",
    id: e.id,
    name: e.name,
    category: e.category,
    summary: e.summary,
    url: e.url,
    tags: e.tags || [],
  };
  if (e.status) out.status = e.status;
  if (e.pricing) out.pricing = e.pricing;
  if (e.agent_access && e.agent_access.mcp_endpoint) out.mcp_endpoint = e.agent_access.mcp_endpoint;
  if (score !== undefined) out.score = score;
  if (e.links) out.links = e.links;
  return out;
}

export function summarizeLongform(x, score) {
  const out = {
    type: x.type,
    id: x.id,
    name: x.title || x.id,
    summary: x.summary || "",
    url: (x.links && x.links.html) || "",
    tags: x.tags || [],
  };
  if (x.author) out.author = x.author;
  if (x.last_verified) out.last_verified = x.last_verified;
  if (x.entries && x.entries.length) out.entries = x.entries;
  if (score !== undefined) out.score = score;
  if (x.links) out.links = x.links;
  return out;
}

/** Up to n ids that look like `id` (for "did you mean" on misses). */
export function suggestIds(data, id, n = 5, type = "entry") {
  const r = search(data, { query: String(id).replace(/[-_]+/g, " "), limit: n, type });
  return r.results.map((x) => x.id);
}
