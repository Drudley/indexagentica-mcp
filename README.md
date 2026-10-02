# indexagentica-mcp

Read-only **remote MCP server** (Streamable HTTP) and **REST search API** for
[Index Agentica](https://indexagentica.com), the agent-first directory of skills,
harnesses, MCP servers, tools, protocols and APIs, plus its long-form guides,
comparisons, stacks and downloadable Agent Skills. Runs on **Cloudflare Workers
(free plan)**, stateless, no Durable Objects, no auth, CORS open.

Target URL: `https://mcp.indexagentica.com/mcp` (see [DEPLOY.md](DEPLOY.md); until
the zone is on Cloudflare, use `https://indexagentica-mcp.<account-subdomain>.workers.dev/mcp`).

## Endpoints

| Method | Path | What |
| --- | --- | --- |
| POST | `/mcp` | MCP Streamable HTTP endpoint (JSON-RPC 2.0, JSON responses) |
| GET/DELETE | `/mcp` | `405` (no standalone SSE stream, no sessions) |
| GET | `/` | JSON self-description with links to the MCP endpoint, REST, llms.txt, docs |
| GET | `/search?q=&type=&category=&tags=a,b&limit=` | Ranked search over entries and long-form (`type`: `entry`, `guide`, `comparison`, `stack`, `skill` or `all` (default); `category` applies to entries; limit 1-50, default 10; tags are AND-ed) |
| GET | `/entries/<id>` (or `<id>.json`) | One full entry; `404` includes `suggestions` |
| GET | `/entries` | All ids |
| GET | `/content/<type>/<id>` (or `<id>.json`) | One guide, comparison, stack or skill: metadata + markdown (`?include_html=1` adds HTML); `404` includes `suggestions` |
| GET | `/content?type=` | Published long-form items (metadata) |
| GET | `/categories` | Categories with counts |
| GET | `/openapi.json` | OpenAPI 3.1 for the REST API |
| GET | `/health` | Liveness (not rate limited) |

Errors are always JSON: `{"error":{"status":400,"code":"bad_request","message":"..."}}`
(codes: `bad_request`, `not_found`, `method_not_allowed`, `rate_limited`, `upstream_error`).

## MCP tools

| Tool | Input | Output (`structuredContent`) |
| --- | --- | --- |
| `search` | `query` (string), `type?` (`entry`\|`guide`\|`comparison`\|`stack`\|`skill`\|`all`, default all), `category?` (slug; entries only), `tags?` (string[], all must match), `limit?` (1-50) | `{query, type, category?, tags, limit, total, results[]}`; each result has `type, id, name, summary, url, tags, score, links`, plus `category` (entries) or `author, last_verified, entries` (long-form) |
| `get_entry` | `id` (kebab-case) | `{entry}` (the full entry per the [entry schema](https://indexagentica.com/schema/entry.schema.json) + `links` + `longform` back-references) |
| `get_content` | `type` (`guide`\|`comparison`\|`stack`\|`skill`), `id`, `include_html?` | `{content}`: front matter, metadata, `markdown` (scheme links resolved to absolute URLs), `links`; comparisons add `comparison` (criteria, table, verdict), stacks add `stack` (use case, components), skills add `skill_md` (full SKILL.md) and `links.zip` / `links.skill_md` |
| `list_categories` | none | `{total, generated, categories[{slug,name,description,count,html,json}]}` |

Every tool has a JSON-Schema `inputSchema`, an `outputSchema`, `readOnlyHint`
annotations, and returns both `structuredContent` and the same JSON as a `text`
content block. Bad arguments and unknown ids come back as `isError: true` tool
results (so the model can correct itself); an unknown tool name is JSON-RPC `-32602`.

Scoring: per query word, exact id/name match 12, id segment 6, name substring 5,
exact tag 4 (partial tag 2), summary 2, category 1.5, description 1; +8 if the
whole phrase is in the name; multiplied by the fraction of words matched.

## Protocol support (dual-era, stateless)

* **2026-07-28 (current spec, "modern")**: no handshake. Each POST carries
  `_meta["io.modelcontextprotocol/protocolVersion"]` and the `MCP-Protocol-Version`,
  `Mcp-Method` (and for `tools/call`, `Mcp-Name`, base64 sentinel supported) headers.
  The server validates headers against the body (`-32020 HeaderMismatch`), rejects
  unknown versions with `-32022` + `supported` list, implements `server/discover`,
  returns `resultType: "complete"`, `serverInfo` in result `_meta`, and
  `ttlMs`/`cacheScope` caching hints on `tools/list` and `server/discover`. Unknown
  methods -> HTTP 404 + `-32601`.
* **2025-11-25 / 2025-06-18 / 2025-03-26 ("legacy")**: `initialize` is answered
  (version negotiated, falling back to 2025-11-25), `notifications/initialized` -> 202,
  `ping`, `tools/list`, `tools/call`; 2025-03-26 batches are accepted. **No
  `Mcp-Session-Id` is ever issued**, so every request is independent and any
  Worker isolate can serve it.
* Responses are always `application/json` (never SSE). `Origin` is checked against
  `ALLOWED_ORIGINS` (default `*` because the data is public and read-only).

Spec refs: [Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[Versioning / dual-era](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).

## Data & caching

Source of truth is the published static site: `GET https://indexagentica.com/api/index.json`
(all entries + categories) and `GET /api/longform.json` (long-form metadata), fetched
together; if the long-form index can't be loaded, entries keep working. `get_content`
fetches `/api/longform/<route>/<id>.json` on demand (same cache), always from
`DATA_BASE_URL`. The Worker keeps the indexes in isolate memory for
`CACHE_TTL_SECONDS` (600 s), also stores it in the Cloudflare Cache API (effective
on a custom domain; a no-op on workers.dev), coalesces concurrent refreshes, and
serves the stale copy if the upstream fetch fails. New categories added by the site
build appear automatically. Nothing is written anywhere.

## Rate limiting

* Default: **120 requests / 60 s per client IP, per Cloudflare location**, via the
  [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
  (`[[ratelimits]]` in `wrangler.toml`, GA since Sept 2025; period must be 10 or 60 s).
  It is intentionally approximate (eventually consistent, per location).
* If the binding is absent or errors, a per-isolate token bucket with the same
  numbers (`RATE_LIMIT_REQUESTS` / `RATE_LIMIT_PERIOD_SECONDS`) is used instead.
* Exceeding it returns **HTTP 429** with `Retry-After`; on `/mcp` the body is a
  JSON-RPC error (`-32000`), elsewhere the JSON error envelope. `/health` and
  `OPTIONS` are not metered. Responses carry `x-ratelimit-limit` / `x-ratelimit-period`.
* Free-plan ceiling to keep in mind: Workers Free allows **100,000 requests/day per
  account** and 10 ms CPU per request ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
  A cold search costs ~1-3 ms CPU (parsing the ~135 KB index); warm requests well under 1 ms.

## Local development & tests

```bash
npm install
npm run dev                  # wrangler dev on http://127.0.0.1:8787 (no Cloudflare login needed)
npm test                     # unit tests + 2x wrangler dev + E2E (REST, MCP both eras, rate limit) + MCP Inspector CLI
npm run test:unit            # pure unit tests (no network)
BASE=https://<deployed-host> npm run test:e2e   # E2E against any deployment
DATA_BASE_URL=http://127.0.0.1:8089 npm test   # point the local Workers at another copy of the site
```

The long-form E2E checks adapt to the data: with published items they fetch one of
each type over REST and MCP; with none (all drafts) they check the empty listings and
not-found paths. To exercise the full path before anything is published, build the
site with drafts published (e.g. `INCLUDE_DRAFTS=1 SITE_URL=http://127.0.0.1:8089 node scripts/build.mjs`
in the site repo), serve `dist/` on that port, and run `npm test` with `DATA_BASE_URL` set.

`scripts/test-local.sh` starts the normal Worker on :8797 and a low-limit copy
(`--env ratelimit-test`, 5 req / 10 s) on :8798, runs `test/e2e.mjs`, then checks
the server with `@modelcontextprotocol/inspector --cli` in the default legacy era and
pinned to the modern era (`protocolEra: "modern"` config).

Manual checks:

```bash
npx mcp-inspector --cli http://127.0.0.1:8787/mcp --transport http --method tools/list
npx mcp-inspector --cli http://127.0.0.1:8787/mcp --transport http --method tools/call \
  --tool-name search --tool-args-json '{"query":"browser automation","limit":3}'
curl -s http://127.0.0.1:8787/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_entry","arguments":{"id":"x402"}}}'
```

## Connecting a client

```bash
claude mcp add --transport http indexagentica https://mcp.indexagentica.com/mcp
```

```json
{ "mcpServers": { "indexagentica": { "url": "https://mcp.indexagentica.com/mcp" } } }
```

## Configuration (`wrangler.toml` `[vars]`)

| Var | Default | Meaning |
| --- | --- | --- |
| `DATA_BASE_URL` | `https://indexagentica.com` | Where `/api/index.json` is fetched from |
| `CACHE_TTL_SECONDS` | `600` | In-memory / Cache API TTL |
| `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_PERIOD_SECONDS` | `120`, `60` | Documented limit + fallback bucket (keep in sync with `[ratelimits.simple]`) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated Origin allow-list for browser callers |
| `PUBLIC_BASE_URL` | request origin | Canonical base for links in `GET /` |

## Deploy

See **[DEPLOY.md](DEPLOY.md)** for the options for `mcp.indexagentica.com` and the
exact Cloudflare/GoDaddy access needed. Short version:

```bash
export CLOUDFLARE_ACCOUNT_ID=...   # from the Cloudflare dashboard
export CLOUDFLARE_API_TOKEN=...    # custom token, permissions in DEPLOY.md
npm run deploy:dry                 # build only
npm run deploy                     # -> https://indexagentica-mcp.<subdomain>.workers.dev
# after the zone is on Cloudflare: uncomment `routes` in wrangler.toml, set
# PUBLIC_BASE_URL, and run `npm run deploy` again.
BASE=https://mcp.indexagentica.com npm run test:e2e
```

## Layout

```
src/index.js      router, CORS, JSON errors, REST endpoints, rate-limit gate
src/mcp.js        stateless dual-era MCP JSON-RPC handler
src/tools.js      tool definitions (schemas) + implementations shared with REST
src/search.js     scoring / filtering
src/data.js       fetch + cache of /api/index.json
src/ratelimit.js  Workers rate limiting binding + in-isolate fallback
src/openapi.js    OpenAPI document for the REST API
test/             unit tests, E2E script, Inspector config
docs/             proposed copy for llms.txt, /agents and the directory listing
```

License: code MIT; directory content CC BY 4.0.
