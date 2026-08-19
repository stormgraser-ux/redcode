// Unit tests for model-profile lookup. Run:
//   node --experimental-strip-types catalog.test.ts
import { CATALOG, FALLBACK, profileFor } from "./catalog.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- longest prefix wins ---------------------------------------------------
// "qwen3.8-27b-nvfp4" starts with "qwen3.8-27b", so a first-match lookup would
// hand the NVFP4 build the dense model's 204,800 window and pi would send
// prompts the server rejects. Table order must not matter.
check(
  "nvfp4 is not swallowed by the shorter prefix",
  profileFor("qwen3.8-27b-nvfp4").idPrefix === "qwen3.8-27b-nvfp4",
  profileFor("qwen3.8-27b-nvfp4").idPrefix,
);
check("plain dense model still matches", profileFor("qwen3.8-27b").idPrefix === "qwen3.8-27b");
check(
  "nvfp4 carries its own smaller window",
  profileFor("qwen3.8-27b-nvfp4").contextWindow < profileFor("qwen3.8-27b").contextWindow,
);

// --- reasoning levels ------------------------------------------------------
// The important one. An unsupported reasoning_effort returns a 400 that pi
// silently retries, so the turn HANGS instead of erroring. Levels the template
// rejects must be null (hidden), never mapped to something else.
const dense = profileFor("qwen3.8-27b");
check("dense model exposes graded effort", dense.supportsReasoningEffort);
for (const level of ["minimal", "high", "max"]) {
  check(`${level} is hidden, not remapped`, dense.thinkingLevelMap?.[level] === null);
}
for (const level of ["low", "medium", "xhigh"]) {
  check(`${level} maps through`, typeof dense.thinkingLevelMap?.[level] === "string");
}
check("off means none", dense.thinkingLevelMap?.off === "none");

// The MoE's thinking is BINARY, not graded: every graded level 400s and only
// `enable_thinking` works. A map here would be actively harmful.
const moe = profileFor("qwen3.6-35b-a3b");
check("moe does not advertise graded effort", !moe.supportsReasoningEffort);
check("moe carries no level map", moe.thinkingLevelMap === undefined);
check("moe uses the enable_thinking format", moe.thinkingFormat === "qwen");
check(
  "moe does NOT use qwen-chat-template",
  (moe.thinkingFormat as string) !== "qwen-chat-template",
);

// --- unknown models --------------------------------------------------------
const unknown = profileFor("some-model-nobody-has-heard-of");
check("unknown model still resolves", !!unknown);
check("unknown model is labelled by its id", unknown.label === "some-model-nobody-has-heard-of");
check("unknown model gets the fallback window", unknown.contextWindow === FALLBACK.contextWindow);
check("unknown model claims no vision", !unknown.vision);
check("unknown model offers no thinking levels", unknown.thinkingLevelMap === undefined);
check(
  "the fallback window is smaller than every catalogued one",
  CATALOG.every((p) => p.contextWindow > FALLBACK.contextWindow),
);

// --- table sanity ----------------------------------------------------------
check(
  "every entry has a positive window and token cap",
  CATALOG.every((p) => p.contextWindow > 0 && p.maxTokens > 0),
);
check(
  "no duplicate prefixes",
  new Set(CATALOG.map((p) => p.idPrefix)).size === CATALOG.length,
);

if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
