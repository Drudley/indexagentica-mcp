// Tool definitions and implementations shared by MCP and REST.
import { getData, publicEntry } from "./data.js";
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
    id: { type: "string" },
    name: { type: "string" },
    category: { type: "string" },
    summary: { type: "string" },
    url: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    status: { type: "string" },
    pricing: { type: "string" },
    mcp_endpoint: { type: "string" },
    score: { type: "number" },
    links: { type: "object" },
  },
  required: ["id", "name", "category", "summary", "url"],
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
        "Search the Index Agentica directory of agent-usable resources (skills, harnesses, MCP servers, tools, protocols, APIs, information sources, finance/payments, directories). " +
        "Matches the query words against each entry's name, id, tags, summary and description and returns the best matches first, with a relevance score and links to the full entry (HTML, markdown, JSON). " +
        "Optionally filter by category and/or tags (an entry must have ALL given tags). An empty query with a filter lists everything in that filter. " +
        "Use get_entry with a returned id for full details.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: 200,
            description: "Free-text search words, e.g. \"browser automation\" or \"payments x402\". May be empty when category or tags are given.",
          },
          category: {
            type: "string",
            description: "Optional category slug to restrict results to." + catHint,
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
          category: { type: "string", description: "Category filter applied (omitted when none)." },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "integer" },
          total: { type: "integer", description: "Number of matching entries before the limit was applied." },
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
  if (typeof query !== "string") throw new ToolInputError("query must be a string");
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
  if (!query.trim() && !category && !(tags && tags.length)) {
    throw new ToolInputError("provide a query, a category or tags");
  }
  return search(data, { query, category, tags, limit });
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
  list_categories: runListCategories,
};

export { summarize };
