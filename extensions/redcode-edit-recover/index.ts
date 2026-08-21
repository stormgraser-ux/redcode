// redcode-edit-recover — make a failed `edit` recoverable in one turn.
//
// THE PROBLEM. pi's edit tool matches oldText exactly (after a normalisation
// pass for trailing whitespace, smart quotes and NFKC). When the match misses,
// every error it can raise is a restatement of the rule:
//
//     Could not find edits[0] in foo.ts. The oldText must match exactly
//     including all whitespace and newlines.
//     Found 3 occurrences of the text in foo.ts. The text must be unique.
//     Please provide more context to make it unique.
//
// Not one byte of the file comes back. The model's only move is to re-read the
// file and guess again — often several times — and the redcode note
// `pi-edit-needs-exact-oldtext` records the consequence: a run of failed edits
// reads as the model getting worse, and the instinct is to blame the quant or
// the context length. It is a whitespace mismatch with an uninformative error.
//
// WHAT THIS DOES. On an `edit` failure it re-reads the file itself and rewrites
// the tool result to carry the file's REAL bytes at the place the model meant:
// the nearest indentation-blind match for a not-found, or every occurrence with
// disambiguating context for a duplicate. The model re-issues once, from
// quoted text, instead of guessing.
//
// It does NOT re-apply the edit itself. See the note in recover.ts: the edit
// tool serialises writes through `withFileMutationQueue`, and writing the same
// path from this hook would run outside that queue. One extra round-trip is
// cheaper than a concurrency hazard.
//
// CACHE SAFETY. This only ever rewrites a tool RESULT, which pi persists
// verbatim and never regenerates, so the prompt prefix is untouched — see the
// redcode note `tool-result-hook-is-cache-safe`. Nothing here runs on the
// success path: a successful edit returns before any I/O.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify, report, type EditArgs } from "./recover.ts";

/** Refuse to read anything enormous into a tool result. Well above any real
 *  source file, well below anything that could hurt. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function readTarget(path: string, cwd: string | undefined): string | null {
  try {
    const abs = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
    const buf = readFileSync(abs);
    if (buf.byteLength > MAX_FILE_BYTES) return null;
    return buf.toString("utf-8");
  } catch {
    // Unreadable or gone — that is itself the likely cause, and pi's message
    // already says the file could not be edited. Leave it alone.
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event: any, ctx: any) => {
    if (event?.toolName !== "edit" || !event?.isError) return;

    const original = textOf(event.content).trim();
    if (!original) return;

    const failure = classify(original);
    if (failure.kind === "other") return;

    const args = (event.input ?? {}) as EditArgs & { file_path?: string };
    const path = args.path ?? args.file_path;
    if (!path) return;

    const content = readTarget(path, ctx?.cwd);
    const improved = report(failure, args, content, original);
    if (!improved) return;

    return { content: [{ type: "text", text: improved }] };
  });
}
