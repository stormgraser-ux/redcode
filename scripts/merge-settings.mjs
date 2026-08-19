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

const added = [];
for (const [key, value] of Object.entries(defaults)) {
  if (current[key] === undefined) {
    current[key] = value;
    added.push(key);
  }
}

writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
console.log(
  added.length
    ? `  settings: added ${added.join(", ")}`
    : "  settings: already set, nothing changed",
);
