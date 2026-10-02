# Security Policy

## Supported versions

Only the currently deployed version of the server (https://mcp.indexagentica.com/mcp, built from the `main` branch) is supported. Fixes are deployed from `main`.

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/Drudley/indexagentica-mcp/security/advisories/new).

Please do not open a public issue for security problems. Include the affected endpoint or tool, steps to reproduce, and the impact you observed. We aim to acknowledge reports within 3 business days and to ship a fix or mitigation as soon as practical, and we'll credit you in the advisory unless you prefer otherwise.

## Scope

The server is read-only and unauthenticated: it serves public data from https://indexagentica.com and stores no user data or credentials. Usage logs (Cloudflare Workers Analytics Engine) record request metadata such as route, tool name, client name/version, user agent, country and network (ASN), and query length. They do not record IP addresses or query text. Relevant reports include anything that lets a request change data, reach resources other than the public index, bypass the rate limit at scale, or inject content into tool results that misrepresents the index.
