// Unit tests for plan drift resistance. Run:
//   node --experimental-strip-types test.ts
import { reconcile, type Item } from "./reconcile.ts";

const PLAN: Item[] = [
  { id: 1, text: "Create /health endpoint handler", status: "in_progress" },
  { id: 2, text: "Route /health in the server", status: "pending" },
  { id: 3, text: "Verify endpoint responds correctly", status: "pending" },
];

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. The normal case: status-only progress must work cleanly, no drift flagged.
{
  const r = reconcile(PLAN, [
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Route /health in the server", status: "in_progress" },
    { text: "Verify endpoint responds correctly", status: "pending" },
  ], 4, false);
  check("status update applies", r.items.map((i) => i.status).join() === "completed,in_progress,pending");
  check("status update reports no drift",
    r.drift.reworded.length === 0 && r.drift.omitted.length === 0 && r.drift.added.length === 0);
  check("ids stable", r.items.map((i) => i.id).join() === "1,2,3");
}

// 2. THE CONCERN: the model silently rewords a middle step.
{
  const r = reconcile(PLAN, [
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Add routing for the healthcheck route in server", status: "in_progress" }, // reworded
    { text: "Verify endpoint responds correctly", status: "pending" },
  ], 4, false);
  check("reworded step keeps ORIGINAL text",
    r.items[1].text === "Route /health in the server", `got "${r.items[1].text}"`);
  check("reworded step still takes new status", r.items[1].status === "in_progress");
  check("rewording is reported", r.drift.reworded.length === 1);
  check("rewording does not add a step", r.items.length === 3, `got ${r.items.length}`);
}

// 3. THE CONCERN: the model drops a step entirely.
{
  const r = reconcile(PLAN, [
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Verify endpoint responds correctly", status: "pending" },
  ], 4, false);
  check("omitted step is retained", r.items.length === 3, `got ${r.items.length}`);
  check("omitted step keeps its text", r.items[1].text === "Route /health in the server");
  check("omission is reported", r.drift.omitted.length === 1);
}

// 4. THE CONCERN: the model hallucinates a step into the middle.
{
  const r = reconcile(PLAN, [
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Refactor the entire database layer", status: "pending" }, // invented
    { text: "Route /health in the server", status: "pending" },
    { text: "Verify endpoint responds correctly", status: "pending" },
  ], 4, false);
  check("invented step is appended, not inserted",
    r.items.map((i) => i.text).join(" | ") ===
      "Create /health endpoint handler | Route /health in the server | Verify endpoint responds correctly | Refactor the entire database layer",
    r.items.map((i) => i.text).join(" | "));
  check("original three keep their positions", r.items.slice(0, 3).map((i) => i.id).join() === "1,2,3");
  check("addition is reported", r.drift.added.length === 1);
}

// 5. THE CONCERN: the model reorders the plan.
{
  const r = reconcile(PLAN, [
    { text: "Verify endpoint responds correctly", status: "pending" },
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Route /health in the server", status: "pending" },
  ], 4, false);
  check("order is preserved", r.items.map((i) => i.id).join() === "1,2,3");
  check("reorder is reported", r.drift.reordered);
  check("statuses still map to the right steps", r.items[0].status === "completed" && r.items[2].status === "pending");
}

// 6. Total hallucination: model returns a completely unrelated plan.
{
  const r = reconcile(PLAN, [
    { text: "Set up Kubernetes cluster", status: "pending" },
    { text: "Configure Istio service mesh", status: "pending" },
  ], 4, false);
  check("original plan survives wholesale hallucination",
    r.items.slice(0, 3).map((i) => i.text).join() === PLAN.map((i) => i.text).join());
  check("hallucinated steps appended and flagged", r.drift.added.length === 2 && r.items.length === 5);
}

// 7. Legitimate growth: appending a real next step must just work.
{
  const r = reconcile(PLAN, [
    { text: "Create /health endpoint handler", status: "completed" },
    { text: "Route /health in the server", status: "completed" },
    { text: "Verify endpoint responds correctly", status: "completed" },
    { text: "Add a test for the health endpoint", status: "pending" },
  ], 4, false);
  check("genuine append works", r.items.length === 4 && r.items[3].text === "Add a test for the health endpoint");
  check("append gets a fresh id", r.items[3].id === 4);
  check("append is not treated as rewording", r.drift.reworded.length === 0);
}

// 8. Explicit revision is honoured.
{
  const r = reconcile(PLAN, [
    { text: "Scrap it, use the framework's built-in healthcheck", status: "in_progress" },
  ], 4, true);
  check("revise:true replaces the plan", r.items.length === 1);
  check("revise:true reports no drift", r.drift.omitted.length === 0 && r.drift.reworded.length === 0);
}

// 9. Trivial formatting differences must NOT count as rewording.
{
  const r = reconcile(PLAN, [
    { text: "create /health endpoint handler.", status: "completed" },
    { text: "Route /health in the server", status: "pending" },
    { text: "Verify endpoint responds correctly", status: "pending" },
  ], 4, false);
  check("case/punctuation is not drift", r.drift.reworded.length === 0, JSON.stringify(r.drift.reworded));
  check("text stays canonical", r.items[0].text === "Create /health endpoint handler");
}

// 10. First plan from empty state.
{
  const r = reconcile([], [
    { text: "Step one", status: "in_progress" },
    { text: "Step two", status: "pending" },
  ], 1, false);
  check("initial plan accepted", r.items.length === 2 && r.items[0].id === 1 && r.nextId === 3);
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
