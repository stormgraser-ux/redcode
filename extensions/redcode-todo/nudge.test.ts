// Unit tests for the plan nudge. Run:
//   node --experimental-strip-types nudge.test.ts
import { appendNudge, planNudge, type NudgeState } from "./nudge.ts";
import type { Item } from "./reconcile.ts";

const PLAN: Item[] = [
  { id: 1, text: "Repo foundation", status: "in_progress" },
  { id: 2, text: "Engine", status: "pending" },
  { id: 3, text: "Simulation", status: "pending" },
];
const DONE: Item[] = PLAN.map((i) => ({ ...i, status: "completed" as const }));

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

const fresh = (): NudgeState => ({ since: 0 });

// 1. Fires only once the threshold is reached, not before.
{
  const s = fresh();
  const early = Array.from({ length: 9 }, () => planNudge(PLAN, "bash", s, 10));
  check("silent below threshold", early.every((r) => r === null), `got ${early.filter(Boolean).length} nudges`);
  check("fires on the 10th", planNudge(PLAN, "bash", s, 10) !== null);
}

// 2. Re-arms: at most one nudge per `after` calls, forever.
{
  const s = fresh();
  let count = 0;
  for (let i = 0; i < 100; i++) if (planNudge(PLAN, "bash", s, 10)) count++;
  check("re-arms at a steady rate", count === 10, `got ${count} in 100 calls`);
}

// 3. A `todo` result resets the counter and never carries a nudge.
{
  const s = fresh();
  for (let i = 0; i < 9; i++) planNudge(PLAN, "bash", s, 10);
  check("todo result is never nudged", planNudge(PLAN, "todo", s, 10) === null);
  check("todo resets the counter", s.since === 0);
  const after = Array.from({ length: 9 }, () => planNudge(PLAN, "bash", s, 10));
  check("counter really restarted", after.every((r) => r === null));
}

// 4. A finished plan does not nag, and neither does an empty one.
{
  check("completed plan is silent", planNudge(DONE, "bash", { since: 999 }, 1) === null);
  check("empty plan is silent", planNudge([], "bash", { since: 999 }, 1) === null);
}

// 5. Escape hatch.
{
  check("after<=0 disables", planNudge(PLAN, "bash", { since: 999 }, 0) === null);
}

// 6. Message content: counts completed only, and names the active step.
{
  const partial: Item[] = [
    { id: 1, text: "Repo foundation", status: "completed" },
    { id: 2, text: "Engine", status: "in_progress" },
    { id: 3, text: "Simulation", status: "pending" },
  ];
  const msg = planNudge(partial, "bash", { since: 9 }, 10) ?? "";
  check("reports done/total", msg.includes("1/3 complete"), msg);
  check("names the in-progress step", msg.includes('"Engine" in progress'), msg);

  const none = planNudge(
    [{ id: 1, text: "a", status: "pending" }],
    "bash",
    { since: 9 },
    10,
  ) ?? "";
  check("handles nothing in progress", none.includes("nothing in progress"), none);
}

// 7. appendNudge must not mutate the caller's array or its blocks. This is the
//    cache-safety invariant: the extension appends to the result being built
//    right now and touches nothing that is already in history.
{
  const original = [{ type: "text", text: "tool output" }];
  const snapshot = JSON.stringify(original);
  const out = appendNudge(original, "\n\nNUDGE");
  check("input array not mutated", JSON.stringify(original) === snapshot);
  check("input block not mutated", original[0].text === "tool output");
  check("returns a new array", out !== (original as unknown));
  check("appended to the last text block", out[0].text === "tool output\n\nNUDGE");
}

// 8. Appends to the LAST text block when there are several.
{
  const out = appendNudge(
    [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    "\n\nNUDGE",
  );
  check("earlier block untouched", out[0].text === "first");
  check("last block carries it", out[1].text === "second\n\nNUDGE");
}

// 9. Image-only and empty results get their own text block.
{
  const img = appendNudge([{ type: "image", source: "x" }], "\n\nNUDGE");
  check("image-only gains a text block", img.length === 2 && img[1].text === "NUDGE", JSON.stringify(img));
  const empty = appendNudge(undefined, "\n\nNUDGE");
  check("undefined content is safe", empty.length === 1 && empty[0].text === "NUDGE");
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
