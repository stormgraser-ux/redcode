// Tests for the header's geometry. No terminal, no theme, no filesystem —
// the point of splitting layout.ts out is that all of this is arithmetic.

import {
  build,
  columns,
  cut,
  natural,
  pad,
  reflow,
  type Snapshot,
  type ThemeLike,
  vis,
  wrap,
  WORDMARK,
} from "./layout.ts";

let failures = 0;
let checks = 0;
function check(what: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

// A theme that emits real SGR, so width handling is exercised rather than
// bypassed by a no-op stub.
const theme: ThemeLike = { fg: (_k, s) => `\x1b[31m${s}\x1b[0m` };
const plain: ThemeLike = { fg: (_k, s) => s };

// ------------------------------------------------------------------ vis/pad
check("vis ignores SGR", vis("\x1b[31mabc\x1b[0m") === 3, String(vis("\x1b[31mabc\x1b[0m")));
check("vis of empty", vis("") === 0);
check("pad to width", vis(pad("ab", 5)) === 5);
check("pad never shrinks", pad("abcdef", 3) === "abcdef");
check("pad counts colour as zero", vis(pad("\x1b[31mab\x1b[0m", 5)) === 5);

// ---------------------------------------------------------------------- cut
check("cut leaves short strings", cut("abc", 10) === "abc");
check("cut marks truncation", cut("abcdefgh", 4).includes("…"));
check("cut respects printed width", vis(cut("abcdefgh", 4)) <= 4, String(vis(cut("abcdefgh", 4))));
check("cut keeps colour codes", cut("\x1b[31mabcdefgh\x1b[0m", 4).includes("\x1b[31m"));
check("cut at zero width is empty", cut("abc", 0) === "");

// --------------------------------------------------------------------- wrap
{
  const lines = wrap("aaa bbb ccc ddd", 7);
  check("wrap splits", lines.length > 1, String(lines.length));
  check("wrap respects width", lines.every((l) => vis(l) <= 7), JSON.stringify(lines));
}
check("wrap leaves short input alone", wrap("abc", 10).length === 1);
{
  // A break inside a coloured run must re-open the colour, or the remainder
  // renders in the terminal default.
  const lines = wrap(`\x1b[31m${"aaa bbb ccc ddd eee"}\x1b[0m`, 7);
  check("wrap re-emits SGR after a break", lines.slice(1).every((l) => l.startsWith("\x1b[31m")),
    JSON.stringify(lines));
}
{
  // An unbroken token longer than the width must still terminate.
  const lines = wrap("aaaaaaaaaaaaaaaaaaaa", 5);
  check("wrap handles a word longer than the width", lines.length >= 4, String(lines.length));
  check("wrap hard-breaks to width", lines.every((l) => vis(l) <= 5));
}

// -------------------------------------------------------------- cell sizing
check("natural uses the title when longest", natural({ title: "context", lines: ["ab"] }) === 7);
check("natural is capped", natural({ title: "x", lines: ["y".repeat(100)] }) === 34);
check("natural of an empty cell", natural({ title: "", lines: [] }) === 0);
{
  const r = reflow({ title: "x", lines: ["z".repeat(100)] });
  check("reflow wraps to the capped width", r.lines.every((l) => vis(l) <= 34), JSON.stringify(r.lines));
}

// ------------------------------------------------------------------ columns
{
  const cells = [
    { title: "one", lines: ["a", "bb"] },
    { title: "two", lines: ["ccc"] },
  ];
  const out = columns(plain, cells, 80);
  check("columns emits a title row and the tallest cell", out.length === 3, String(out.length));
  check("columns puts both titles on one line", out[0].includes("one") && out[0].includes("two"), out[0]);
}
{
  // Too narrow to sit side by side: they must stack, not overflow.
  const cells = [
    { title: "one", lines: ["a".repeat(30)] },
    { title: "two", lines: ["b".repeat(30)] },
  ];
  const out = columns(plain, cells, 32);
  check("columns wraps to a second row when too narrow", out.length > 3, String(out.length));
  check("columns never exceeds the width", out.every((l) => vis(l) <= 32),
    JSON.stringify(out.map(vis)));
}

// -------------------------------------------------------------------- build
const baseSnap: Snapshot = { cwd: "~/code/thing", context: [], notes: [] };

{
  const out = build(theme, baseSnap, 100);
  check("build draws the wordmark", out.some((l) => l.includes(WORDMARK[1].slice(-4))),
    JSON.stringify(out.slice(0, 5)));
  check("build tells an unconfigured user what to do",
    out.some((l) => l.includes("/connect")), JSON.stringify(out));
  check("build falls back to cwd with no repo",
    out.some((l) => l.includes("~/code/thing")));
}
{
  const snap: Snapshot = {
    ...baseSnap,
    endpoint: { name: "ninfer", host: "host.ts.net:8449", model: "qwen" },
  };
  const out = build(theme, snap, 100);
  check("build shows the endpoint", out.some((l) => l.includes("host.ts.net:8449")));
  check("build shows the model", out.some((l) => l.includes("qwen")));
  check("configured sessions do not nag about /connect",
    !out.some((l) => l.includes("/connect")));
}
{
  const snap: Snapshot = {
    ...baseSnap,
    repo: { name: "redcode", branch: "master", dirty: 3, ahead: 1, behind: 0 },
  };
  const out = build(theme, snap, 100);
  check("build shows repo and branch", out.some((l) => l.includes("redcode") && l.includes("master")));
  check("build shows dirty count", out.some((l) => l.includes("3 dirty")));
  check("build shows ahead", out.some((l) => l.includes("^1")));
  check("build omits a zero behind count", !out.some((l) => l.includes("v0")));
}
{
  const snap: Snapshot = { ...baseSnap, context: ["~/AGENTS.md", "~/code/thing/AGENTS.md"] };
  const out = build(theme, snap, 100);
  check("build lists context files", out.some((l) => l.includes("AGENTS.md")));
}
{
  // The narrow case matters: this renders in a real terminal someone has
  // dragged to half width, and an overflowing header corrupts the whole TUI.
  for (const w of [20, 40, 57, 80, 200]) {
    const snap: Snapshot = {
      ...baseSnap,
      endpoint: { name: "ninfer", host: "very-long-host-name.example.ts.net:8449", model: "qwen3.8-27b" },
      repo: { name: "redcode", branch: "master", dirty: 3, ahead: 1, behind: 2 },
      context: ["~/AGENTS.md", "~/code/some/deeply/nested/place/AGENTS.md"],
      notes: ["something is a bit off"],
    };
    const out = build(theme, snap, w);
    check(`build never exceeds width ${w}`, out.every((l) => vis(l) <= w),
      JSON.stringify(out.filter((l) => vis(l) > w).map((l) => [vis(l), l])));
  }
}
{
  // Below the mark's own width it must degrade rather than overflow.
  const out = build(theme, baseSnap, 20);
  check("narrow header falls back to a text wordmark",
    out.some((l) => l.includes("REDCODE")), JSON.stringify(out));
}

console.log(`${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
