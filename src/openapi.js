export function openapi(base) {
  const err = { $ref: "#/components/schemas/Error" };
  return {
    openapi: "3.1.0",
    info: {
      title: "Index Agentica search API",
      version: "0.1.0",
      description: "Read-only search over the Index Agentica directory and its long-form content (guides, comparisons, stacks, skills). No auth, CORS open, rate limited per client IP. The same data is available over MCP at POST /mcp.",
      license: { name: "CC-BY-4.0 (content), MIT (code)" },
    },
    servers: [{ url: base }],
    paths: {
      "/search": {
        get: {
          operationId: "search",
          summary: "Search entries and long-form items (guides, comparisons, stacks, skills) by keywords, type, category and tags",
          parameters: [
            { name: "q", in: "query", schema: { type: "string", maxLength: 200 }, description: "Search words" },
            { name: "type", in: "query", schema: { type: "string", enum: ["entry", "guide", "comparison", "stack", "skill", "all"], default: "all" }, description: "Result type" },
            { name: "category", in: "query", schema: { type: "string" }, description: "Entry category slug (implies type entry)" },
            { name: "tags", in: "query", schema: { type: "string" }, description: "Comma-separated tags; all must match" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
          ],
          responses: { 200: { description: "Ranked results" }, 400: { description: "Bad request", content: { "application/json": { schema: err } } }, 429: { description: "Rate limited" } },
        },
      },
      "/entries/{id}": {
        get: {
          operationId: "getEntry",
          summary: "Get one entry by id",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } }],
          responses: { 200: { description: "Entry (see https://indexagentica.com/schema/entry.schema.json)" }, 404: { description: "Not found, with suggestions", content: { "application/json": { schema: err } } } },
        },
      },
      "/content": {
        get: {
          operationId: "listContent",
          summary: "List published long-form items (metadata only)",
          parameters: [{ name: "type", in: "query", schema: { type: "string", enum: ["guide", "comparison", "stack", "skill"] } }],
          responses: { 200: { description: "Items" }, 400: { description: "Bad request", content: { "application/json": { schema: err } } } },
        },
      },
      "/content/{type}/{id}": {
        get: {
          operationId: "getContent",
          summary: "Get one guide, comparison, stack or skill: metadata plus markdown",
          parameters: [
            { name: "type", in: "path", required: true, schema: { type: "string", enum: ["guide", "comparison", "stack", "skill"] } },
            { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
            { name: "include_html", in: "query", schema: { type: "boolean", default: false } },
          ],
          responses: { 200: { description: "Item (see LongformItem in https://indexagentica.com/openapi.json); skills include skill_md" }, 400: { description: "Bad request", content: { "application/json": { schema: err } } }, 404: { description: "Not found, with suggestions", content: { "application/json": { schema: err } } } },
        },
      },
      "/.well-known/mcp/server-card.json": { get: { operationId: "getServerCard", summary: "Static MCP server card (serverInfo, authentication, tools, resources, prompts), generated from the tool definitions", responses: { 200: { description: "Server card" } } } },
      "/categories": { get: { operationId: "listCategories", summary: "List categories with counts", responses: { 200: { description: "Categories" } } } },
      "/mcp": { post: { operationId: "mcp", summary: "MCP Streamable HTTP endpoint (JSON-RPC 2.0)", responses: { 200: { description: "JSON-RPC response" }, 202: { description: "Notification accepted" } } } },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { status: { type: "integer" }, code: { type: "string" }, message: { type: "string" }, suggestions: { type: "array", items: { type: "string" } } } } },
        },
      },
    },
  };
}
