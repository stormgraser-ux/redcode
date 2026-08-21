// Run:  node --experimental-strip-types extensions/redcode-edit-recover/test.ts
//       (also discovered and run by `npm test`)
//
// The failure messages are NOT hand-written here. Every one is produced by
// driving pi's own edit tool against a real temp file, because the classifier
// matches on pi's prose and a fixture written from memory would keep passing
// after an upstream reword — which is exactly how it would fail silently.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// This file is run directly by node, not resolved through pi's own module
// graph, so the bare specifier that works inside index.ts does not resolve
// here. Point at the copy in the repo's node_modules, the same way the other
// tests that need pi's own code do.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createEditToolDefinition } = await import(
  resolve(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
import { classify, findCandidates, occurrenceLines, report, skeleton, whitespaceOnlyDifference } from "./recover.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const dir = mkdtempSync(join(tmpdir(), "edit-recover-"));
const edit = createEditToolDefinition(dir);

/** Run pi's real edit tool and return the error message it raises, or null. */
async function editError(file: string, edits: Array<{ oldText: string; newText: string }>): Promise<string | null> {
  try {
    await edit.execute("t", { path: file, edits }, undefined as any, undefined as any, undefined as any);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const SRC = [
  "function alpha() {",
  "    const x = 1;",
  "    return x;",
  "}",
  "",
  "function beta() {",
  "    const x = 1;",
  "    return x;",
  "}",
  "",
  "const done = true;",
].join("\n");

console.log("pure logic");
check("skeleton flattens interior whitespace", skeleton("  const   x =  1;  ") === "const x = 1;");
check("whitespace-only difference detected", whitespaceOnlyDifference("  a\n b", "a\nb"));
check("differing content is not whitespace-only", !whitespaceOnlyDifference("a\nb", "a\nc"));
check("occurrenceLines finds both copies", JSON.stringify(occurrenceLines(SRC, "    const x = 1;")) === "[2,7]");

// Indentation-blind anchoring: the axis pi's own fuzzy match does not cover.
const cands = findCandidates(SRC, "function alpha() {\nconst x = 1;\nreturn x;\n}");
check("findCandidates anchors despite lost indentation", cands.length > 0 && cands[0].startLine === 1,
  JSON.stringify(cands.slice(0, 1)));
check("findCandidates reports a multi-line run", cands.length > 0 && cands[0].matchedLines === 4,
  cands.length ? String(cands[0].matchedLines) : "none");
check("findCandidates returns nothing for absent text", findCandidates(SRC, "totally unrelated line").length === 0);

console.log("classification against pi's real errors");
const f = join(dir, "sample.ts");

writeFileSync(f, SRC);
const notFound = await editError("sample.ts", [{ oldText: "function gamma() {\n    return 9;\n}", newText: "x" }]);
check("not-found actually raised", notFound !== null, String(notFound));
check("not-found classified", notFound !== null && classify(notFound).kind === "not-found", String(notFound));

writeFileSync(f, SRC);
const dupe = await editError("sample.ts", [{ oldText: "    const x = 1;", newText: "    const x = 2;" }]);
check("duplicate actually raised", dupe !== null, String(dupe));
check("duplicate classified", dupe !== null && classify(dupe).kind === "duplicate", String(dupe));

writeFileSync(f, SRC);
const noChange = await editError("sample.ts", [{ oldText: "const done = true;", newText: "const done = true;" }]);
check("no-change actually raised", noChange !== null, String(noChange));
check("no-change classified", noChange !== null && classify(noChange).kind === "no-change", String(noChange));

writeFileSync(f, SRC);
const overlap = await editError("sample.ts", [
  { oldText: "function alpha() {\n    const x = 1;", newText: "a" },
  { oldText: "    const x = 1;\n    return x;\n}\n\nfunction beta", newText: "b" },
]);
check("overlap raised and left alone", overlap !== null && ["overlap", "duplicate"].includes(classify(overlap).kind),
  String(overlap));

console.log("reports carry real bytes");
writeFileSync(f, SRC);
const content = readFileSync(f, "utf-8");

// The headline case: right content, wrong indentation.
const wrongIndent = "function alpha() {\nconst x = 1;\nreturn x;\n}";
const missMsg = (await editError("sample.ts", [{ oldText: wrongIndent, newText: "x" }]))!;
const r1 = report(classify(missMsg), { path: "sample.ts", edits: [{ oldText: wrongIndent }] }, content, missMsg);
check("not-found report produced", r1 !== null);
check("report quotes the file's real indented bytes", !!r1 && r1.includes("    const x = 1;"), r1 ?? "");
check("report gives a line number to copy from", !!r1 && /line 1\b/.test(r1), r1 ?? "");
check("report keeps pi's original message", !!r1 && r1.startsWith(missMsg));

const dupMsg = (await editError("sample.ts", [{ oldText: "    const x = 1;", newText: "    const x = 2;" }]))!;
const r2 = report(classify(dupMsg), { path: "sample.ts", edits: [{ oldText: "    const x = 1;" }] }, content, dupMsg);
check("duplicate report produced", r2 !== null);
check("duplicate report names both line numbers", !!r2 && r2.includes("2, 7"), r2 ?? "");
check("duplicate report shows disambiguating context", !!r2 && r2.includes("function beta"), r2 ?? "");

// Absent-everywhere must not fabricate a location.
const goneMsg = (await editError("sample.ts", [{ oldText: "zzz nowhere zzz", newText: "x" }]))!;
const r3 = report(classify(goneMsg), { path: "sample.ts", edits: [{ oldText: "zzz nowhere zzz" }] }, content, goneMsg);
check("absent text advises a re-read without inventing a region", !!r3 && r3.includes("Re-read the file"), r3 ?? "");

// Unreadable file must be a no-op, not a crash.
check("null content is a no-op", report({ kind: "not-found", editIndex: 0 }, { path: "x", edits: [{ oldText: "a" }] }, null, "m") === null);
check("unclassified failure is a no-op",
  report({ kind: "other" }, { path: "x", edits: [{ oldText: "a" }] }, content, "m") === null);

// Output must stay bounded on a hostile file.
const huge = Array.from({ length: 20000 }, () => "    const x = 1;").join("\n");
const rBig = report({ kind: "duplicate", editIndex: 0, occurrences: 20000 },
  { path: "x", edits: [{ oldText: "    const x = 1;" }] }, huge, "m");
check("report stays bounded on a pathological file", !!rBig && rBig.length < 4000, String(rBig?.length));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
