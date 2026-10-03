// User-Agent classification for usage stats: "human" when the request comes from a
// mainstream web browser, "agent" for everything else (MCP clients, SDKs, curl,
// crawlers, headless browsers). Deliberately simple and documented in the README;
// it is a heuristic on a self-reported header, not identity.

const BROWSER_RE = /^Mozilla\/5\.0 \(/;
const ENGINE_RE = /(?:Chrome|CriOS|Firefox|FxiOS|Safari|Edg|EdgA|EdgiOS|OPR|SamsungBrowser)\/\d/;
// Automation, crawlers, HTTP libraries and AI fetchers that also send a Mozilla-style UA.
const NON_HUMAN_RE =
  /bot\b|bot\/|crawl|spider|slurp|headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|preview|python|curl|wget|httpie|go-http|java\/|okhttp|axios|node-fetch|undici|\bnode\b|deno|\bbun\/|libwww|scrapy|claude|anthropic|openai|chatgpt|gptbot|perplexity|\bmcp\b/i;

/** @returns {"human"|"agent"} */
export function uaClass(ua) {
  const s = typeof ua === "string" ? ua : "";
  if (BROWSER_RE.test(s) && ENGINE_RE.test(s) && !NON_HUMAN_RE.test(s)) return "human";
  return "agent";
}
