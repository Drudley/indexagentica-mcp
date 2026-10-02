# Installing the Index Agentica MCP server

This is a **remote** MCP server. There is nothing to install, build or run locally, and no API key.

- URL: `https://mcp.indexagentica.com/mcp` (live once deployed; until then this URL does not resolve)
- Transport: Streamable HTTP (`streamable-http`)
- Auth: none. Read-only. Rate limit: 120 requests per minute per client IP.
- Tools: `search`, `get_entry`, `get_content`, `list_categories`

Claude Code:

```bash
claude mcp add --transport http indexagentica https://mcp.indexagentica.com/mcp
```

Generic MCP client configuration (Cline, Cursor and others that accept remote servers):

```json
{
  "mcpServers": {
    "indexagentica": {
      "type": "streamableHttp",
      "url": "https://mcp.indexagentica.com/mcp"
    }
  }
}
```

Some clients spell the transport key differently (`"type": "http"` or `"transport": "streamable-http"`); use your client's name for Streamable HTTP. No `command`, `args` or `env` are needed.

To check it works, call `search` with `{"query": "browser automation"}`.
