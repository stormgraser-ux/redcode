// cd — /cd <dir> moves this live session to a different project directory.
//
// Pi binds a session to a directory at session start: tools, AGENTS.md,
// skills, settings, and project trust are all resolved against that cwd
// and there is no API to rebind a running session in place. So /cd performs
// the move the way pi's own cross-project flow does (`pi --session <file
// from another project>`):
//
//   1. Fork the current session's full history into the target project's
//      session directory (SessionManager.forkFrom — a new file whose
//      header records cwd = target and parentSession = the source file).
//   2. Switch to the forked session (ctx.switchSession — the same code
//      path as the built-in /resume). Pi reads the forked header, sees
//      cwd = target, and rebuilds the entire runtime against it: tools run
//      in the new directory, AGENTS.md/skills/.pi are reloaded from there,
//      settings re-resolve, project trust re-checks, and the model is
//      restored from the session history. (The snapshot is taken from the
//      in-memory session manager, not the session file, because the file is
//      created lazily and can lag behind the live state.)
//
// The original session file stays untouched (the fork points back at it as
// parentSession). Moving back and forth creates one fork file per hop, and
// /resume in either project lists them.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export default function (pi: ExtensionAPI) {
  // Tab-completion: offer project directories under the projects root while the
  // user is typing a bare name. As soon as the prefix looks like a real path
  // (~, /, or .), step back and let them type it.
  //
  // The root is a convenience, not a restriction — any path still works by
  // typing it out. It is configurable because "all my projects sit in one
  // directory" is a habit rather than a rule, and ~/code is only the author's.
  // If neither the override nor ~/code exists, completion turns itself off.
  const projectRoot = expandTilde(process.env.REDCODE_PROJECTS ?? join(homedir(), "code"));

  pi.registerCommand("cd", {
    description: "Move this session to another project directory (keeps full history)",
    getArgumentCompletions: (prefix: string) => {
      if (!existsSync(projectRoot) || /[/~.]/.test(prefix)) return null;
      let dirs: string[];
      try {
        dirs = readdirSync(projectRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter((n) => n.startsWith(prefix));
      } catch {
        return null;
      }
      return dirs.length > 0 ? dirs.map((d) => ({ value: d, label: d })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        if (ctx.hasUI) ctx.ui.notify(`cwd: ${ctx.cwd}  —  /cd <directory> to move this session`, "info");
        return;
      }

      // Relative paths resolve against the session's current project dir.
      const target = resolve(ctx.cwd, expandTilde(arg));
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        if (ctx.hasUI) ctx.ui.notify(`Not a directory: ${target}`, "error");
        return;
      }
      if (resolve(ctx.cwd) === target) {
        if (ctx.hasUI) ctx.ui.notify(`Already here: ${target}`, "info");
        return;
      }

      // Don't tear down the runtime mid-turn; settle first.
      await ctx.waitForIdle();
      if (ctx.hasUI) ctx.ui.notify(`Moving session to ${target} ...`, "info");

      // Snapshot the full conversation into a temp file from the in-memory
      // session manager — authoritative even when the session file hasn't
      // been flushed to disk yet (it is created lazily on first append) —
      // then fork that snapshot into the target project's session dir.
      const tmpFile = `/tmp/pi-cd-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: ctx.sessionManager.getSessionId(),
        timestamp: new Date().toISOString(),
        cwd: ctx.cwd,
      };
      const lines = [JSON.stringify(header)];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "session") lines.push(JSON.stringify(entry));
      }
      writeFileSync(tmpFile, lines.join("\n") + "\n");

      // Full history into the target project's session directory.
      let forkedFile: string;
      try {
        forkedFile = SessionManager.forkFrom(tmpFile, target).getSessionFile()!;
        // forkFrom recorded the temp snapshot as parentSession; repoint the
        // provenance at the real session file if it is on disk, or drop it
        // if not (a dangling temp path would be worse).
        const originalFile = ctx.sessionManager.getSessionFile();
        if (originalFile) {
          const lines = readFileSync(forkedFile, "utf8").split("\n");
          const header = JSON.parse(lines[0]);
          if (originalFile && existsSync(originalFile)) {
            header.parentSession = originalFile;
          } else {
            delete header.parentSession;
          }
          lines[0] = JSON.stringify(header);
          writeFileSync(forkedFile, lines.join("\n"));
        }
      } finally {
        rmSync(tmpFile, { force: true });
      }

      // Switch the runtime to the forked session. Pi reads its header
      // (cwd = target) and rebuilds everything against the new directory.
      // Post-switch work must use the ctx handed to withSession — the old
      // one is stale after the swap.
      const result = await ctx.switchSession(forkedFile, {
        withSession: async (next) => {
          if (next.hasUI) next.ui.notify(`Now in ${next.cwd} — history kept, original session untouched`, "info");
        },
      });
      if (result.cancelled) {
        // An extension cancelled the switch: no swap happened, so the old
        // ctx is still alive.
        if (ctx.hasUI) ctx.ui.notify("Move cancelled", "info");
      }
    },
  });
}