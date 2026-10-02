// Tool definitions and implementations shared by MCP and REST.
import { getData, publicEntry, getLongformItem, LONGFORM_TYPES, CONTENT_TYPES } from "./data.js";
import { search, suggestIds, DEFAULT_LIMIT, MAX_LIMIT, summarize } from "./search.js";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ToolInputError extends Error {}
export class NotFoundError extends Error {
  constructor(message, extra) {
    super(message);
    this.extra = extra;
  }
}

const entrySummarySchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: CONTENT_TYPES, description: "entry (directory entry) or a long-form type: guide, comparison, stack, skill." },
    id: { type: "string" },
    name: { type: "string" },
    category: { type: "string", description: "Entries only." },
    summary: { type: "string" },
    url: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    author: { type: "string", description: "Long-form only." },
    last_verified: { type: "string", description: "Long-form only." },
    entries: { type: "array", items: { type: "string" }, description: "Long-form only: directory entry ids it references." },
    status: { type: "string" },
    pricing: { type: "string" },
    mcp_endpoint: { type: "string" },
    score: { type: "number" },
    links: { type: "object" },
  },
  required: ["type", "id", "name", "summary", "url"],
};

export function toolDefinitions(categorySlugs = []) {
  const catHint = categorySlugs.length
    ? ` Current categories: ${categorySlugs.join(", ")}.`
    : " Call list_categories for the current list.";
  return [
    {
      name: "search",
      title: "Search Index Agentica",
      description:
        "Search Index Agentica: the directory of agent-usable resources (skills, harnesses, MCP servers, tools, protocols, APIs, information sources, finance/payments, directories) " +
        "plus its long-form content (guides, comparisons, stacks and downloadable Agent Skills). " +
        "Matches the query words against name/title, id, tags, summary and description and returns the best matches first, each with its type, a relevance score and links (HTML, markdown, JSON). " +
        "Optionally filter by type (entry, guide, comparison, stack, skill; default all), category (entries only) and/or tags (ALL given tags must match). An empty query with a filter lists everything in that filter. " +
        "For full details use get_entry for type entry, or get_content with the type and id for long-form items.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: 200,
            description: "Free-text search words, e.g. \"browser automation\" or \"payments x402\". May be empty when category or tags are given.",
          },
          type: {
            type: "string",
            enum: [...CONTENT_TYPES, "all"],
            default: "all",
            description: "Optional result type: entry (directory entries), guide, comparison, stack, skill, or all (default).",
          },
          category: {
            type: "string",
            description: "Optional entry category slug to restrict results to (implies type entry)." + catHint,
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description: "Optional list of tag slugs; results must have all of them (e.g. [\"open-source\", \"python\"]).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            default: DEFAULT_LIMIT,
            description: `Maximum number of results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string", description: "Type filter applied (all when none)." },
          category: { type: "string", description: "Category filter applied (omitted when none)." },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "integer" },
          total: { type: "integer", description: "Number of matches before the limit was applied." },
          results: { type: "array", items: entrySummarySchema },
        },
        required: ["query", "total", "results"],
      },
      annotations: { title: "Search Index Agentica", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "get_entry",
      title: "Get directory entry",
      description:
        "Fetch one Index Agentica entry by its id (kebab-case slug, e.g. \"model-context-protocol\"). Returns every field: name, category, summary, description, url, repo, docs, tags, license, pricing, status, " +
        "agent_access (llms_txt, openapi, mcp_endpoint, auth), related ids, sources, dates and links. If the id is unknown the result is an error with suggested ids.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80, description: "Entry id (kebab-case slug) as returned by search." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { entry: { type: "object", description: "The full entry, following https://indexagentica.com/schema/entry.schema.json plus a links object." } },
        required: ["entry"],
      },
      annotations: { title: "Get directory entry", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "get_content",
      title: "Get guide, comparison, stack or skill",
      description:
        "Fetch one Index Agentica long-form item by type and id (as returned by search). Returns its metadata (title, summary, author, tags, dates, referenced entries with links, related items, sources, links) " +
        "and its markdown (scheme links resolved to absolute URLs). Comparisons include the structured table (criteria, one row per entry, verdict); stacks include the use case and components; " +
        "skills include the full SKILL.md (skill_md) plus download links (links.zip, links.skill_md). Unknown ids return an error with suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: LONGFORM_TYPES, description: "guide, comparison, stack or skill." },
          id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80, description: "Item id (kebab-case slug) as returned by search." },
          include_html: { type: "boolean", default: false, description: "Also return the rendered HTML body." },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          content: {
            type: "object",
            description: "The item: front_matter, markdown, links and type-specific fields (comparison, stack, skill_md). See https://indexagentica.com/openapi.json (LongformItem).",
            properties: { type: { type: "string" }, id: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, links: { type: "object" } },
            required: ["type", "id", "title", "markdown"],
          },
        },
        required: ["content"],
      },
      annotations: { title: "Get guide, comparison, stack or skill", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_categories",
      title: "List categories",
      description:
        "List all Index Agentica categories with their slug, name, description, entry count and links (HTML page and JSON). Use a slug as the category filter for search.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          total: { type: "integer", description: "Total number of entries in the directory." },
          generated: { type: "string", description: "When the published index was built." },
          categories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                slug: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                count: { type: "integer" },
                html: { type: "string" },
                json: { type: "string" },
              },
              required: ["slug", "name", "count"],
            },
          },
        },
        required: ["total", "categories"],
      },
      annotations: { title: "List categories", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

// ---- implementations (return plain objects; throw ToolInputError / NotFoundError) ----

export async function runSearch(env, ctx, args = {}) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("arguments must be an object");
  const { query = "", category, tags, limit } = args;
  const type = args.type == null || args.type === "" ? "all" : args.type;
  if (typeof query !== "string") throw new ToolInputError("query must be a string");
  if (typeof type !== "string" || ![...CONTENT_TYPES, "all"].includes(type.trim().toLowerCase()))
    throw new ToolInputError(`type must be one of: ${[...CONTENT_TYPES, "all"].join(", ")}`);
  const typ = type.trim().toLowerCase();
  if (category && typ !== "all" && typ !== "entry") throw new ToolInputError("category applies to directory entries only; use it with type entry (or omit type)");
  if (query.length > 200) throw new ToolInputError("query must be at most 200 characters");
  if (category != null && typeof category !== "string") throw new ToolInputError("category must be a string");
  if (tags != null && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) throw new ToolInputError("tags must be an array of strings");
  if (tags && tags.length > 10) throw new ToolInputError("at most 10 tags");
  if (limit != null && !(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= MAX_LIMIT))
    throw new ToolInputError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  const data = await getData(env, ctx);
  if (category && !data.categories.some((c) => c.slug === category.trim().toLowerCase())) {
    throw new ToolInputError(`unknown category "${category}". Valid: ${data.categories.map((c) => c.slug).join(", ")}`);
  }
  if (!query.trim() && !category && !(tags && tags.length) && typ === "all") {
    throw new ToolInputError("provide a query, a type, a category or tags");
  }
  return search(data, { query, category, tags, limit, type: typ });
}

export async function runGetEntry(env, ctx, args = {}) {
  const id = args && typeof args.id === "string" ? args.id.trim().toLowerCase() : null;
  if (!id) throw new ToolInputError("id is required (string)");
  const data = await getData(env, ctx);
  const e = ID_RE.test(id) ? data.byId.get(id) : undefined;
  if (!e) {
    const suggestions = suggestIds(data, id);
    throw new NotFoundError(`no entry with id "${id}"`, { suggestions });
  }
  return { entry: publicEntry(e) };
}

export async function runGetContent(env, ctx, args = {}) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("arguments must be an object");
  const type = typeof args.type === "string" ? args.type.trim().toLowerCase() : null;
  if (!type || !LONGFORM_TYPES.includes(type)) {
    throw new ToolInputError(`type is required: one of ${LONGFORM_TYPES.join(", ")}${type === "entry" ? " (use get_entry for directory entries)" : ""}`);
  }
  const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : null;
  if (!id) throw new ToolInputError("id is required (string)");
  if (args.include_html != null && typeof args.include_html !== "boolean") throw new ToolInputError("include_html must be a boolean");
  const data = await getData(env, ctx);
  const item = ID_RE.test(id) ? data.longformByKey.get(`${type}:${id}`) : undefined;
  if (!item) {
    const other = ID_RE.test(id) ? data.longform.find((x) => x.id === id) : undefined;
    const suggestions = suggestIds(data, id, 5, type);
    throw new NotFoundError(
      other ? `no ${type} with id "${id}"; it is a ${other.type}` : `no published ${type} with id "${id}"`,
      { suggestions, ...(other ? { type: other.type } : {}) },
    );
  }
  let full;
  try {
    full = await getLongformItem(env, ctx, item);
  } catch (err) {
    if (err && err.status === 404) throw new NotFoundError(`${type} "${id}" is no longer published`, { suggestions: [] });
    throw err;
  }
  const { html, raw, ...rest } = full || {};
  const content = { ...rest };
  if (type === "skill" && raw) content.skill_md = raw;
  if (args.include_html && html) content.html = html;
  if (typeof content.markdown !== "string") content.markdown = "";
  return { content };
}

export async function runListCategories(env, ctx) {
  const data = await getData(env, ctx);
  return {
    total: data.entries.length,
    generated: data.index.generated,
    categories: data.categories.map((c) => {
      const o = { slug: c.slug, name: c.name, count: c.count };
      if (c.description) o.description = c.description;
      if (c.html) o.html = c.html;
      if (c.json) o.json = c.json;
      return o;
    }),
  };
}

export const TOOL_IMPLS = {
  search: runSearch,
  get_entry: runGetEntry,
  get_content: runGetContent,
  list_categories: runListCategories,
};

export { summarize };
