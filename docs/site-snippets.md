# Proposed copy for the main site (do not apply until the endpoint is deployed)

Replace `MCP_URL` with the final URL (`https://mcp.indexagentica.com/mcp`, or the
workers.dev URL while option (c) is in use).

## llms.txt (new section under "Machine-readable")

```
- [MCP server](MCP_URL): remote MCP (Streamable HTTP, no auth, read-only). Tools: search(query, category?, tags?, limit?), get_entry(id), list_categories(). Supports MCP 2026-07-28 and 2025-03-26..2025-11-25 (stateless; no session id).
- [Search API](MCP_BASE/search?q=browser): GET /search?q=&category=&tags=a,b&limit=, GET /entries/{id}, GET /categories; JSON, CORS open; OpenAPI at MCP_BASE/openapi.json. Rate limit 120 req/min per IP.
```

## /agents page section

> ### Use Index Agentica over MCP
> Add the remote MCP server `MCP_URL` (transport: Streamable HTTP, no auth):
>
> `claude mcp add --transport http indexagentica MCP_URL`
>
> or in any client's config: `{"mcpServers":{"indexagentica":{"url":"MCP_URL"}}}`
>
> Tools: `search` (query, optional category slug, optional tags (all must match), limit 1-50),
> `get_entry` (id), `list_categories`. Results include `structuredContent` and links to the
> HTML/markdown/JSON for each entry. Read-only, refreshed from the published index every ~10 min.
> Rate limit 120 requests/min per IP (HTTP 429 + Retry-After).
> A plain REST mirror exists: `GET MCP_BASE/search?q=...`, `/entries/{id}`, `/categories`.

## Directory listing: content/mcp-servers/indexagentica-mcp.json

```json
{
  "id": "indexagentica-mcp",
  "name": "Index Agentica MCP Server",
  "category": "mcp-servers",
  "summary": "Remote, read-only MCP server for searching the Index Agentica directory: search, get_entry and list_categories over Streamable HTTP, no auth.",
  "description": "Stateless remote MCP server on Cloudflare Workers that serves the published Index Agentica index. Tools: `search` (query, category, tags, limit), `get_entry` (id) and `list_categories`. Supports MCP 2026-07-28 (per-request metadata, server/discover) and the 2025-03-26 to 2025-11-25 initialize handshake without sessions. Also exposes a REST mirror (/search, /entries/{id}, /categories) with an OpenAPI document. Rate limited to 120 requests per minute per IP.",
  "url": "MCP_BASE/",
  "repo": "https://github.com/Drudley/indexagentica-mcp",
  "tags": ["remote-mcp", "streamable-http", "search", "directory", "cloudflare-workers", "no-auth"],
  "license": "MIT",
  "pricing": "free",
  "status": "beta",
  "agent_access": {
    "mcp_endpoint": "MCP_URL",
    "openapi": "MCP_BASE/openapi.json",
    "llms_txt": "https://indexagentica.com/llms.txt",
    "auth": "none",
    "notes": "Read-only. 120 requests/min per IP. Data refreshed from https://indexagentica.com/api/index.json every ~10 minutes."
  },
  "related": ["model-context-protocol"],
  "sources": ["MCP_BASE/"],
  "added": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "submitted_by": "indexagentica-maintainers"
}
```
(`repo` assumes the MCP code gets its own public repo `Drudley/indexagentica-mcp`. Drop the
field if it ends up inside the main repo instead.)
