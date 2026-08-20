import {
  contextPct,
  decodeRate,
  fmtTokens,
  fmtTtft,
  rateColour,
  segments,
  type Turn,
} from "./rate.ts";

let failures = 0;
let checks = 0;
function check(what: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------- decodeRate
check("plain rate", decodeRate(100, 1000) === 100, String(decodeRate(100, 1000)));
check("half a second", decodeRate(50, 500) === 100);
check("no tokens is null", decodeRate(0, 1000) === null);
check("negative tokens is null", decodeRate(-5, 1000) === null);
check("a span too short to divide is null", decodeRate(100, 10) === null,
  String(decodeRate(100, 10)));
check("NaN tokens is null", decodeRate(NaN, 1000) === null);
check("NaN span is null", decodeRate(100, NaN) === null);
{
  // The trap this module exists for: including a 20s prefill in a 10s stream
  // must not be what gets reported. Same tokens, very different answers —
  // the test asserts the two are far enough apart to matter.
  const honest = decodeRate(1240, 10_000)!;
  const folded = decodeRate(1240, 30_000)!;
  check("folding prefill into decode understates badly", honest / folded > 2.9,
    `${honest.toFixed(0)} vs ${folded.toFixed(0)}`);
}

// ------------------------------------------------------------------ fmtTtft
check("sub-second in ms", fmtTtft(240) === "240ms", fmtTtft(240));
check("over a second in s", fmtTtft(1500) === "1.5s", fmtTtft(1500));
check("exactly a second", fmtTtft(1000) === "1.0s", fmtTtft(1000));
check("long context ttft stays readable", fmtTtft(17_400) === "17.4s", fmtTtft(17_400));
check("negative is a dash", fmtTtft(-1) === "—");

// ---------------------------------------------------------------- fmtTokens
check("small counts are literal", fmtTokens(42) === "42", fmtTokens(42));
check("thousands", fmtTokens(5500) === "5.5k", fmtTokens(5500));
check("millions", fmtTokens(13_200_000) === "13.2M", fmtTokens(13_200_000));
check("boundary at 1000", fmtTokens(1000) === "1.0k", fmtTokens(1000));
check("rounds below 1000", fmtTokens(999.6) === "1000", fmtTokens(999.6));

// --------------------------------------------------------------- contextPct
check("half full", contextPct(100, 200) === 50);
check("unknown window is null", contextPct(100, null) === null);
check("zero window is null", contextPct(100, 0) === null);
check("undefined window is null", contextPct(100, undefined) === null);
check("negative use is null", contextPct(-1, 200) === null);

// --------------------------------------------------------------- rateColour
check("live rates are provisional", rateColour(true) === "warning");
check("settled rates are final", rateColour(false) === "success");

// ----------------------------------------------------------------- segments
{
  const empty: Turn = { ttftMs: null, tokPerSec: null, output: null };
  check("a fresh session shows nothing", segments(empty).length === 0,
    JSON.stringify(segments(empty)));
}
{
  // Mid-turn: ttft is known before any rate can be.
  const partial: Turn = { ttftMs: 900, tokPerSec: null, output: null };
  const s = segments(partial);
  check("ttft alone renders", s.length === 1 && s[0].key === "ttft", JSON.stringify(s));
  check("ttft text", s[0].text === "ttft 900ms", s[0].text);
}
{
  const full: Turn = { ttftMs: 17_400, tokPerSec: 134.2, output: 5500 };
  const s = segments(full);
  check("all three render", s.length === 3, JSON.stringify(s));
  check("rate first", s[0].text === "134 tok/s", s[0].text);
  check("ttft second", s[1].text === "ttft 17.4s", s[1].text);
  check("output last", s[2].text === "5.5k out", s[2].text);
}
{
  const zeroOut: Turn = { ttftMs: 100, tokPerSec: 10, output: 0 };
  check("a zero output count is omitted",
    !segments(zeroOut).some((s) => s.key === "out"), JSON.stringify(segments(zeroOut)));
}

console.log(`${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
