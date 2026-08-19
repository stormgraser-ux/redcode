// test.mjs — run every extension's unit tests.
//
// There is no test framework here on purpose. Each test file is a plain script
// that counts assertions and exits non-zero on failure, so it runs under bare
// `node --experimental-strip-types` with nothing installed. Adding vitest would
// mean a node_modules tree, a config file, and a version to keep current, for
// tests that are a few hundred lines of arithmetic and string handling.
//
//   node scripts/test.mjs           run everything
//   node scripts/test.mjs scroll    run files whose path contains "scroll"

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const filter = process.argv[2];

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findTests(full));
    } else if (/(^|\.)test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const tests = findTests(join(repo, "extensions"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (tests.length === 0) {
  console.error(filter ? `no test files match "${filter}"` : "no test files found");
  process.exit(1);
}

let failed = 0;
for (const file of tests) {
  const name = relative(repo, file);
  // cwd is the test's own directory: several of them write and read scratch
  // files relative to themselves, and running from the repo root would scatter
  // those across the working tree.
  const result = spawnSync(process.execPath, ["--experimental-strip-types", file], {
    cwd: dirname(file),
    stdio: "pipe",
    encoding: "utf8",
  });
  const ok = result.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  // Only show output for failures. A green run should be one line per file, or
  // nobody reads it.
  if (!ok) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    if (output) console.log(output.replace(/^/gm, "      "));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed === 0 ? 0 : 1);
