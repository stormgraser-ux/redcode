// merge-settings — fill in redcode's defaults without clobbering pi's settings.
//
// settings.json holds the user's provider choice, their model, and any API keys
// for other providers. Replacing it to set a theme would be an absurd trade, so
// this only writes keys that are ABSENT. An existing value is a deliberate
// choice and stays.
//
//   node scripts/merge-settings.mjs <settings.json> <defaults.json>

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [target, defaultsPath] = process.argv.slice(2);
if (!target || !defaultsPath) {
  console.error("usage: merge-settings.mjs <settings.json> <defaults.json>");
  process.exit(2);
}

const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));

let current = {};
if (existsSync(target)) {
  try {
    current = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    // Unparsable settings: keep a copy rather than silently discarding whatever
    // the user meant to have in there.
    const saved = `${target}.broken-${process.pid}`;
    copyFileSync(target, saved);
    console.log(`  existing settings.json did not parse — saved as ${saved}`);
  }
  copyFileSync(target, `${target}.pre-redcode`);
}

// Absent means absent at any depth. A shallow pass would skip
// `retry.provider.maxRetries` for anyone who already has a `retry` block, and
// that key is the one that matters most: pi's provider retry layer is the
// OpenAI SDK's own silent default of 2, which re-queues whole payloads behind
// a single-slot engine's admission and turns one slow turn into three.
// Existing values still win — this only fills holes.
const added = [];
function fill(target, source, prefix) {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (target[key] === undefined) {
      target[key] = value;
      added.push(path);
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      fill(target[key], value, path);
    }
  }
}
fill(current, defaults, "");

writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
// Name the file being merged: this runs once per target now, and two
// consecutive lines both saying "settings" is a puzzle rather than a report.
const label = target.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
console.log(
  added.length
    ? `  ${label}: added ${added.join(", ")}`
    : `  ${label}: already set, nothing changed`,
);
