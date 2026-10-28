# indexagentica-mcp

**Remote MCP server** (Streamable HTTP) and **REST search API** for
[Index Agentica](https://indexagentica.com), the agent-first directory of skills,
harnesses, MCP servers, tools, protocols and APIs, plus its long-form guides,
comparisons, stacks and downloadable Agent Skills. Runs on **Cloudflare Workers
(free plan)**, stateless, no Durable Objects, no auth, CORS open. Read-only except
`request_listing` / `POST /v1/requests`, which queue a listing request for Curator review (D1).

**Self-hosting:** see [SELF_HOSTING.md](SELF_HOSTING.md) to run your own copy from a fresh clone (template config, your own KV/D1, your own data mirror, local and remote smoke tests). `wrangler.toml` and [DEPLOY.md](DEPLOY.md) are the maintainers' own deployment.

## Install

Remote server: no install, no API key. Streamable HTTP at `https://mcp.indexagentica.com/mcp` (live).

```bash
claude mcp add --transport http indexagentica https://mcp.indexagentica.com/mcp
```

Other clients: add the URL as a Streamable HTTP server with no auth (see [llms-install.md](llms-install.md)).
The same Worker also answers at `https://indexagentica-mcp.indexagentica.workers.dev/mcp`
(see [DEPLOY.md](DEPLOY.md)).

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
| GET | `/.well-known/mcp/server-card.json` | Static server card (Smithery scan fallback): `serverInfo`, `authentication: {required: false}`, the same `tools` as `tools/list`, empty `resources`/`prompts` |
| GET | `/stats` | Public usage stats (JSON): site page views, outbound clicks, skill downloads, MCP tool calls per tool, REST requests, agent/human split; last 24h, last 7 days, all time since the `since` timestamps. Cached 10 min. See [Usage stats](#usage-stats-get-stats) |
| GET | `/v1/usage` | Alias of `/stats` (used by the site; less likely to be caught by content-blocker filters) |
| POST | `/v1/e` | Alias of `/hit` (used by the site) |
| GET, HEAD | `/skills/{id}.zip`, `/skills/{id}/SKILL.md` | Direct skill download: records one download, then `302` to the static file on indexagentica.com. Unknown ids `404`. See [Direct skill downloads](#direct-skill-downloads-get-skillsid) |
| POST | `/hit` | Site usage beacon from indexagentica.com's inline script (origin-checked, strictly validated, 204). See [Site beacons](#site-beacons-post-hit) |
| POST | `/v1/requests` | Request a listing (same logic as the `request_listing` tool). JSON body `{wanted, category, url?, reason?, requester?}`; `201` new, `200` merged. See [Listing requests](#listing-requests) |
| GET | `/v1/requests?status=&limit=` | Public most-requested list (sanitized; rejected hidden; `url` only for verified/listed) |
| GET | `/v1/requests/admin?status=` | Curator: full queue (Bearer `REQUESTS_ADMIN_TOKEN`) |
| POST | `/v1/requests/<id>/status` | Curator: `{status, entry_id?, note?}` or `{delete: true}` (Bearer token) |
| GET | `/v1/admin/tool-calls?hours=48` | Admin: outside `tools/call` counts by requested tool name and client, incl. unknown names (Bearer token; not on /stats) |
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
| `request_listing` | `wanted` (≤120), `category` (category slug or `other`), `url?` (http(s), ≤300), `reason?` (≤500), `requester?` (≤60) | `{ok, id, merged, vote_counted, request{id,wanted,category,votes,status,first_seen,last_seen}, note, list}`. The only non-read-only tool (`readOnlyHint: false`, not destructive) |

Every tool has a JSON-Schema `inputSchema`, an `outputSchema`, `readOnlyHint`
annotations, and returns both `structuredContent` and the same JSON as a `text`
content block. Bad arguments and unknown ids come back as `isError: true` tool
results (so the model can correct itself); an unknown tool name is JSON-RPC `-32602`
whose message lists the valid tools and, when one is a clear match (client namespace
prefixes such as `mcp__indexagentica__search`, synonyms such as `search_index`/`find`,
typos within edit distance 2), suggests it: `error.data = {requested, valid_tools, suggestion?}`.
Suggestions are never executed. Explicit aliases (`TOOL_ALIASES` in `src/tools.js`) are only
added for unambiguous names real clients were observed calling, are not advertised in
`tools/list`, and the originally requested name is what gets logged (`detail = alias:<tool>`).

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

## Usage logging (Workers Analytics Engine)

Each request (except `OPTIONS`, `/health`, `/robots.txt`, `/favicon.ico`, `/hit`, `/stats`) writes one data point to the
Analytics Engine dataset **`indexagentica_mcp`** (binding `ANALYTICS` in `wrangler.toml`), so we can count
agent usage per tool and client. If the binding is missing (local tests, the `ratelimit-test` env),
logging is a no-op, and a failing write never affects the response. Workers Free includes
100,000 data points written per day ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/));
data is kept for 3 months ([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)).

| Column | Field | Notes |
| --- | --- | --- |
| `index1` | `<route>:<tool or method or endpoint>` | e.g. `mcp:search`, `rest:get_entry` |
| `blob1` | route | `mcp` or `rest` |
| `blob2` | endpoint | normalized: `/mcp`, `/search`, `/entries/{id}`, `/content/{type}/{id}`, ..., `other` |
| `blob3` | JSON-RPC method | `initialize`, `tools/call`, `batch`, ... (MCP only) |
| `blob4` | tool | MCP tool name, or the REST equivalent (`search`, `get_entry`, `get_content`, `list_content`, `list_categories`) |
| `blob5`, `blob6` | client name, version | from `initialize` `clientInfo` or 2026-07-28 `_meta["io.modelcontextprotocol/clientInfo"]`; truncated to 64/32 chars |
| `blob7` | User-Agent | truncated to 128 chars |
| `blob8`, `blob9` | protocol version, era | `modern` / `legacy` |
| `blob10` | outcome | `ok`, `error` (HTTP ≥ 400, JSON-RPC error or `isError` tool result), `rate_limited` |
| `blob11` | detail | JSON-RPC error code, `tool_error`, or HTTP status |
| `blob12`, `blob13` | country, colo | from `request.cf` |
| `blob14`, `blob15`, `blob16` | type filter, category filter, target id | only kebab-case values (public catalog slugs/ids); anything else is stored as `invalid` |
| `blob17` | UA class | `human` (mainstream browser User-Agent) or `agent` (everything else: MCP clients, SDKs, curl, crawlers, headless browsers); see `src/ua.js`. Added 2026-10-03; earlier rows are classified from `blob7` at query time |
| `blob18` | traffic | `internal` (our own tests/agents, see [Internal traffic](#internal-traffic)) or `outside`; empty before 2026-10-12 |
| `blob19` | internal rule | `header`, `ua` or `ip` (empty for outside traffic) |
| `double1` | HTTP status | |
| `double2` | latency (ms) | wall time inside the Worker (Workers clocks advance on I/O) |
| `double3` | ASN | from `request.cf.asn` (network, not person) |
| `double4` | result count | search `total` |
| `double5`, `double6` | query length in characters, words | |

**Privacy:** no IP addresses, no search query text, no free-text tool arguments, no cookies or
tokens (the server has none), and for site beacons no referrers, query strings or client identifiers. Clients are identified only by their self-reported name/version and a
truncated User-Agent. Example query (SQL API):
`SELECT blob4 AS tool, blob5 AS client, SUM(_sample_interval) AS requests FROM indexagentica_mcp WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY tool, client ORDER BY requests DESC`.

### Site beacons (`POST /hit`)

Every page of indexagentica.com carries a small inline script (no cookies, no localStorage, no
identifiers, no third-party code). It is skipped when `navigator.webdriver` is set or the browser sends
Do Not Track or Global Privacy Control. It sends, with `navigator.sendBeacon` (as `text/plain`, so no
CORS preflight):

| Event | Body | When |
| --- | --- | --- |
| page view | `{"t":"pageview","p":"/entries/x402/"}` | page load; `p` is the page's canonical path (no query string, no referrer) |
| outbound click | `{"t":"click","p":"/entries/x402/","id":"x402","h":"www.x402.org"}` | click on a listing's website/repo/docs/source link on its entry page |
| download | `{"t":"download","p":"/skills/<id>/","id":"<id>","k":"zip"\|"skill_md"}` | click on a skill zip or raw `SKILL.md` link |

The site posts to the alias `/v1/e` on `mcp.indexagentica.com` and falls back to the same path on
`indexagentica-mcp.indexagentica.workers.dev` if that fails (same Worker, same checks). The Worker accepts
only `Origin: https://indexagentica.com` (`HIT_ORIGINS`), bodies up to 512 bytes,
the three event types with exactly their fields, `p` from the set of pages the site publishes, ids
that exist in the published index, and hosts that the entry actually links to. Anything else gets
`400` and is not stored. `/hit` has its own rate-limit counter (same 120/min per IP). Accepted hits go
to the separate dataset **`indexagentica_hits`** (binding `HITS`), index `hit:<event>`:

| Column | Field |
| --- | --- |
| `blob1` | event: `pageview`, `click`, `download` |
| `blob2` | page path |
| `blob3` | entry or skill id (click, download) |
| `blob4` | destination host (click) |
| `blob5` | download kind: `zip`, `skill_md` |
| `blob6` | UA class (`human` / `agent`) |
| `blob7` | country (from `request.cf`) |
| `blob8` | traffic: `internal` / `outside` (empty before 2026-10-12) |
| `blob9` | internal rule: `header`, `ua`, `ip` |
| `blob10` | probe (event `direct` only): empty for a counted download, `head` or `bot` |
| `double1` | 1 |

### Direct skill downloads (`GET /skills/<id>`)

Agents fetch skills with curl and never run the site's beacon, so the download links published for
agents (llms.txt, llms-full.txt, `/api/longform*.json`, MCP `get_content` links) point at this host:
`https://mcp.indexagentica.com/skills/<id>.zip` and `https://mcp.indexagentica.com/skills/<id>/SKILL.md`.
The Worker ([`src/downloads.js`](src/downloads.js)) checks `<id>` against `^[a-z0-9]+(-[a-z0-9]+)*$`
(max 64) and the published skills in the site's `/api/longform.json` (cached 10 min); anything else is
`404`, and the `Location` is always built from `DATA_BASE_URL`, so it is not an open redirect. It writes
one row to `indexagentica_hits` (event `direct`, index `hit:direct`, same columns; `blob2` is the
request path) and answers `302` with `Cache-Control: no-store`. `HEAD` requests and crawler / link
checker / monitor User-Agents (`BOT_UA_RE`) are stored with `blob10` = `head` / `bot` and reported as
`site.direct_downloads.crawlers_and_probes`, not as downloads. Internal traffic is flagged as usual.
The route has its own rate-limit counter (`dl:`); over the limit the redirect still works but the
request is not recorded. The site's own HTML download buttons keep linking to the static files and
are counted by the click beacon (`site.downloads`); `site.skill_downloads` = clicks + direct.

### Usage stats (`GET /stats`)

Aggregates both datasets through the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
using the secret `CF_ANALYTICS_TOKEN` (Account Analytics Read) and `CF_ACCOUNT_ID`. Counts are
`SUM(_sample_interval)`. Windows: `last_24h`, `last_7d` (rolling) and `all_time`. Because Analytics
Engine keeps 3 months, a daily cron (`30 0 * * *`) stores each completed UTC day's totals in Workers KV
(`STATS_KV`, key `day:YYYY-MM-DD`); `all_time` = stored days + a live query from the first day not yet
stored (`/stats` also catches up missing days lazily). `since.mcp_api` (`STATS_API_SINCE`, first deploy
with request logging) and `since.site_beacon` (`STATS_BEACON_SINCE`, deploy of the beacon) label where
counting starts; nothing earlier is estimated or backfilled. Only the server's own tool names are
published (anything else is `unknown_tool`). The response body is precomputed: a cron every 5 minutes
(`*/5 * * * *`) stores a snapshot in `STATS_KV` (`stats:snapshot:v3`; `generated` is when it was
computed), and requests always get the last snapshot immediately (stale-while-revalidate: once it is
older than 10 minutes, one refresh runs in the background, single-flight per isolate plus a short KV
lock). Each SQL query has a 10 s timeout, a whole recompute a 25 s budget, queries run in parallel.
If the SQL API fails, the last snapshot keeps being served; `503 {"status":"unavailable"}` only when
no snapshot exists yet. `Cache-Control: public, max-age=` the snapshot's remaining freshness
(600 s at most, 60 s at least). Each recompute logs one `stats_compute` line (total and slowest query
times). Without the token the endpoint answers `{"status":"collecting", ...}` with no numbers.

Every window counts **outside traffic only** and adds: `site.downloads.by_skill`,
`site.direct_downloads` (total, zip, skill_md, by_skill, crawlers_and_probes), `site.skill_downloads`
(total = clicks + direct, overall and per skill as `{total, clicks, direct}`),
`site.outbound_clicks_by_entry`, `mcp.top_clients` (self-reported MCP client names, lowercased and
stripped to `[a-z0-9._ -]`, top 10, only names seen ≥ 3 times), `top_user_agent_families` (bot name,
`browser`, `headless-chrome` or first product token; top 10, ≥ 3) and `internal_excluded` (what was left
out, by rule). KV days carry a rollup version (`v`); days from an older version are recomputed while the
raw data is still retained, so rule changes apply retroactively. The lazy catch-up recomputes at most 2
days per `/stats` call and the cron 5 per run (each day is ~7 SQL subrequests; Workers Free allows 50).

### Internal traffic

Our own tests, monitors and agents are logged but excluded from `/stats`. A request or beacon is
internal if any rule matches (`src/internal.js`):

| Rule | Match |
| --- | --- |
| `header` | `X-Indexagentica-Internal: 1` (allowed in CORS; `test/e2e.mjs` sends it on every request) |
| `ua` | User-Agent contains `indexagentica` (our clients use `indexagentica-<agent>/1`) |
| `ip` | client IP inside a CIDR listed in the optional secret `INTERNAL_IPS` (comma-separated, IPv4/IPv6). Unset: our shared box egresses through rotating addresses in a shared relay range, so an IP rule would also drop strangers |

Rows logged before the flag existed (2026-10-12) are matched retroactively in SQL by the signature of
our own sessions (`API_RETRO` / `HITS_RETRO` in `src/stats.js`): API rows whose MCP client name is
`e2e` (our test suite), or from the US with a curl/node/python/headless-Chrome User-Agent inside the
documented launch and verification windows (2026-10-02 20:15–20:45 and 2026-10-03 04:55–05:50 UTC),
and site beacons from the US between 05:00 and 05:50 UTC on 2026-10-03. This is best effort: internal
sessions that looked like outside traffic may still be counted, and outside requests with the same
generic clients inside those windows are excluded.

How our own agents should call the server:

```sh
curl -H 'X-Indexagentica-Internal: 1' -A 'indexagentica-steward/1' https://mcp.indexagentica.com/stats
```

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

JSON config (e.g. Claude Code's `.mcp.json`; Claude Code requires `"type": "http"` for remote servers):

```json
{ "mcpServers": { "indexagentica": { "type": "http", "url": "https://mcp.indexagentica.com/mcp" } } }
```

Other clients use their own name for Streamable HTTP (Cline: `"type": "streamableHttp"`; some accept just `"url"`).

## Configuration (`wrangler.toml` `[vars]`)

| Var | Default | Meaning |
| --- | --- | --- |
| `DATA_BASE_URL` | `https://indexagentica.com` | Where `/api/index.json` is fetched from |
| `CACHE_TTL_SECONDS` | `600` | In-memory / Cache API TTL |
| `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_PERIOD_SECONDS` | `120`, `60` | Documented limit + fallback bucket (keep in sync with `[ratelimits.simple]`) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated Origin allow-list for browser callers |
| `PUBLIC_BASE_URL` | request origin | Canonical base for links in `GET /` |
| `CF_ACCOUNT_ID` | (none) | Account for the Analytics Engine SQL API (`/stats`) |
| `STATS_API_SINCE`, `STATS_BEACON_SINCE` | `2026-10-02T20:21:47Z`, (deploy time) | Where MCP/REST and site-beacon counting start (shown as `since` in `/stats`) |
| `INTERNAL_IPS` (secret, optional) | (none) | Comma-separated CIDRs whose requests count as internal traffic |
| `HIT_ORIGINS` | `https://indexagentica.com,https://www.indexagentica.com` | Origins allowed to `POST /hit` |

Secret: `CF_ANALYTICS_TOKEN` (Account Analytics Read), set with `wrangler secret put CF_ANALYTICS_TOKEN`.
Bindings: `ANALYTICS` and `HITS` (Analytics Engine), `STATS_KV` (KV), `RATE_LIMITER`; crons `30 0 * * *` (daily rollup) and `*/5 * * * *` (/stats snapshot).

## Deploy

To run your own copy, follow **[SELF_HOSTING.md](SELF_HOSTING.md)**. **[DEPLOY.md](DEPLOY.md)** contains our own deployment notes for `mcp.indexagentica.com` (the options and the
exact Cloudflare/GoDaddy access needed). Short version, for our deployment:

```bash
export CLOUDFLARE_ACCOUNT_ID=...   # from the Cloudflare dashboard
export CLOUDFLARE_API_TOKEN=...    # custom token, permissions in DEPLOY.md
npm run deploy:dry                 # build only
npm run deploy                     # -> https://mcp.indexagentica.com (custom domain)
                                   #    + https://indexagentica-mcp.indexagentica.workers.dev
BASE=https://mcp.indexagentica.com npm run test:e2e
```

## Listing requests

Agents ask for missing listings via the `request_listing` tool or `POST /v1/requests` (shared code: `src/requests.js`).
Storage: Cloudflare D1 database `indexagentica-requests` (binding `REQUESTS_DB`, schema in `migrations/`; apply with
`CI=1 npx wrangler d1 migrations apply indexagentica-requests --remote`).

- **Validation**: `wanted` ≤120 chars, `reason` ≤500, `requester` ≤60, `url` ≤300 and http(s) only (no credentials, no whitespace);
  control and bidi-override characters rejected; unknown fields rejected; body ≤4 KiB; `category` must be a current category slug or `other`.
- **Dedupe**: same `category` and same normalized `wanted` (lowercased, accents and punctuation stripped, whitespace collapsed,
  filler words such as mcp/server/the/tool/skill/api dropped), or same URL host+path (any category) → merged into the existing request.
  A merge adds one vote, at most one per client (IP hash, IPv6 by /64). Up to 10 reasons and requester names are kept (admin view only).
- **Rate limit**: 5 per hour and 20 per day per client (keyed HMAC of IP (IPv6 by /48) + User-Agent), plus 20 per day per IP hash; `429` with `Retry-After`.
  On top of the global 120/min limit. Submission rows are pruned after 2 days.
- **Privacy**: raw IPs are never stored, only HMAC-SHA256 (truncated) with the secret `REQUESTS_IP_SALT`.
- **Statuses**: `pending` → `verified` → `listed` (with `entry_id`), or `rejected`. Public output (`GET /v1/requests`) hides rejected items,
  omits reasons/requesters, and includes `url` only for verified/listed items. Requests from our own agents are flagged `internal` (admin view).
- **Curator**: admin routes need `Authorization: Bearer <REQUESTS_ADMIN_TOKEN>` (secret; local copy only on the shared box, never committed).
  The site repo has `scripts/requests-review.mjs` (list / verify / listed / reject / delete) and the workflow in `content/README.md`.
  Nothing is listed without verification.

## Layout

```
src/index.js      router, CORS, JSON errors, REST endpoints, rate-limit gate
src/mcp.js        stateless dual-era MCP JSON-RPC handler
src/tools.js      tool definitions (schemas) + implementations shared with REST
src/search.js     scoring / filtering
src/data.js       fetch + cache of /api/index.json
src/ratelimit.js  Workers rate limiting binding + in-isolate fallback
src/openapi.js    OpenAPI document for the REST API
src/analytics.js  per-request usage logging to Workers Analytics Engine (no-op without the binding)
src/ua.js         human (browser) vs agent User-Agent classification
src/hits.js       POST /hit: site beacon validation + logging (dataset indexagentica_hits)
src/downloads.js  GET/HEAD /skills/<id>.zip|SKILL.md: direct download count + 302 to the site
src/stats.js      GET /stats: Analytics Engine SQL aggregation, KV daily rollup + snapshot (crons), stale-while-revalidate
src/internal.js   internal-traffic rules (header, UA, optional IP ranges)
src/requests.js   listing requests: validation, dedupe, votes, rate limits, D1 queue, admin
migrations/       D1 schema for indexagentica-requests
test/             unit tests, E2E script, Inspector config
docs/             proposed copy for llms.txt, /agents and the directory listing
```

License: code MIT; directory content CC BY 4.0.

## Registry metadata

- [`server.json`](server.json): official MCP Registry entry (`com.indexagentica/mcp`, schema 2025-12-11), validated with
  `mcp-publisher validate`. Publishing uses HTTP domain auth against
  `https://indexagentica.com/.well-known/mcp-registry-auth`; it's a separate, manual step once the endpoint is live.
- [`glama.json`](glama.json): Glama ownership claim (maintainer `Drudley`).
- [`llms-install.md`](llms-install.md): install notes for agent-driven installers such as Cline.

## License

[MIT](LICENSE) for the code. Directory content served by the tools is CC BY 4.0.
