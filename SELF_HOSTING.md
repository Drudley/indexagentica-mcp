# Self-hosting indexagentica-mcp

This guide runs your own copy of the Worker from a fresh clone, on your own Cloudflare
account, reading your own mirror of the data. It doesn't use any of the maintainers'
infrastructure. The repo's `wrangler.toml` and [DEPLOY.md](DEPLOY.md) describe the
maintainers' own deployment (mcp.indexagentica.com). Don't deploy them as they are.

You need Node.js 20 or newer and git. A Cloudflare account is only needed for the
remote steps (sections 5 and 6). Everything in sections 1 to 4 runs locally.

## 1. Clone and configure

```bash
git clone https://github.com/Drudley/indexagentica-mcp.git
cd indexagentica-mcp
npm install
cp wrangler.example.toml wrangler.toml     # replaces the maintainers' config in your copy
cp .dev.vars.example .dev.vars             # local secrets for wrangler dev (git-ignored)
```

Edit `.dev.vars` and put random values in both lines, for example from `openssl rand -hex 32`:

```bash
sed -i "s/REPLACE_WITH_32_PLUS_RANDOM_CHARS/$(openssl rand -hex 32)/; s/REPLACE_WITH_RANDOM_SALT/$(openssl rand -hex 16)/" .dev.vars
```

On macOS, use `sed -i ''` instead of `sed -i`.

`wrangler.example.toml` has no account ID, custom domain, routes, KV or D1 IDs, `HIT_ORIGINS`
or `PUBLIC_BASE_URL`. Change `name` to your Worker name.

### Bindings: what is required

| Binding / setting | Required? | Without it |
| --- | --- | --- |
| `DATA_BASE_URL` var | yes (has a default) | defaults to `https://indexagentica.com` |
| `RATE_LIMITER` (Workers Rate Limiting) | optional | per-isolate token bucket with the same `RATE_LIMIT_*` numbers |
| `REQUESTS_DB` (D1) + `REQUESTS_ADMIN_TOKEN`, `REQUESTS_IP_SALT` secrets | optional | `/v1/requests` returns `503 unavailable`; the `request_listing` tool returns a tool error (`isError: true`); admin routes return `401` |
| `ANALYTICS`, `HITS` (Analytics Engine) | optional, commented out | no usage logging (no-op) |
| `STATS_KV` (KV), cron trigger, `CF_ACCOUNT_ID` var, `CF_ANALYTICS_TOKEN` secret | optional, commented out | `/stats` returns `"status": "collecting"`; the daily rollup does nothing; `/v1/admin/tool-calls` returns `503 not_configured` |
| `PUBLIC_BASE_URL` | optional | links use the request origin (your workers.dev URL) |
| `HIT_ORIGINS` | leave unset | `POST /hit` is the indexagentica.com page-view beacon; it isn't needed for MCP/REST |

Search, entries, long-form content, categories, the MCP endpoint, the OpenAPI document
and the server card need only `DATA_BASE_URL`. The unit test "self-hosted Worker without
ANALYTICS, HITS, STATS_KV, REQUESTS_DB, RATE_LIMITER or secrets degrades gracefully" in
`test/unit.test.mjs` checks the table above.

The template keeps the D1 binding with a placeholder `database_id`. That works for local
development. Before you deploy, create the database (section 5) or delete the
`[[d1_databases]]` block.

## 2. Data source: your own mirror

The Worker is read-only over published JSON. It fetches exactly these paths below
`DATA_BASE_URL` (`src/data.js`, `src/downloads.js`):

| Path | Used for |
| --- | --- |
| `/api/index.json` | all entries and categories (search, `get_entry`, `list_categories`, `/entries`, `/categories`). Required |
| `/api/longform.json` | long-form index (guides, comparisons, stacks, skills). Optional: if it fails, entries still work |
| `/api/longform/{guides,compare,stacks,skills}/<id>.json` | one long-form item's full JSON, fetched on demand by `get_content` / `/content/<type>/<id>` |
| `/skills/<id>.zip`, `/skills/<id>/SKILL.md` | not fetched: `/skills/...` on the Worker answers `302` to these URLs on `DATA_BASE_URL` |

Responses are cached for `CACHE_TTL_SECONDS` (default 600), in memory and through the Cache API.

To mirror the current data into `./mirror`:

```bash
node scripts/mirror-data.mjs --from https://indexagentica.com --out mirror
```

The script downloads every file in the table, plus an `ATTRIBUTION.txt`. `mirror/` is git-ignored. Add `--no-skills` to skip
the skill zips. Host the `mirror/` directory on any static host you control, such as
Cloudflare Pages, GitHub Pages, S3 or nginx. Then set `DATA_BASE_URL` in `wrangler.toml` to its base URL,
with no trailing slash. Re-run the script, for example from a daily cron, to pick up changes.
You can also build the data yourself from the site repository
([Drudley/indexagentica](https://github.com/Drudley/indexagentica): `npm run build` writes `dist/api/...`).

The data is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit
"Index Agentica (https://indexagentica.com)" wherever you republish it. The entries and long-form
items keep their own `links` back to indexagentica.com, and the `/skills/...` redirects point at your mirror.

To try the mirror locally before hosting it:

```bash
python3 -m http.server 8089 --bind 127.0.0.1 --directory mirror &
echo 'DATA_BASE_URL=http://127.0.0.1:8089' >> .dev.vars     # .dev.vars overrides [vars] in wrangler dev
```

## 3. Local D1 schema (optional, for request_listing)

```bash
npx wrangler d1 migrations apply my-agent-directory-requests --local
```

This applies `migrations/` to a local SQLite copy under `.wrangler/state/`. It doesn't need a
login or the real `database_id`. Use the `database_name` from your `wrangler.toml` if you
renamed it.

## 4. Run locally and smoke-test

```bash
npx wrangler dev --ip 127.0.0.1 --port 8787
```

Then, in a second terminal:

```bash
B=http://127.0.0.1:8787

# REST search
curl -sS -m 20 "$B/search?q=browser+automation&limit=2"

# MCP initialize (legacy handshake; the server is stateless, so no session id is returned)
curl -sS -m 20 "$B/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'

# MCP tools/list
curl -sS -m 20 "$B/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# MCP tools/call
curl -sS -m 20 "$B/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"mcp gateway","limit":3}}}'

# Optional: request_listing through D1 (needs section 3)
curl -sS -m 20 "$B/v1/requests" -H 'content-type: application/json' \
  -d '{"wanted":"Smoke test server","category":"tools","reason":"local smoke test"}'
```

Expected results:
- `/search` returns `{"query":...,"total":...,"results":[...]}`.
- `initialize` returns `serverInfo.name: "indexagentica-mcp"` and `protocolVersion: "2025-06-18"`.
- `tools/list` returns the five tools (`search`, `get_entry`, `get_content`, `list_categories`, `request_listing`).
- `tools/call` returns `result.structuredContent.results` with `"isError": false`.
- `/v1/requests` answers `201` with `"ok": true`.

The full local suite also runs on the template config. It covers unit tests, two `wrangler dev`
instances, REST and MCP end-to-end checks in both protocol eras, and the rate limit:

```bash
npm test
```

## 5. Your own Cloudflare resources (remote)

```bash
npx wrangler login                                         # or export CLOUDFLARE_API_TOKEN (Workers Scripts Edit, D1 Edit; KV Edit if used)
npx wrangler d1 create my-agent-directory-requests         # prints database_id -> wrangler.toml [[d1_databases]]
npx wrangler d1 migrations apply my-agent-directory-requests --remote
npx wrangler secret put REQUESTS_ADMIN_TOKEN               # >= 32 random chars; admin routes use Bearer <token>
npx wrangler secret put REQUESTS_IP_SALT                   # random; salts the hashed client IP used for rate limits and votes
```

Optional usage stats:
1. Enable Analytics Engine in the dashboard.
2. Uncomment the `ANALYTICS`/`HITS`/`STATS_KV`/cron block in `wrangler.toml`.
3. Run the following:

```bash
npx wrangler kv namespace create STATS_KV                  # prints the id -> [[kv_namespaces]] id
npx wrangler secret put CF_ANALYTICS_TOKEN                 # API token with Account Analytics Read
```

4. Set `CF_ACCOUNT_ID` in `[vars]`.

If `REQUESTS_IP_SALT` is not set, the Worker salts the hash with `REQUESTS_ADMIN_TOKEN` instead, or a
fixed string as a last resort. Set both secrets.

## 6. Deploy and smoke-test the deployed Worker

```bash
npx wrangler deploy
```

Wrangler prints `https://<name>.<your-subdomain>.workers.dev`. Run the curls from section 4
with `B=https://<name>.<your-subdomain>.workers.dev`, or run the end-to-end suite against it:

```bash
BASE=https://<name>.<your-subdomain>.workers.dev npm run test:e2e
```

Connect a client, for example: `claude mcp add --transport http my-directory https://<name>.<your-subdomain>.workers.dev/mcp`.

## What stays tied to indexagentica.com

- The default `DATA_BASE_URL`. Change it to your mirror.
- The server name and instructions in `src/mcp.js` (`SERVER_INFO`, `INSTRUCTIONS`), and the tool descriptions in `src/tools.js`
  (the `request_listing` description names the public queue on mcp.indexagentica.com). These describe the Index Agentica
  data and project. Edit them if you serve a different dataset or run your own queue. The `list` link in
  `request_listing` and `/v1/requests` responses already points at your own Worker (`PUBLIC_BASE_URL` or the request origin).
- `POST /hit` default origins. This is the site's page-view beacon, and it stores nothing without the `HITS` binding.
