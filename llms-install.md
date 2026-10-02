# Installing the Index Agentica MCP server

This is a **remote** MCP server. There is nothing to install, build or run locally, and no API key.

- URL: `https://mcp.indexagentica.com/mcp`
- Transport: Streamable HTTP (`streamable-http`)
- Auth: none. Read-only. Rate limit: 120 requests per minute per client IP.
- Tools: `search`, `get_entry`, `get_content`, `list_categories`

Claude Code:

```bash
claude mcp add --transport http indexagentica https://mcp.indexagentica.com/mcp
```

JSON configuration (Claude Code `.mcp.json`, which requires `"type": "http"`):

```json
{
  "mcpServers": {
    "indexagentica": {
      "type": "http",
      "url": "https://mcp.indexagentica.com/mcp"
    }
  }
}
```

Cline (`cline_mcp_settings.json`) uses `"type": "streamableHttp"` with the same `url`; other clients use their own name for Streamable HTTP. No `command`, `args` or `env` are needed.

To check it works, call `search` with `{"query": "browser automation"}`.
