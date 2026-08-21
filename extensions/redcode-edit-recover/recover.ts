// Pure logic: turn a failed `edit` into an actionable one. No pi imports and no
// I/O beyond the file content handed in, so it can be unit-tested standalone.
//
// WHAT PI ALREADY DOES, so we do not duplicate it. `fuzzyFindText` in
// core/tools/edit-diff.js already retries a failed exact match after
// normalising: NFKC, trailing whitespace per line, smart quotes, the dash
// family, and exotic spaces. Those cases never reach us.
//
// WHAT IT DOES NOT DO, which is everything below:
//   - LEADING indentation. Getting indent depth wrong is the single most common
//     way a model's oldText misses, and normalizeForFuzzyMatch only trims the
//     END of each line.
//   - Telling the model WHERE it went wrong. Every failure message is a rule
//     restatement ("must match exactly including all whitespace and newlines",
//     "please provide more context to make it unique") and contains not one
//     byte of the file. The model's only recovery move is to re-read the file
//     and guess again, which is why a missed edit reads as a quality collapse
//     rather than a whitespace mismatch (see the redcode note
//     `pi-edit-needs-exact-oldtext`).
//
// WHY DIAGNOSE INSTEAD OF RE-APPLY. We could write the corrected edit
// ourselves. We deliberately do not: the edit tool serialises every mutation
// through `withFileMutationQueue`, and an extension writing the same path from
// the tool_result hook runs outside that queue. Trading a concurrency hazard
// for one saved round-trip is a bad trade. We hand back the exact bytes and let
// the model re-issue, which costs one turn and stays inside the queue.
//
// COST. The reply is appended to a tool RESULT, which is persisted verbatim and
// never rewritten, so it is prompt-cache-safe — unlike a `context` hook, which
// rewrites history and costs a full re-prefill (~70 s locally). Output is hard
// capped by MAX_QUOTE_LINES / MAX_CANDIDATES so a pathological file cannot
// dump itself into context.

/** Lines of real file content to quote around a candidate. Enough to re-anchor,
 *  small enough that several candidates stay cheap. */
export const MAX_QUOTE_LINES = 12;

/** Occurrence sites to enumerate for a duplicate-match failure. */
export const MAX_CANDIDATES = 4;

/** Longest oldText we echo back in a report. Beyond this the model already has
 *  it in context two messages up; repeating it is pure token cost. */
export const MAX_ECHO_CHARS = 400;

export type EditFailure =
  | { kind: "not-found"; editIndex: number | null }
  | { kind: "duplicate"; editIndex: number | null; occurrences: number }
  | { kind: "overlap" }
  | { kind: "no-change" }
  | { kind: "empty" }
  | { kind: "other" };

/** Classify from the message text pi threw. Matching on prose is fragile, so
 *  every branch is keyed to a distinctive stem from edit-diff.js's error
 *  builders, and anything unrecognised falls through to "other" and is left
 *  untouched rather than guessed at. */
export function classify(message: string): EditFailure {
  const idx = message.match(/edits\[(\d+)\]/);
  const editIndex = idx ? Number(idx[1]) : null;

  if (/Could not find (the exact text|edits\[)/.test(message)) {
    return { kind: "not-found", editIndex };
  }
  const dup = message.match(/Found (\d+) occurrences/);
  if (dup) return { kind: "duplicate", editIndex, occurrences: Number(dup[1]) };
  if (/overlap in /.test(message)) return { kind: "overlap" };
  if (/No changes made to /.test(message)) return { kind: "no-change" };
  if (/oldText must not be empty|\.oldText must not be empty/.test(message)) return { kind: "empty" };
  return { kind: "other" };
}

/** Collapse a line to its comparable core: no leading/trailing whitespace, and
 *  interior runs of whitespace flattened to one space. This is the axis pi's
 *  own fuzzy match does not cover. */
export function skeleton(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** True when two texts differ ONLY in whitespace — the case worth calling out
 *  explicitly, because the model's content was right and only its indentation
 *  was wrong. */
export function whitespaceOnlyDifference(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "");
  return a !== b && strip(a) === strip(b);
}

export interface Candidate {
  /** 1-based line number of the first quoted line. */
  startLine: number;
  /** The file's real bytes for this region, verbatim. */
  text: string;
  /** How many of the oldText's lines matched by skeleton. */
  matchedLines: number;
  /** Set when the region differs from oldText only in whitespace. */
  whitespaceOnly: boolean;
}

/** Find where in `content` the model probably MEANT to point.
 *
 *  Anchors on the first non-blank line of oldText compared by skeleton, then
 *  measures how far the run continues. That is deliberately cheap and
 *  indentation-blind: we are not trying to reproduce a diff algorithm, only to
 *  hand back the right neighbourhood with its real bytes. */
export function findCandidates(content: string, oldText: string): Candidate[] {
  const fileLines = content.split("\n");
  const oldLines = oldText.split("\n");

  const anchorOffset = oldLines.findIndex((l) => skeleton(l).length > 0);
  if (anchorOffset === -1) return [];
  const anchor = skeleton(oldLines[anchorOffset]);

  const hits: Candidate[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (skeleton(fileLines[i]) !== anchor) continue;

    // Walk forward while the skeletons keep agreeing, so a near-miss deep in a
    // long block still reports the whole block rather than a single line.
    let matched = 1;
    for (let k = anchorOffset + 1; k < oldLines.length; k++) {
      const fileLine = fileLines[i + (k - anchorOffset)];
      if (fileLine === undefined) break;
      if (skeleton(fileLine) !== skeleton(oldLines[k])) break;
      matched++;
    }

    const start = Math.max(0, i - anchorOffset);
    const end = Math.min(fileLines.length, start + Math.min(oldLines.length, MAX_QUOTE_LINES));
    const text = fileLines.slice(start, end).join("\n");

    hits.push({
      startLine: start + 1,
      text,
      matchedLines: matched,
      whitespaceOnly: whitespaceOnlyDifference(text, oldLines.slice(0, end - start).join("\n")),
    });
  }

  // Best-anchored first, and never more than a handful: the model needs one
  // good region, not an index of the file.
  hits.sort((a, b) => b.matchedLines - a.matchedLines);
  return hits.slice(0, MAX_CANDIDATES);
}

/** 1-based line numbers where `needle` occurs literally in `content`. */
export function occurrenceLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) break;
    lines.push(content.slice(0, at).split("\n").length);
    from = at + Math.max(1, needle.length);
  }
  return lines;
}

/** Quote a region of the file with 1-based line numbers, so the model can name
 *  a unique anchor by pointing at a line rather than re-reading the file. */
export function quote(content: string, startLine: number, count: number): string {
  const lines = content.split("\n");
  const begin = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, begin + count);
  const width = String(end).length;
  return lines
    .slice(begin, end)
    .map((l, i) => `${String(begin + i + 1).padStart(width)} | ${l}`)
    .join("\n");
}

function echo(oldText: string): string {
  return oldText.length > MAX_ECHO_CHARS ? `${oldText.slice(0, MAX_ECHO_CHARS)}…` : oldText;
}

export interface EditArgs {
  path?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
}

/** Build the replacement tool-result text, or null to leave pi's message alone.
 *
 *  Returning null is the right answer whenever we cannot add a fact the model
 *  does not already have — a report that only restates the rule is worse than
 *  the original, because it costs tokens to say nothing. */
export function report(failure: EditFailure, args: EditArgs, content: string | null, original: string): string | null {
  if (content === null) return null;
  const edits = args.edits ?? [];
  const index = "editIndex" in failure && failure.editIndex !== null ? failure.editIndex : 0;
  const oldText = edits[index]?.oldText;

  if (failure.kind === "not-found") {
    if (!oldText) return null;
    const candidates = findCandidates(content, oldText);
    if (candidates.length === 0) {
      return (
        `${original}\n\n` +
        `No region of the file resembles that oldText, even ignoring indentation. ` +
        `The text is probably in a different file, or was already changed by an ` +
        `earlier edit in this session. Re-read the file before trying again.`
      );
    }

    const best = candidates[0];
    const lead = best.whitespaceOnly
      ? `The file DOES contain that text — it differs from your oldText only in whitespace/indentation.`
      : `The closest region of the file is below.`;

    const extra =
      candidates.length > 1
        ? `\n\nOther regions with the same opening line: ${candidates
            .slice(1)
            .map((c) => `line ${c.startLine}`)
            .join(", ")}.`
        : "";

    return (
      `${original}\n\n` +
      `${lead} These are the file's EXACT bytes at line ${best.startLine} — ` +
      `copy from here verbatim into oldText:\n\n` +
      `${quote(content, best.startLine, MAX_QUOTE_LINES)}` +
      `${extra}\n\n` +
      `Your oldText was:\n${echo(oldText)}`
    );
  }

  if (failure.kind === "duplicate") {
    if (!oldText) return null;
    const lines = occurrenceLines(content, oldText);
    if (lines.length === 0) return null;
    const shown = lines.slice(0, MAX_CANDIDATES);
    const blocks = shown
      .map((ln) => `--- occurrence at line ${ln} ---\n${quote(content, Math.max(1, ln - 2), MAX_QUOTE_LINES)}`)
      .join("\n\n");
    const more = lines.length > shown.length ? `\n\n(${lines.length - shown.length} further occurrences not shown.)` : "";
    // Cap the line LIST as well as the quoted blocks. A generated or minified
    // file can match thousands of times, and joining every number produced a
    // 130 KB tool result in testing — the bound below is the whole reason that
    // test exists.
    const listed = lines.length > MAX_CANDIDATES ? `${shown.join(", ")}, …` : lines.join(", ");
    return (
      `${original}\n\n` +
      `It occurs at line${lines.length === 1 ? "" : "s"} ${listed}. ` +
      `Each block below has surrounding context — extend your oldText upward or ` +
      `downward with lines that appear in only ONE of them:\n\n${blocks}${more}`
    );
  }

  if (failure.kind === "no-change") {
    return (
      `${original}\n\n` +
      `oldText and newText produced identical content, so nothing was written. ` +
      `Either the change is already present in the file — re-read it before ` +
      `editing again — or newText repeats oldText unchanged.`
    );
  }

  // overlap / empty / other: pi's own message already names the problem
  // precisely and quoting the file would add nothing.
  return null;
}
