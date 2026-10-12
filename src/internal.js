// Internal-traffic rules: requests from our own tests, builds and agents are flagged "internal"
// at request time and excluded from the public /stats numbers (they are still logged, so the
// exclusion is auditable as internal_excluded). The flag never identifies a person.
//
//   header  X-Indexagentica-Internal: 1  (our E2E suite and agents send it)
//   ua      User-Agent containing "indexagentica" (e.g. indexagentica-e2e/1, indexagentica-steward/1)
//   ip      client IP inside INTERNAL_IPS (secret; comma-separated IPs/CIDRs, v4 or v6). Matched in
//           memory only; IPs are never stored. Unset by default: the shared box egresses through
//           rotating relay addresses that real users share, so an IP rule would misclassify them.
//
// Anyone can set the header or UA; the only effect is that their own traffic is not counted.
import { clientKey } from "./ratelimit.js";

export const INTERNAL_HEADER = "x-indexagentica-internal";
const UA_RE = /indexagentica/i;

function parseIp(s) {
  s = String(s || "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: p.reduce((a, x) => (a << 8n) + BigInt(x), 0n), bits: 32 };
  }
  if (s.includes(":")) {
    let [head, tail] = s.split("::");
    if (s.split("::").length > 2) return null;
    const h = head ? head.split(":") : [];
    const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
    const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n), bits: 128 };
  }
  return null;
}

/** true if ip is inside cidr ("1.2.3.0/24", "2001:db8::/32" or a bare address). */
export function ipInCidr(ip, cidr) {
  const [base, lenStr] = String(cidr).trim().split("/");
  const a = parseIp(ip), b = parseIp(base);
  if (!a || !b || a.v !== b.v) return false;
  const len = lenStr === undefined ? b.bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > b.bits) return false;
  const shift = BigInt(b.bits - len);
  return a.n >> shift === b.n >> shift;
}

/** @returns {"header"|"ua"|"ip"|""} the first matching rule, or "" for outside traffic */
export function internalRule(request, env = {}) {
  const h = request.headers.get(INTERNAL_HEADER);
  if (h && h.trim() && h.trim() !== "0") return "header";
  if (UA_RE.test(request.headers.get("user-agent") || "")) return "ua";
  const list = String(env.INTERNAL_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) {
    const ip = clientKey(request);
    if (list.some((c) => ipInCidr(ip, c))) return "ip";
  }
  return "";
}
