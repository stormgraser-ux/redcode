// Unit tests for the /btw pure logic. Run:
//   node --experimental-strip-types side.test.ts
import {
  extractAnswer,
  hasToolCall,
  sideQuestionText,
  tailLines,
  toolRefusalNote,
  truncate,
} from "./side.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. sideQuestionText wraps the question and states the no-tools rule.
{
  const q = "why did we pick btrfs here?";
  const text = sideQuestionText(q);
  check("includes the question", text.includes(q));
  check("states no tools", /do not use any tools/i.test(text));
  check("states one-shot", /one-shot/i.test(text));
  check("is a single message", !text.startsWith("\n"));
}

// 2. extractAnswer pulls only text blocks, in order.
{
  const content = [
    { type: "thinking", thinking: "let me see…" },
    { type: "text", text: "Hello " },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "world." },
  ];
  check("joins text blocks", extractAnswer(content) === "Hello world.");
  check("ignores thinking", !extractAnswer(content).includes("let me see"));
  check("ignores toolCall", !extractAnswer(content).includes("read"));
  check("empty on non-array", extractAnswer(undefined) === "");
  check("empty on null blocks", extractAnswer([null, { type: "text" }]) === "");
}

// 3. hasToolCall detects tool calls.
{
  check(
    "detects a tool call",
    hasToolCall([{ type: "text", text: "x" }, { type: "toolCall", name: "bash" }]),
  );
  check("false when absent", hasToolCall([{ type: "text", text: "x" }]) === false);
  check("false on non-array", hasToolCall("nope") === false);
}

// 4. tailLines keeps the last n lines and trims trailing whitespace.
{
  check(
    "keeps last 3",
    JSON.stringify(tailLines("a\nb\nc\nd\ne\n", 3)) === JSON.stringify(["c", "d", "e"]),
  );
  check("fewer than n returns all", JSON.stringify(tailLines("x\ny", 5)) === JSON.stringify(["x", "y"]));
  check("empty on blank", tailLines("   \n", 3).length === 0);
}

// 5. truncate collapses to one line and clips.
{
  check("no-op under max", truncate("short", 10) === "short");
  check("clips over max", truncate("a".repeat(200), 10).length === 10);
  check("clips ends with ellipsis", truncate("a".repeat(200), 10).endsWith("…"));
  check("collapses newlines", truncate("a\nb\n\nc", 10) === "a b c");
}

// 6. toolRefusalNote is a non-empty human sentence.
{
  check("non-empty", toolRefusalNote().length > 10);
  check("mentions tool-less", /tool-less|toolless/i.test(toolRefusalNote()));
}

console.log(`side.test: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}