#!/usr/bin/env bash
# Full local test: unit tests, two `wrangler dev` instances (normal + low
# rate-limit env), E2E tests, and MCP Inspector CLI checks in both eras.
# DATA_BASE_URL=http://127.0.0.1:8080 points the Workers at another copy of the
# site (e.g. a local build with long-form drafts published) instead of the live one.
set -euo pipefail
cd "$(dirname "$0")/.."
P1=${P1:-8797}; P2=${P2:-8798}
LOG1=$(mktemp); LOG2=$(mktemp)
for p in "$P1" "$P2"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is already in use; set P1/P2" >&2; exit 1; fi
done
# Each wrangler runs in its own process group so workerd children die too.
cleanup() { for g in "${PID1:-}" "${PID2:-}"; do [ -n "$g" ] && kill -- "-$g" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "== unit tests"; node --test test/unit.test.mjs

wait_ready() { for _ in $(seq 1 60); do grep -q "Ready on" "$1" && return 0; sleep 1; done; return 1; }
# Start sequentially with distinct inspector ports (parallel starts race on internal ports).
VARS=(); [ -n "${DATA_BASE_URL:-}" ] && VARS=(--var "DATA_BASE_URL:$DATA_BASE_URL")
setsid npx wrangler dev "${VARS[@]}" --port "$P1" --ip 127.0.0.1 --inspector-port $((P1+10000)) --show-interactive-dev-session=false >"$LOG1" 2>&1 & PID1=$!
wait_ready "$LOG1" || true
setsid npx wrangler dev "${VARS[@]}" --env ratelimit-test --port "$P2" --ip 127.0.0.1 --inspector-port $((P2+10000)) --show-interactive-dev-session=false >"$LOG2" 2>&1 & PID2=$!
wait_ready "$LOG2" || true
grep -q "Ready on" "$LOG1" || { cat "$LOG1"; exit 1; }
grep -q "Ready on" "$LOG2" || { cat "$LOG2"; exit 1; }

echo "== e2e"; BASE="http://127.0.0.1:$P1" RL_BASE="http://127.0.0.1:$P2" node test/e2e.mjs

if [ "${SKIP_INSPECTOR:-0}" != "1" ]; then
  echo "== MCP Inspector CLI (legacy era, default)"
  I="npx --no-install mcp-inspector --cli http://127.0.0.1:$P1/mcp --transport http"
  $I --method tools/list >/dev/null && echo "  ok   tools/list"
  $I --method tools/call --tool-name search --tool-args-json '{"query":"browser","limit":2}' >/dev/null && echo "  ok   tools/call search"
  $I --method tools/call --tool-name get_entry --tool-arg id=model-context-protocol >/dev/null && echo "  ok   tools/call get_entry"
  $I --method tools/call --tool-name list_categories >/dev/null && echo "  ok   tools/call list_categories"
  $I --method tools/call --tool-name search --tool-args-json '{"query":"mcp","type":"guide"}' >/dev/null && echo "  ok   tools/call search type=guide"
  echo "== MCP Inspector CLI (modern era, 2026-07-28)"
  CFG=$(mktemp --suffix .json)
  printf '{"mcpServers":{"m":{"type":"streamable-http","url":"http://127.0.0.1:%s/mcp","protocolEra":"modern"}}}' "$P1" >"$CFG"
  M="npx --no-install mcp-inspector --cli --config $CFG --server m"
  $M --method initialize 2>/dev/null | grep -q '"protocolVersion": "2026-07-28"' && echo "  ok   negotiated 2026-07-28"
  $M --method tools/call --tool-name search --tool-args-json '{"query":"x402"}' >/dev/null 2>&1 && echo "  ok   tools/call search"
  rm -f "$CFG"
fi
echo "== all local tests passed"
