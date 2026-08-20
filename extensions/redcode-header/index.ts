// redcode-header — replace pi's startup banner with the crimson masthead and
// the few facts that are true of THIS session.
//
// WHY THIS IS NOT THE LOCALOPS HEADER. The original asserted one specific
// machine's inference engine against a baseline: argv-derived context size, KV
// dtype, draft depth, nvidia-smi peers. That is the right header for the box
// running the model and a misleading one for anybody else — a guest's GPU is
// not doing the work, and a "ctx 153600 !" warning about someone else's server
// is noise they cannot act on. So none of it is here.
//
// What replaces it is the same question asked portably: IS THIS SESSION WHAT I
// THINK IT IS? For a redcode user that means which endpoint is answering,
// which model, where they are, and what got auto-loaded into the prompt before
// they typed anything. All four are things you act on and all four are wrong
// often enough to be worth stating.
//
// It is a STATIC SNAPSHOT taken at session start, deliberately: it describes
// how this session began, which is what you want to look back at when
// something goes odd later in it. Re-take it with /header.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { build, type Snapshot } from "./layout.ts";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "redcode.json");

function sh(cmd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
  });
}

/** Shorten a path for display without lying about it. */
function tilde(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Which endpoint this session is actually pointed at.
 *
 *  Read from config rather than asked of the server: this is a snapshot of how
 *  the session began, and a live probe would block startup on a server that
 *  happens to be down.
 *
 *  The endpoint is selected by pi's `defaultProvider`, NOT by whichever one
 *  /connect saved last. With two endpoints configured those are different
 *  answers, and a header confidently naming the wrong server is worse than no
 *  header at all — every number below it would be attributed to the wrong box.
 *  Falling back to the only entry is safe; falling back to the last of several
 *  is a guess, so that case says so instead. */
function readEndpoint(notes: string[]): Snapshot["endpoint"] {
  let endpoints: any[];
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    endpoints = Array.isArray(cfg?.endpoints) ? cfg.endpoints : [];
  } catch {
    return undefined;
  }
  if (endpoints.length === 0) return undefined;

  let provider = "";
  let model: string | undefined;
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
    );
    provider = String(settings?.defaultProvider ?? "");
    model = settings?.defaultModel ? String(settings.defaultModel) : undefined;
  } catch {
    /* no settings yet: a brand new install is allowed to have none */
  }

  let chosen = endpoints.find((e) => String(e?.name ?? "") === provider);
  if (!chosen) {
    if (provider && endpoints.length > 1) {
      notes.push(`provider "${provider}" is not one of the configured endpoints`);
    }
    chosen = endpoints[0];
    if (endpoints.length > 1 && !provider) {
      notes.push(`${endpoints.length} endpoints configured; showing the first`);
    }
  }

  let host = String(chosen.baseUrl ?? "");
  try {
    host = new URL(host).host;
  } catch {
    /* keep whatever was configured; still more use than nothing */
  }
  return { name: String(chosen.name ?? "endpoint"), host, model };
}

/** The context files pi auto-loads, nearest-last, exactly as it resolves them. */
function readContextFiles(cwd: string): string[] {
  const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const pick = (dir: string): string | null => {
    for (const c of candidates) {
      const p = join(dir, c);
      try {
        readFileSync(p, "utf8");
        return p;
      } catch {
        /* absent */
      }
    }
    return null;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  push(pick(join(homedir(), ".pi", "agent")));

  const ancestors: string[] = [];
  let dir = cwd;
  for (;;) {
    const hit = pick(dir);
    if (hit) ancestors.unshift(hit);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const a of ancestors) push(a);
  return out.map(tilde);
}

async function gather(cwd: string): Promise<Snapshot> {
  const snap: Snapshot = { cwd: tilde(cwd), context: readContextFiles(cwd), notes: [] };

  snap.endpoint = readEndpoint(snap.notes);

  const branch = await sh("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    const root = await sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const status = await sh("git", ["-C", cwd, "status", "--porcelain"]);
    // No upstream is normal on a local branch, so a failure here is not an error.
    const counts = await sh("git", ["-C", cwd, "rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
    snap.repo = {
      // Split on both separators: git reports forward slashes even on Windows,
      // but this must not depend on that staying true.
      name: root.split(/[\\/]/).pop() || "?",
      branch,
      dirty: status ? status.split("\n").filter(Boolean).length : 0,
      ahead: ahead || 0,
      behind: behind || 0,
    };
  }

  return snap;
}

export default function (pi: ExtensionAPI) {
  let snap: Snapshot | null = null;

  const install = async (ctx: any) => {
    if (ctx.mode !== "tui") return;
    // Gathered BEFORE setHeader because the factory is synchronous and git is
    // not. Rendering from a prepared snapshot also makes "static" literally
    // true rather than incidentally true.
    snap = await gather(process.cwd());
    ctx.ui.setHeader((_tui: any, theme: Theme) => ({
      render(width: number): string[] {
        return snap ? build(theme as any, snap, width) : [];
      },
      invalidate() {},
    }));
  };

  pi.on("session_start", async (_e, ctx) => {
    await install(ctx);
  });

  pi.registerCommand("header", {
    description: "Re-take the header snapshot",
    handler: async (_args, ctx) => {
      await install(ctx);
      ctx.ui.notify("header refreshed", "info");
    },
  });

  pi.registerCommand("builtin-header", {
    description: "Restore pi's built-in header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
