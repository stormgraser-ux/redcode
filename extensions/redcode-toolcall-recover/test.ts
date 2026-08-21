import { parseLeakedToolCalls } from "./parse.ts";

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures += 1;
  }
}

// The three scaffold corruptions seen in real sessions, verbatim in shape.
const space = parseLeakedToolCalls(
  "Reading the dossier.\n\n<tool_call>\n<function= bash>\n<parameter=command>\n" +
    "grep -n '^#' docs/ninfer.md\n</parameter>\n</function>\n</tool_call>",
);
check(space.kind === "calls", "'<function= bash>' recovered");
if (space.kind === "calls") {
  check(space.calls.length === 1 && space.calls[0].name === "bash", "space repair names bash");
  check(space.calls[0].args.command === "grep -n '^#' docs/ninfer.md", "space repair keeps arg");
  check(space.prefix === "Reading the dossier.", "space repair keeps the prose prefix");
}

const gt = parseLeakedToolCalls(
  "<tool_call>\n<function=bash>\n<parameter>command>\ncat ~/.pi/agent/settings.json\n" +
    "</parameter>\n</function>\n</tool_call>",
);
check(gt.kind === "calls", "'<parameter>name>' recovered");
if (gt.kind === "calls") {
  check(gt.calls[0].args.command === "cat ~/.pi/agent/settings.json", "gt repair keeps arg");
}

// The degenerate transposition: no </parameter> at all. Must NOT be executed.
const swap = parseLeakedToolCalls(
  "<tool_call>\n<function=command>\n<parameter=bash>\n</function>\n</tool_call>",
);
check(swap.kind === "malformed", "transposed empty call stays malformed");

// A nameless <parameter> must not have its value read as the name.
const nameless = parseLeakedToolCalls(
  "<tool_call>\n<function=bash>\n<parameter>\nls -la\n</parameter>\n</function>\n</tool_call>",
);
check(nameless.kind === "malformed", "nameless parameter stays malformed");

// Truncation: open tag, half a value, nothing else.
const cut = parseLeakedToolCalls("<tool_call>\n<function=write>\n<parameter=content>\nhalf a fi");
check(cut.kind === "malformed", "truncated block stays malformed");

check(parseLeakedToolCalls("just an ordinary answer").kind === "none", "plain prose untouched");

// Multiple blocks and a JSON-valued parameter.
const two = parseLeakedToolCalls(
  "<tool_call>\n<function=edit>\n<parameter=edits>\n[{\"a\":1}]\n</parameter>\n</function>\n" +
    "</tool_call>\n<tool_call>\n<function=ls>\n<parameter=path>\n/tmp\n</parameter>\n" +
    "</function>\n</tool_call>",
);
check(two.kind === "calls" && two.calls.length === 2, "two blocks recovered");
if (two.kind === "calls") {
  check(Array.isArray(two.calls[0].args.edits), "JSON parameter value decoded");
  check(two.calls[1].name === "ls", "second block names ls");
}

// Prose AFTER the block is not part of the grammar and must not be executed.
const trailing = parseLeakedToolCalls(
  "<tool_call>\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>\n" +
    "</tool_call>\nand then I will explain",
);
check(trailing.kind === "malformed", "trailing prose stays malformed");

if (failures === 0) console.log("ok");
process.exit(failures === 0 ? 0 : 1);
