// Unit tests for compaction progress estimation. Run:
//   node --experimental-strip-types estimate.test.ts
import {
  MAX_SAMPLES,
  addSample,
  barCells,
  baselineMs,
  calibration,
  estimatePromptTokens,
  formatElapsed,
  predictMs,
  progressFraction,
  reasonLabel,
  type Sample,
} from "./estimate.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. Prompt estimation counts text, thinking and tool-call arguments.
{
  const msgs = [
    { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(400) }] },
  ];
  check("counts text and thinking", estimatePromptTokens(msgs) === 200, String(estimatePromptTokens(msgs)));

  const withCall = [{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "a" } }] }];
  check("counts tool-call arguments", estimatePromptTokens(withCall) > 0);
}

// 2. Tool results are capped at 2,000 chars, matching serializeConversation.
//    Without this a tool-heavy session — the kind that actually reaches
//    compaction — is overestimated badly.
{
  const huge = [{ role: "toolResult", content: [{ type: "text", text: "z".repeat(100_000) }] }];
  check("tool result truncated to 2000 chars", estimatePromptTokens(huge) === 500, String(estimatePromptTokens(huge)));

  const userHuge = [{ role: "user", content: [{ type: "text", text: "z".repeat(100_000) }] }];
  check("non-tool-result is NOT truncated", estimatePromptTokens(userHuge) === 25_000, String(estimatePromptTokens(userHuge)));
}

// 3. Malformed input must never throw: this runs inside a compaction hook.
{
  let threw = false;
  try {
    estimatePromptTokens([null, undefined, 42, "str", {}, { content: 7 }] as unknown[]);
  } catch {
    threw = true;
  }
  check("survives malformed messages", !threw);
  check("empty list is zero", estimatePromptTokens([]) === 0);

  const circular: any = { role: "assistant", content: [{ type: "toolCall", arguments: {} }] };
  circular.content[0].arguments.self = circular;
  let threw2 = false;
  try {
    estimatePromptTokens([circular]);
  } catch {
    threw2 = true;
  }
  check("survives circular tool arguments", !threw2);
}

// 4. Baseline grows with prompt size and has a floor.
{
  check("baseline grows with tokens", baselineMs(200_000) > baselineMs(10_000));
  check("baseline has a floor", baselineMs(0) >= 4000);
}

// 5. Calibration: no samples is a no-op factor; consistent samples are learned.
{
  check("no samples → factor 1", calibration([]) === 1);

  const doubled: Sample[] = [10_000, 50_000, 90_000].map((t) => ({
    promptTokens: t,
    ms: baselineMs(t) * 2,
  }));
  check("learns a 2x scale", Math.abs(calibration(doubled) - 2) < 0.01, String(calibration(doubled)));

  // Median, not mean: one absurd run must not capture the prediction.
  const withOutlier: Sample[] = [
    ...doubled,
    { promptTokens: 50_000, ms: baselineMs(50_000) * 100 },
  ];
  check("outlier does not dominate", calibration(withOutlier) <= 4, String(calibration(withOutlier)));
  check("factor is clamped", calibration([{ promptTokens: 1000, ms: 1 }]) >= 0.25);
}

// 6. Samples are bounded, and the newest are the ones kept.
{
  let s: Sample[] = [];
  for (let i = 0; i < MAX_SAMPLES + 8; i++) s = addSample(s, { promptTokens: i, ms: 1000 });
  check("sample list is bounded", s.length === MAX_SAMPLES, String(s.length));
  check("keeps the newest", s[s.length - 1].promptTokens === MAX_SAMPLES + 7);

  const before: Sample[] = [{ promptTokens: 1, ms: 1 }];
  addSample(before, { promptTokens: 2, ms: 2 });
  check("addSample does not mutate", before.length === 1);
}

// 7. Progress never claims completion while running, and never goes negative.
{
  check("clamped below 1", progressFraction(999_999, 1000) === 0.99);
  check("never negative", progressFraction(-5, 1000) === 0);
  check("halfway is 0.5", Math.abs(progressFraction(500, 1000) - 0.5) < 1e-9);
  check("zero prediction is safe", progressFraction(100, 0) === 0);
}

// 8. Bar cells.
{
  check("full bar", barCells(1, 10).filled === 10);
  check("empty bar", barCells(0, 10).filled === 0);
  check("clamps over-full", barCells(5, 10).filled === 10);
  check("width has a floor", barCells(1, 0).width === 1);
}

// 9. Elapsed formatting.
{
  check("seconds only", formatElapsed(47_000) === "47s", formatElapsed(47_000));
  check("minutes and seconds", formatElapsed(91_000) === "1m 31s", formatElapsed(91_000));
  check("zero", formatElapsed(0) === "0s");
}

// 10. Reason labels cover every value pi emits.
{
  check("overflow label", reasonLabel("overflow").includes("overflow"));
  check("manual label", reasonLabel("manual") === "Compacting conversation");
  check("threshold label", reasonLabel("threshold").includes("Auto-compacting"));
}

// 11. predictMs composes baseline and calibration, and keeps the floor.
{
  const s: Sample[] = [{ promptTokens: 50_000, ms: baselineMs(50_000) * 3 }];
  check("prediction applies calibration", Math.abs(predictMs(50_000, s) - baselineMs(50_000) * 3) < 1);
  check("prediction keeps the floor", predictMs(0, []) >= 4000);
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log("FAILURES:\n" + fails.join("\n"));
  process.exit(1);
}
