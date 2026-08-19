#!/usr/bin/env node
// assert-smoke.mjs — check the event log of a `pi --mode json` smoke run.
//
//   node scripts/assert-smoke.mjs <events.jsonl> <provider> <model>
//
// A good smoke run is: a session header, at least one assistant message, no
// assistant message that errored, and a final message that stopped on "stop"
// (not "error", "length", or "aborted") with non-empty text, from the model
// we asked for. Anything less means the round trip did not happen, and a
// silent partial success is exactly what this test exists to catch.

import { readFileSync } from "node:fs";

const [file, provider, model] = process.argv.slice(2);
if (!file || !provider || !model) {
  console.error("usage: assert-smoke.mjs <events.jsonl> <provider> <model>");
  process.exit(2);
}

let lines;
try {
  lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch (err) {
  console.error(`FAIL: could not read the event log as JSON lines: ${err.message}`);
  process.exit(1);
}

const fails = [];

if (!lines.some((l) => l.type === "session")) fails.push("no session header in the event log");

const assistantEnds = lines.filter(
  (l) => l.type === "message_end" && l.message?.role === "assistant",
);
if (assistantEnds.length === 0) fails.push("no assistant message_end events");

for (const e of assistantEnds) {
  if (e.message.stopReason === "error") {
    fails.push(`assistant message errored: ${e.message.errorMessage ?? "(no message)"}`);
  }
}

const last = assistantEnds.at(-1);
if (last && !fails.length) {
  const text = (last.message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (last.message.stopReason !== "stop")
    fails.push(`final assistant message stopped on '${last.message.stopReason}'`);
  else if (text.trim().length === 0) fails.push("final assistant message is empty");
  if (last.message.provider !== provider)
    fails.push(`response came from provider '${last.message.provider}', expected '${provider}'`);
  if (last.message.model !== model)
    fails.push(`response came from model '${last.message.model}', expected '${model}'`);
  const usage = last.message.usage ?? {};
  const shown = text.trim().replace(/\s+/g, " ").slice(0, 120);
  console.log(
    `  ${last.message.provider}/${last.message.model}  in=${usage.input ?? "?"} out=${usage.output ?? "?"}  “${shown}”`,
  );
}

if (fails.length) {
  console.error("FAIL:\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log(`  ok — ${assistantEnds.length} assistant message(s), final stopReason 'stop'`);