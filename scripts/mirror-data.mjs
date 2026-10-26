#!/usr/bin/env node
// Mirror the files the Worker reads from DATA_BASE_URL into a local directory, so a
// self-hosted copy can serve its own copy of the CC BY 4.0 data (see SELF_HOSTING.md).
// Zero dependencies (Node 18+).
//
//   node scripts/mirror-data.mjs [--from https://indexagentica.com] [--out ./mirror] [--no-skills]
//
// Fetched (exactly what src/data.js and src/downloads.js use):
//   api/index.json                               directory entries + categories (required)
//   api/longform.json                            long-form index (optional for the Worker)
//   api/longform/<guides|compare|stacks|skills>/<id>.json   one per long-form item (get_content)
//   skills/<id>.zip, skills/<id>/SKILL.md        redirect targets of /skills/... (skip with --no-skills)
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const FROM = opt("--from", "https://indexagentica.com").replace(/\/+$/, "");
const OUT = path.resolve(opt("--out", "mirror"));
const SKILLS = !args.includes("--no-skills");
const ROUTES = { guide: "guides", comparison: "compare", stack: "stacks", skill: "skills" }; // = ROUTES in src/data.js
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function get(rel, { optional = false } = {}) {
  const url = `${FROM}/${rel}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "indexagentica-mirror/1" } });
      if (res.status === 404 && optional) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(OUT, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return buf;
    } catch (err) {
      if (attempt === 3) { if (optional) { console.warn(`skip ${url}: ${err.message}`); return null; } throw new Error(`${url}: ${err.message}`); }
    }
  }
}

const index = JSON.parse(await get("api/index.json"));
const lfBuf = await get("api/longform.json", { optional: true });
const items = lfBuf ? (JSON.parse(lfBuf).items || []).filter((x) => x && ROUTES[x.type] && ID_RE.test(String(x.id))) : [];
let files = lfBuf ? 2 : 1;
for (const x of items) {
  if (await get(`api/longform/${ROUTES[x.type]}/${x.id}.json`, { optional: true })) files++;
  if (SKILLS && x.type === "skill") {
    if (await get(`skills/${x.id}.zip`, { optional: true })) files++;
    if (await get(`skills/${x.id}/SKILL.md`, { optional: true })) files++;
  }
}
fs.writeFileSync(path.join(OUT, "ATTRIBUTION.txt"),
  `Mirrored from ${FROM} on ${new Date().toISOString()}.\nData: Index Agentica (https://indexagentica.com), licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).\n`);
console.log(`Mirrored ${files} files (${(index.entries || []).length} entries, ${items.length} long-form items) from ${FROM} into ${OUT}`);
