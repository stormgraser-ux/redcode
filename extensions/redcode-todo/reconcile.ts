// reconcile.ts — make plan text immutable without making the model track ids.
//
// THE PROBLEM. The tool takes the whole list on every update, because a 27B
// cannot reliably track numeric ids across a long session. But whole-list
// restatement means the model must reproduce every step verbatim every time,
// and verbatim reproduction under long context is exactly where a small model
// drifts: it rewords step 3, quietly drops step 4, or invents step 5. A plan
// that mutates halfway through is worse than no plan, because the user is
// using it to track progress and cannot see that the target moved.
//
// THE FIX. Split authority. The MODEL owns status. The EXTENSION owns text,
// order, and membership. An incoming list is aligned against the stored plan:
// matched steps donate only their status, and their original text and position
// are preserved. Steps the model omitted are kept, not deleted. Genuinely new
// steps are appended at the end, never inserted into the middle.
//
// Real revisions still happen, so `revise: true` accepts the incoming list
// wholesale — but it is an explicit, visible act rather than a silent drift.
//
// This file is pure so it can be unit-tested without pi or a GPU: see test.ts.

export type Status = "pending" | "in_progress" | "completed";

export interface Item {
  id: number;
  text: string;
  status: Status;
}

export interface Incoming {
  text: string;
  status: Status;
}

export interface Drift {
  reworded: { from: string; to: string }[];
  omitted: string[];
  added: string[];
  reordered: boolean;
}

export interface Result {
  items: Item[];
  nextId: number;
  drift: Drift;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set([
  "the", "for", "and", "in", "on", "to", "of", "a", "an", "with", "from",
  "into", "that", "this", "its", "is", "are", "be", "at", "by", "then",
]);

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Overlap coefficient on content words: |A∩B| / min(|A|,|B|).
 *
 *  NOT Jaccard. A rewording usually ADDS words ("Route /health in the server"
 *  -> "Add routing for the healthcheck route in server"), which inflates the
 *  union and pushes Jaccard down — that pair scores 0.375 by Jaccard and would
 *  be missed, splitting one step into two. Overlap scores it 0.67 because it
 *  asks "is the smaller step contained in the larger?", which is the actual
 *  question when text drifts. */
export function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // A single shared content word is coincidence, not a rewording. Requiring two
  // makes the failure mode UNDER-matching, which is the safe direction: an
  // unmatched step is kept AND the new one appended, so both stay visible.
  // Over-matching would silently merge two distinct steps and lose one.
  if (inter < 2) return 0;
  return inter / Math.min(ta.size, tb.size);
}

const SAME_STEP = 0.5;

export function reconcile(
  stored: Item[],
  incoming: Incoming[],
  nextId: number,
  revise: boolean,
): Result {
  const drift: Drift = { reworded: [], omitted: [], added: [], reordered: false };

  // Explicit revision: the model is deliberately replacing the plan. Accept it,
  // but renumber from scratch so ids stay meaningful.
  if (revise) {
    const items = incoming.map((inc, i) => ({ id: nextId + i, text: inc.text, status: inc.status }));
    return { items, nextId: nextId + incoming.length, drift };
  }

  if (stored.length === 0) {
    const items = incoming.map((inc, i) => ({ id: nextId + i, text: inc.text, status: inc.status }));
    return { items, nextId: nextId + incoming.length, drift };
  }

  const usedIncoming = new Set<number>();

  // Pass 1: exact normalized matches, so rewording never steals an exact hit.
  const matchFor = new Map<number, number>(); // stored index -> incoming index
  stored.forEach((s, si) => {
    const hit = incoming.findIndex((inc, ii) => !usedIncoming.has(ii) && norm(inc.text) === norm(s.text));
    if (hit !== -1) { matchFor.set(si, hit); usedIncoming.add(hit); }
  });

  // Pass 2: fuzzy matches for the rest — these are the rewordings.
  stored.forEach((s, si) => {
    if (matchFor.has(si)) return;
    let best = -1;
    let bestScore = 0;
    incoming.forEach((inc, ii) => {
      if (usedIncoming.has(ii)) return;
      const score = similarity(s.text, inc.text);
      if (score > bestScore) { bestScore = score; best = ii; }
    });
    if (best !== -1 && bestScore >= SAME_STEP) {
      matchFor.set(si, best);
      usedIncoming.add(best);
      drift.reworded.push({ from: s.text, to: incoming[best].text });
    }
  });

  // Stored order is authoritative. Matched steps take the incoming status only.
  const items: Item[] = stored.map((s, si) => {
    const mi = matchFor.get(si);
    if (mi === undefined) {
      drift.omitted.push(s.text);
      return { ...s };
    }
    return { ...s, status: incoming[mi].status };
  });

  // Did the model try to reorder? Detect it for reporting; do not honour it.
  const matchedOrder = stored
    .map((_, si) => matchFor.get(si))
    .filter((v): v is number => v !== undefined);
  for (let i = 1; i < matchedOrder.length; i++) {
    if (matchedOrder[i] < matchedOrder[i - 1]) { drift.reordered = true; break; }
  }

  // Anything left over is genuinely new. Append; never insert into the middle.
  let id = nextId;
  incoming.forEach((inc, ii) => {
    if (usedIncoming.has(ii)) return;
    items.push({ id: id++, text: inc.text, status: inc.status });
    drift.added.push(inc.text);
  });

  return { items, nextId: id, drift };
}

export function driftSummary(d: Drift): string[] {
  const notes: string[] = [];
  for (const r of d.reworded) notes.push(`kept original wording "${r.from}" (you sent "${r.to}")`);
  for (const o of d.omitted) notes.push(`kept step "${o}" that you omitted`);
  if (d.reordered) notes.push("kept the original step order");
  return notes;
}
