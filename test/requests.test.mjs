import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWanted, urlKey, publicRow, ipPrefix } from "../src/requests.js";

test("normalizeWanted merges trivial variants", () => {
  assert.equal(normalizeWanted("The Linear MCP Server!"), "linear");
  assert.equal(normalizeWanted("linear   mcp"), "linear");
  assert.equal(normalizeWanted("MCP"), "mcp");
});
test("urlKey: host+path, no www, no trailing slash/.git", () => {
  assert.equal(urlKey("https://www.GitHub.com/Foo/Bar.git/"), "github.com/foo/bar");
  assert.equal(urlKey("http://github.com/foo/bar?x=1#y"), "github.com/foo/bar");
});
test("publicRow hides url unless verified/listed", () => {
  const r = { id: 1, wanted: "x", category: "tools", votes: 2, status: "pending", url: "https://evil.example/", first_seen: "a", last_seen: "b", reasons: "[]", requesters: "[]" };
  assert.equal(publicRow(r).url, undefined);
  assert.equal(publicRow(r).reasons, undefined);
  assert.equal(publicRow({ ...r, status: "verified" }).url, "https://evil.example/");
});
test("ipPrefix: v4 whole, v6 by prefix", () => {
  assert.equal(ipPrefix("1.2.3.4", 64), "1.2.3.4");
  assert.equal(ipPrefix("2a04:4e41:80:c95f::5650:c95f", 64), "2a04:4e41:80:c95f::/64");
  assert.equal(ipPrefix("2a04:4e41:80:e36b::8441:e36b", 48), "2a04:4e41:80::/48");
  assert.equal(ipPrefix("2001:db8::1", 64), "2001:db8:0:0::/64");
});
