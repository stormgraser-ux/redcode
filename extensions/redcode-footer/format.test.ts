// Unit tests for the footer's formatting and layout. Run:
//   node --experimental-strip-types format.test.ts
import {
  bar,
  fillColour,
  fitCells,
  fmt,
  gauge,
  lay,
  num,
  truncate,
  visibleWidth,
} from "./format.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A paint that records the colour so assertions can see it, and keeps the
 *  text visible so width maths can be checked against real output. */
const t = { fg: (name: string, text: string) => `\x1b[38;5;1m${text}\x1b[0m<${name}>` };
/** A paint that is a pure passthrough, for width assertions. */
const plain = { fg: (_n: string, text: string) => text };

// 1. Number formatting. The two halves of `199k/205k` have to use the same
//    scale or the ratio is unreadable.
{
  check("units", fmt(42) === "42");
  check("thousands", fmt(1234) === "1.2k");
  check("hundreds of thousands drop the decimal", fmt(199_000) === "199k", fmt(199_000));
  check("millions", fmt(13_200_000) === "13.2M");
  check("boundary", fmt(999) === "999");
}

// 2. Usage coercion. NInfer reports `cost` as an OBJECT, and `0 + {}` yields a
//    STRING in JS — the failure then surfaces at a distant .toFixed() and kills
//    pi from inside a timer callback.
{
  check("number", num(5) === 5);
  check("numeric string", num("5") === 5);
  check("object with total", num({ total: 7 }) === 7);
  check("object with amount", num({ amount: 3 }) === 3);
  check("opaque object", num({ nope: 1 }) === 0);
  check("null", num(null) === 0);
  check("undefined", num(undefined) === 0);
  check("NaN", num(Number.NaN) === 0);
  check("Infinity", num(Number.POSITIVE_INFINITY) === 0);
  check("garbage string", num("abc") === 0);
}

// 3. Width maths must ignore colour codes, or every right-aligned block drifts.
{
  check("plain width", visibleWidth("abc") === 3);
  check("ignores SGR", visibleWidth("\x1b[31mabc\x1b[0m") === 3);
  check("truncate keeps short strings", truncate("abc", 10) === "abc");
  check("truncate marks elision", truncate("abcdefgh", 4) === "abc…");
  check("truncate width is respected", visibleWidth(truncate("abcdefgh", 4)) === 4);
  check("truncate keeps colour codes", truncate("\x1b[31mabcdefgh\x1b[0m", 4).includes("\x1b[31m"));
  check("truncate to zero", truncate("abc", 0) === "");
}

// 4. Two-column layout. The right side is the numbers, so it is what survives.
{
  const line = lay("left", "right", 20);
  check("exact width", visibleWidth(line) === 20, String(visibleWidth(line)));
  check("left first", line.startsWith("left"));
  check("right last", line.endsWith("right"));

  check("no right side", lay("left", "", 20) === "left");
  const rightOnly = lay("", "right", 20);
  check("no left side right-aligns", rightOnly.endsWith("right") && visibleWidth(rightOnly) === 20);

  // Left gets truncated to make room...
  const tight = lay("a-very-long-left-hand-side-indeed", "right", 24);
  check("tight: exact width", visibleWidth(tight) === 24, String(visibleWidth(tight)));
  check("tight: right survives whole", tight.endsWith("right"));
  check("tight: left elided", tight.includes("…"));

  // ...until there is no room worth having, and it goes entirely.
  const cramped = lay("a-very-long-left-hand-side-indeed", "0123456789", 14);
  check("cramped: right wins", cramped === "0123456789", cramped);
  check("cramped: width respected", visibleWidth(cramped) <= 14);

  // Colour must not confuse the padding.
  const coloured = lay("\x1b[31mleft\x1b[0m", "\x1b[32mright\x1b[0m", 20);
  check("coloured line is still 20 cells", visibleWidth(coloured) === 20);
}

// 5. The bar. Eighth-block partials are the reason a 12-cell bar can show
//    movement at all; a whole-cell bar would sit still for ~8% at a time.
{
  check("empty bar", bar(plain, 0, 10) === "░░░░░░░░░░".slice(0, 10) + "", bar(plain, 0, 10));
  check("full bar", bar(plain, 1, 10) === "█".repeat(10), bar(plain, 1, 10));
  check("half bar is half full", bar(plain, 0.5, 10).startsWith("█████"));
  check("bar cell count is exact", visibleWidth(bar(plain, 0.37, 12)) === 12);
  for (const f of [0, 0.01, 0.123, 0.5, 0.999, 1]) {
    check(`cell count holds at ${f}`, visibleWidth(bar(plain, f, 14)) === 14);
  }
  check("clamps above 1", visibleWidth(bar(plain, 5, 10)) === 10);
  check("clamps below 0", visibleWidth(bar(plain, -1, 10)) === 10);
  check("NaN renders empty, not broken", visibleWidth(bar(plain, Number.NaN, 10)) === 10);
  check("partial glyph appears mid-cell", /[▏▎▍▌▋▊▉]/.test(bar(plain, 0.55, 10)));
}

// 6. The colour ramp. Three distinguishable steps, and never a red/green pair —
//    this box's owner cannot read red against green.
{
  check("calm", fillColour(0.4) === "border");
  check("warn at 70%", fillColour(0.7) === "warning");
  check("danger at 90%", fillColour(0.9) === "error");
  check("just under danger", fillColour(0.899) === "warning");
  check("unknown is inert", fillColour(Number.NaN) === "borderMuted");
  check("no green anywhere", !["success"].includes(fillColour(0.1)));
}

// 7. The assembled gauge.
{
  const g = gauge(t, "ctx", 0.95, "199k/205k", 10);
  check("gauge carries the label", g.includes("ctx"));
  check("gauge carries the value", g.includes("199k/205k"));
  check("gauge is bracketed", g.includes("▕") && g.includes("▏"));
  check("gauge paints danger", g.includes("<error>"));
  const calm = gauge(t, "ctx", 0.2, "41k/205k", 10);
  check("calm gauge paints the theme tone", calm.includes("<border>"));
  check("gauge width is predictable", visibleWidth(gauge(plain, "ctx", 0.5, "1k/2k", 10)) === 4 + 1 + 10 + 1 + 1 + 5);
}

// 8. Bar sizing against the terminal width. This is what stops the right half
//    from wrapping on a narrow window.
{
  check("wide terminal gets the big bar", fitCells(30, 20, 2, 200) === 14);
  check("narrow terminal shrinks", fitCells(30, 20, 2, 80) < 14, String(fitCells(30, 20, 2, 80)));
  check("very narrow drops the bars", fitCells(60, 40, 2, 70) === 0);
  check("monotonic in width", fitCells(30, 20, 2, 120) >= fitCells(30, 20, 2, 100));
  check("one gauge fits where two do not", fitCells(30, 10, 1, 90) >= fitCells(30, 20, 2, 90));
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log(`FAILURES:\n${fails.join("\n")}`);
  process.exit(1);
}
