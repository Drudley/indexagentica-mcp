# Deploying indexagentica-mcp (target: `mcp.indexagentica.com`)

Researched 2026-10-02. Current DNS for `indexagentica.com` (checked via DoH):

| Name | Type | Value |
| --- | --- | --- |
| `indexagentica.com` | NS | `ns57.domaincontrol.com`, `ns58.domaincontrol.com` (GoDaddy) |
| `indexagentica.com` | A | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (GitHub Pages) |
| `indexagentica.com` | AAAA | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
| `www` | CNAME | `drudley.github.io` |
| `_github-pages-challenge-drudley` | TXT | `f37dbf0d08310c41e1e74f686b6588` |
| `_domainconnect` | CNAME | `_domainconnect.gd.domaincontrol.com` (GoDaddy-only helper) |
| (none) | MX / DS | no mail records, DNSSEC is **off** |

## The key constraint

A Worker can only be served on your own hostname through a **Custom Domain** or a
**Route**, and both require "an active Cloudflare zone" for that hostname
([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
A plain `CNAME mcp -> indexagentica-mcp.<sub>.workers.dev` at GoDaddy does **not**
work: Cloudflare does not serve a Worker for a hostname that isn't in one of your
zones (the only exception is Cloudflare for SaaS custom hostnames, option e).
The ways to get a zone without moving the apex are not on the Free plan:

* **CNAME (partial) setup**, which keeps GoDaddy as authoritative DNS: Business or
  Enterprise only ([docs](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)).
* **Subdomain setup**, which delegates only `mcp.indexagentica.com` to Cloudflare
  with NS records at GoDaddy: Enterprise only
  ([docs](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/)).
  A primary (full) setup "is the only one available for Free or Pro plans"
  ([full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)).

## Options

### (a) Move `indexagentica.com` nameservers to Cloudflare Free, then use a Workers Custom Domain (recommended end state)

* **Cost:** $0. The domain stays registered at GoDaddy; only the nameservers change.
* **Pros:** real `https://mcp.indexagentica.com/mcp`; the cert and DNS record are
  created automatically by `wrangler deploy`; the Cache API works (shared cache
  across isolates); future subdomains are easy.
* **Cons / risks:** DNS for the whole domain moves to Cloudflare (about 10
  records, no email, so low risk). The GitHub Pages records must be recreated
  exactly, and should stay **DNS only (grey cloud)** so GitHub keeps issuing
  and renewing its Let's Encrypt cert and "Enforce HTTPS" keeps working. There's a
  short propagation window, but the records are identical, so the site shouldn't
  go down.
* **Steps (Niklas, in the dashboard):**
  1. Create a free Cloudflare account, then **Add a domain** → `indexagentica.com` → Free plan.
  2. Check the scanned records so they match exactly this (all **DNS only**):
     * `A @ 185.199.108.153`, `A @ 185.199.109.153`, `A @ 185.199.110.153`, `A @ 185.199.111.153`
     * `AAAA @ 2606:50c0:8000::153`, `…8001::153`, `…8002::153`, `…8003::153`
     * `CNAME www drudley.github.io`
     * `TXT _github-pages-challenge-drudley "f37dbf0d08310c41e1e74f686b6588"`
     * Skip `_domainconnect` (GoDaddy-specific). Don't create an `mcp` record, because the Worker Custom Domain creates it.
  3. **At GoDaddy:** replace nameservers `ns57.domaincontrol.com` / `ns58.domaincontrol.com`
     with the two `*.ns.cloudflare.com` names Cloudflare assigns
     ([GoDaddy: change nameservers](https://www.godaddy.com/help/edit-my-domain-nameservers-664)).
     DNSSEC is already off (no DS record), so there's nothing to disable first.
  4. Wait for the zone to show **Active**, then deploy (below).
* **Deploy:** uncomment in `wrangler.toml`
  ```toml
  routes = [ { pattern = "mcp.indexagentica.com", custom_domain = true } ]
  ```
  and set `PUBLIC_BASE_URL = "https://mcp.indexagentica.com"`, then `npm run deploy`.
* **DNS records to add at GoDaddy:** none. Only the nameserver change.

### (b) Subdomain-only zone (`mcp.indexagentica.com` delegated to Cloudflare), or a CNAME/partial setup

Not possible on Free: subdomain setup is Enterprise only, and partial setup is Business ($200+/mo)
or Enterprise (links above). Not recommended.

### (c) `indexagentica-mcp.<account-subdomain>.workers.dev` for now (works immediately, no DNS)

* **Cost:** $0. **Pros:** no DNS changes, deployable as soon as an account and token exist;
  the same deployment keeps working after (a).
* **Cons:** not on our domain, and the URL in docs would change later. The Cache API is a
  no-op on workers.dev (the in-memory cache still works). Cloudflare positions
  workers.dev for hobby/non-critical use ([docs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).
* **One-time:** the account must have a workers.dev subdomain. Pick one under
  **Workers & Pages** in the dashboard (for example `indexagentica`, giving
  `https://indexagentica-mcp.indexagentica.workers.dev/mcp`).
* **Deploy:** `npm run deploy` as-is (`workers_dev = true`).

### (d) Another free host that accepts a CNAME from external DNS: Deno Deploy

* **Free tier:** 1M requests/month, 5 custom domains, automatic Let's Encrypt
  ([pricing](https://deno.com/deploy/pricing), [custom domains](https://docs.deno.com/deploy/reference/domains/)).
* **DNS at GoDaddy:** the "CNAME method" uses two CNAMEs that the Deno dashboard shows
  (one for `mcp` to the Deno target, one for `_acme-challenge.mcp` for verification/certs).
  Exact values come from the dashboard when the domain is added.
* **Code:** the Worker uses only standard `fetch`/`Request`/`Response`, so it needs a
  ~10-line `Deno.serve` adapter. Rate limiting falls back to the per-isolate bucket,
  since there's no Cloudflare binding.
* **Access needed:** a Deno Deploy account/org (Niklas signs up), plus an org access
  token or the GitHub app link for deploys.
* **Cons:** another vendor and account. Free-tier limits are monthly, versus Cloudflare's 100k/day.
  Vercel/Netlify work similarly via CNAME, but Vercel Hobby is non-commercial-only.

### (e) Cloudflare for SaaS custom hostname (keeps GoDaddy DNS, but needs another zone)

The Free plan includes 100 custom hostnames
([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)), and a Worker can be
the fallback origin ([docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
But this needs a **separate domain already on Cloudflare** as the "SaaS zone" (buying
one is a purchase). Then GoDaddy gets `CNAME mcp -> <fallback host in that zone>` plus the
ownership and certificate validation TXT records Cloudflare shows. It works, but it's more
complex than (a) and costs a second domain, so it's not recommended.

## Recommendation

1. **Now:** Niklas creates a free Cloudflare account and an API token (below). We deploy
   to **workers.dev (c)** right away and run `BASE=<url> npm run test:e2e` against it.
2. **Then:** move the nameservers **(a)** with the exact record list above, uncomment the
   custom domain, and redeploy. `https://mcp.indexagentica.com/mcp` becomes the documented URL.
   Same Worker, same code, $0.

## Exact access list

**From Niklas (Cloudflare):**

1. A Cloudflare account (free), and the **Account ID** (dashboard → Account home → ⋯ →
   Copy account ID; [docs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)).
2. A workers.dev subdomain chosen once under Workers & Pages (needed for option c).
3. A **custom API token** ([create token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
   [permission names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)), scoped
   to that one account and (for a) only zone `indexagentica.com`:

   | Scope | Permission | Needed for |
   | --- | --- | --- |
   | Account | **Workers Scripts : Edit** | deploying the Worker; the Custom Domains API accepts this permission |
   | Account | **Account Settings : Read** | wrangler account lookups |
   | User | **User Details : Read** | wrangler (`whoami`) |
   | User | **Memberships : Read** | wrangler account resolution |
   | Account | Workers Tail : Read *(optional)* | `wrangler tail` live logs |
   | Zone (indexagentica.com) | **Workers Routes : Edit** | attaching the Custom Domain / routes (option a) |
   | Zone (indexagentica.com) | **Zone : Read** | wrangler resolving the zone for `custom_domain = true` (option a) |
   | Zone (indexagentica.com) | DNS : Edit *(optional)* | only if an agent should manage the zone's DNS records via API (for example recreating the GitHub Pages records or adding future TXT records). Not needed for the Worker itself |

   The dashboard template **"Edit Cloudflare Workers"** covers all of this (plus KV/R2/Pages
   edit, which we don't need). The custom token above is the least-privilege version.
   Provide it as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (env vars, or as GitHub Actions
   secrets if we later deploy from CI; [external CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)).

**From Niklas (GoDaddy), option a only:** change the nameservers to the two Cloudflare-assigned
`*.ns.cloudflare.com` names. No other GoDaddy records needed.

**Option c:** no DNS changes at all. **Option d:** the two CNAMEs Deno shows, added at GoDaddy.
