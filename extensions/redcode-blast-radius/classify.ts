// classify.ts — decide the blast radius of a bash command.
//
// No pi imports on purpose: this is pure logic so it can be unit-tested
// directly with `node --experimental-strip-types test.ts`.
//
// PARSING IS A HEURISTIC AND THE FAILURE MODE IS DELIBERATE. Shell is not
// reliably parseable without running it, so anything this cannot resolve with
// confidence (command substitution, an unexpanded variable, an unresolvable
// glob) escalates to "prompt" rather than "allow". A false prompt costs a
// keypress; a false allow costs a directory.

import {
  type Anchor,
  type Verdict,
  anchors,
  alwaysDeny,
  scratch,
  CATASTROPHIC,
  GUARD_DESTRUCTIVE_GIT,
  HOME_FALLBACK_PROMPT_DEPTH,
} from "./policy.ts";

export interface Finding {
  verdict: Verdict;
  reason: string;
  target?: string;
  command: string;
}

const RANK: Record<Verdict, number> = { allow: 0, prompt: 1, deny: 2 };

// ---------------------------------------------------------------------------
// path handling
// ---------------------------------------------------------------------------

// Returns null when the path cannot be resolved, rather than a sentinel
// string. This used to return a NUL-prefixed marker, on the reasoning that a
// NUL can never appear in a real path — true, but it made the whole file
// binary to git (no diffs, no review) and any editor that strips control
// characters would have silently turned "unresolvable" into a plausible
// relative path. In a guardrail, that failure mode is open, not closed.
function normalise(p: string): string | null {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Popping past the root of a relative path makes the target unknowable,
      // so refuse it rather than silently resolving to something shallower.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}

/** Expand ~ and $HOME, then resolve against cwd. Returns null when the path
 *  cannot be resolved confidently. */
export function resolvePath(raw: string, cwd: string, home: string): string | null {
  let p = raw.trim();
  if (p === "") return null;

  // Strip one layer of surrounding quotes.
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }

  // Command substitution or an arbitrary variable: unknowable.
  if (/\$\(|`/.test(p)) return null;
  p = p.replace(/\$\{?HOME\}?/g, home);
  if (/\$[A-Za-z_{]/.test(p)) return null;

  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + p.slice(1);
  else if (p.startsWith("~")) return null; // ~otheruser

  if (!p.startsWith("/")) p = `${cwd}/${p}`;

  return normalise(p);
}

/** A glob deletes everything matching it, so its blast radius is its parent
 *  directory. `~/code/*` is therefore judged exactly as `~/code`. */
export function globToParent(raw: string): { path: string; wasGlob: boolean } {
  if (!/[*?\[]/.test(raw)) return { path: raw, wasGlob: false };
  const idx = raw.search(/[*?\[]/);
  const cut = raw.lastIndexOf("/", idx);
  return { path: cut <= 0 ? raw.slice(0, Math.max(cut, 1)) || "/" : raw.slice(0, cut), wasGlob: true };
}

function depthUnder(target: string, root: string): number | null {
  if (target === root) return 0;
  if (!target.startsWith(root.endsWith("/") ? root : `${root}/`)) return null;
  const rest = target.slice(root.length).replace(/^\//, "");
  return rest === "" ? 0 : rest.split("/").length;
}

// ---------------------------------------------------------------------------
// the core question: how much does deleting this path destroy?
// ---------------------------------------------------------------------------

export function classifyPath(
  target: string,
  home: string,
): { verdict: Verdict; reason: string } {
  const deny = alwaysDeny(home);

  // Exact match on a protected root, or an ancestor of one. `rm -rf /home`
  // is an ancestor of $HOME and must die here.
  for (const d of deny) {
    if (target === d) return { verdict: "deny", reason: `${d} is a protected root` };
  }
  for (const d of deny) {
    if (d !== "/" && depthUnder(d, target) !== null) {
      return { verdict: "deny", reason: `it contains the protected root ${d}` };
    }
  }

  // An ancestor of any anchor is at least as dangerous as the anchor.
  const list: Anchor[] = anchors(home);
  for (const a of list) {
    if (target !== a.path && depthUnder(a.path, target) !== null) {
      return { verdict: "deny", reason: `it contains ${a.path} (${a.why})` };
    }
  }

  // Scratch trees: free below the top level.
  for (const s of scratch(home)) {
    const d = depthUnder(target, s);
    if (d === null) continue;
    if (d === 0) return { verdict: "deny", reason: `${s} is a protected root` };
    return { verdict: "allow", reason: `scratch space under ${s}` };
  }

  // Anchored trees, deepest anchor wins so ~/.config beats the $HOME fallback.
  let best: { a: Anchor; d: number } | null = null;
  for (const a of list) {
    const d = depthUnder(target, a.path);
    if (d === null) continue;
    if (!best || a.path.length > best.a.path.length) best = { a, d };
  }
  if (best) {
    const { a, d } = best;
    if (d === 0) return { verdict: "deny", reason: `${a.path} is ${a.why}` };
    if (d <= a.promptDepth) return { verdict: "prompt", reason: `${a.why} under ${a.path}` };
    return { verdict: "allow", reason: `depth ${d} under ${a.path}` };
  }

  // Unanchored but under $HOME.
  const dh = depthUnder(target, home);
  if (dh !== null) {
    if (dh === 0) return { verdict: "deny", reason: "$HOME itself" };
    if (dh <= HOME_FALLBACK_PROMPT_DEPTH)
      return { verdict: "prompt", reason: "a top-level directory in $HOME" };
    return { verdict: "allow", reason: `depth ${dh} under $HOME` };
  }

  // Anything *inside* a system root. This runs after the $HOME handling above,
  // which returns for every path under $HOME, so /home cannot reach here and
  // shadow the anchors. Without this, `rm -rf /etc/nginx` would only prompt:
  // the earlier checks catch ancestors of a protected root but not descendants.
  for (const d of deny) {
    if (d === "/") continue;
    if (depthUnder(target, d) !== null) {
      return { verdict: "deny", reason: `inside the protected system tree ${d}` };
    }
  }

  // Outside $HOME and outside every scratch tree. Rare and worth a look.
  return { verdict: "prompt", reason: "outside $HOME" };
}

// ---------------------------------------------------------------------------
// shell splitting
// ---------------------------------------------------------------------------

/** Split a command line into segments on ; && || | and newlines, respecting
 *  quotes. */
export function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\n" || c === ";") { out.push(cur); cur = ""; continue; }
    if ((c === "&" || c === "|") && command[i + 1] === c) { out.push(cur); cur = ""; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tokenise one segment, keeping quotes so resolvePath can strip them. */
export function tokenise(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      cur += c;
      if (c === quote && seg[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// command inspection
// ---------------------------------------------------------------------------

function stripPrefixes(tokens: string[]): string[] {
  const t = [...tokens];
  // sudo/env/nice wrappers and VAR=value assignments.
  while (t.length) {
    const head = t[0];
    if (head === "sudo" || head === "doas" || head === "env" || head === "nice" || head === "nohup" ||
        head === "time" || head === "command" || head === "xargs") {
      t.shift();
      while (t.length && t[0].startsWith("-")) t.shift();
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { t.shift(); continue; }
    break;
  }
  return t;
}

function baseName(cmd: string): string {
  const c = cmd.replace(/^["']|["']$/g, "");
  return c.slice(c.lastIndexOf("/") + 1);
}

function isRecursiveRm(flags: string[]): boolean {
  for (const f of flags) {
    if (f === "--recursive") return true;
    if (f.startsWith("--")) continue;
    if (f.startsWith("-") && /[rR]/.test(f.slice(1))) return true;
  }
  return false;
}

export function classifyCommand(command: string, cwd: string, home: string): Finding[] {
  const findings: Finding[] = [];

  for (const seg of segments(command)) {
    const raw = tokenise(seg);
    const tokens = stripPrefixes(raw);
    if (tokens.length === 0) continue;
    const cmd = baseName(tokens[0]);
    const rest = tokens.slice(1);
    const flags = rest.filter((t) => t.startsWith("-"));
    const operands = rest.filter((t) => !t.startsWith("-"));

    // --- filesystem/device destroyers: never acceptable -------------------
    if (CATASTROPHIC.some((c) => cmd === c || cmd.startsWith(`${c}.`))) {
      findings.push({ verdict: "deny", reason: `${cmd} destroys a filesystem or device`, command: seg });
      continue;
    }
    if (cmd === "dd" && rest.some((t) => /^of=\/dev\//.test(t))) {
      findings.push({ verdict: "deny", reason: "dd writing to a block device", command: seg });
      continue;
    }

    // --- rm ---------------------------------------------------------------
    if (cmd === "rm") {
      if (flags.includes("--no-preserve-root")) {
        findings.push({ verdict: "deny", reason: "--no-preserve-root", command: seg });
        continue;
      }
      // A non-recursive rm cannot remove a directory tree. Leave it alone.
      if (!isRecursiveRm(flags)) continue;
      if (operands.length === 0) continue;

      for (const op of operands) {
        const { path: base, wasGlob } = globToParent(op);
        const resolved = resolvePath(base, cwd, home);
        if (resolved === null) {
          findings.push({
            verdict: "prompt",
            reason: "target could not be resolved (variable, subshell or ~user)",
            target: op,
            command: seg,
          });
          continue;
        }
        const { verdict, reason } = classifyPath(resolved, home);
        findings.push({
          verdict,
          reason: wasGlob ? `${reason} — glob expands inside it` : reason,
          target: resolved,
          command: seg,
        });
      }
      continue;
    }

    // --- recursive permission/ownership changes ---------------------------
    if ((cmd === "chmod" || cmd === "chown" || cmd === "chgrp") &&
        flags.some((f) => f === "--recursive" || (!f.startsWith("--") && f.includes("R")))) {
      // First operand is the mode/owner, the rest are paths.
      for (const op of operands.slice(1)) {
        const resolved = resolvePath(globToParent(op).path, cwd, home);
        if (resolved === null) {
          findings.push({ verdict: "prompt", reason: `recursive ${cmd} on an unresolved path`, target: op, command: seg });
          continue;
        }
        const { verdict, reason } = classifyPath(resolved, home);
        // A recursive chmod is destructive but reversible, so it never exceeds
        // prompt unless it hits a protected root.
        findings.push({ verdict, reason: `recursive ${cmd}: ${reason}`, target: resolved, command: seg });
      }
      continue;
    }

    // --- find -delete / find -exec rm -------------------------------------
    if (cmd === "find" && (rest.includes("-delete") || /-exec\s/.test(seg) && /\brm\b/.test(seg))) {
      const root = operands[0] ?? ".";
      const resolved = resolvePath(root, cwd, home);
      if (resolved === null) {
        findings.push({ verdict: "prompt", reason: "find deleting under an unresolved root", command: seg });
      } else {
        const { verdict, reason } = classifyPath(resolved, home);
        findings.push({ verdict, reason: `find deletes under this root: ${reason}`, target: resolved, command: seg });
      }
      continue;
    }

    // --- git history/worktree destroyers ----------------------------------
    if (GUARD_DESTRUCTIVE_GIT && cmd === "git") {
      const isReset = rest.includes("reset") && rest.includes("--hard");
      const isClean = rest.includes("clean") && flags.some((f) => !f.startsWith("--") && f.includes("f"));
      if (isReset || isClean) {
        findings.push({
          verdict: "prompt",
          reason: isReset
            ? "git reset --hard discards uncommitted work"
            : "git clean -f deletes untracked files",
          command: seg,
        });
      }
      continue;
    }
  }

  return findings;
}

/** A concrete narrower alternative to offer when a command is refused.
 *
 *  Used during unattended goal runs, where prompt-tier escalates to deny and
 *  there is nobody to ask. A bare refusal tends to make the model retry the
 *  same command or give up on the task; naming the safer shape it should have
 *  used turns the block into a course correction. */
export function suggestion(f: Finding): string | null {
  const t = f.target;
  if (!t) {
    if (/git reset --hard/.test(f.command)) {
      return "To discard specific changes, use `git restore <path>` or commit to a scratch branch first.";
    }
    if (/git clean/.test(f.command)) {
      return "To remove specific untracked files, delete them individually, or preview with `git clean -n` first.";
    }
    return null;
  }
  if (/rm\b/.test(f.command)) {
    return (
      `Delete a specific subdirectory or file inside \`${t}\` instead of the whole tree ` +
      `(for example \`${t}/build\`), or list it with \`ls ${t}\` first to confirm the intended target.`
    );
  }
  if (/chmod|chown|chgrp/.test(f.command)) {
    return `Apply the change to a specific path inside \`${t}\` rather than recursing over all of it.`;
  }
  if (/find/.test(f.command)) {
    return `Narrow the find root below \`${t}\`, and run it without \`-delete\` first to see what would match.`;
  }
  return null;
}

/** The overall verdict for a command is its worst finding. */
export function worst(findings: Finding[]): Finding | null {
  let out: Finding | null = null;
  for (const f of findings) {
    if (f.verdict === "allow") continue;
    if (!out || RANK[f.verdict] > RANK[out.verdict]) out = f;
  }
  return out;
}
