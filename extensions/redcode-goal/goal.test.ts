// Marker-detection tests. The failure that matters is a FALSE COMPLETE: the
// model merely discussing the protocol, or printing an example, must not end
// the run. Run:
//   ~/.local/share/pi-node/current/bin/node --experimental-strip-types test.ts
import { findMarker } from "./index.ts";

const cases: [expected: string, name: string, text: string][] = [
  ["complete", "plain marker", "Done.\nGOAL_COMPLETE: tests pass, 42/42 green"],
  ["blocked", "blocked marker", "GOAL_BLOCKED: the API key is missing"],
  ["null", "no marker", "I ran the tests and 3 are still failing. Continuing."],

  ["null", "inside a fenced block", [
    "Here is how the protocol works:", "```", "GOAL_COMPLETE: example only", "```", "Continuing work.",
  ].join("\n")],

  ["null", "inside a tilde fence", ["~~~", "GOAL_COMPLETE: nope", "~~~"].join("\n")],

  ["null", "indented code block", "Example:\n\n    GOAL_COMPLETE: indented example\n\nStill working."],

  ["null", "discussed mid-sentence", "When finished I will write GOAL_COMPLETE: at the end."],

  ["complete", "after a closed fence", [
    "```", "npm test", "```", "All green.", "GOAL_COMPLETE: 42/42 passing",
  ].join("\n")],

  ["null", "fenced with language tag", ["```bash", "echo GOAL_COMPLETE: fake", "```"].join("\n")],

  ["complete", "leading whitespace but not code-indented", "  GOAL_COMPLETE: done"],

  ["blocked", "blocked wins when last", "GOAL_COMPLETE: maybe\nActually no.\nGOAL_BLOCKED: cannot proceed"],

  ["null", "nested-looking fence stays open", ["```", "GOAL_COMPLETE: a", "```bash", "GOAL_COMPLETE: b"].join("\n")],
];

let pass = 0;
const fails: string[] = [];
for (const [expected, name, text] of cases) {
  const got = String(findMarker(text));
  if (got === expected) pass++;
  else fails.push(`  ${name}: expected ${expected}, got ${got}`);
}
console.log(`${pass}/${cases.length} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
