// Load test: loads redcode-btw the SAME way pi loads it — jiti with the
// @earendil-works aliases (pi-tui is nested under pi-coding-agent, so a plain
// import can't resolve it). Then drives the mock ExtensionAPI to prove:
//   1. the extension registers the `btw` command and NO entry renderer —
//      the overlay is the only visible /btw surface (the appended entry is
//      hidden storage for the bare /btw re-show),
//   2. the command's guard paths (no model, bare /btw with no history) don't throw.
//
// Run:  node --experimental-strip-types extensions/redcode-btw/load.test.ts
//       (also discovered and run by `npm test`)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const piPkg = resolve(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

// Aliases mirror pi's dist/core/extensions/loader.js getAliases().
const aliases = {
  "@earendil-works/pi-coding-agent": resolve(piPkg, "dist", "index.js"),
  "@earendil-works/pi-tui": resolve(
    piPkg,
    "node_modules",
    "@earendil-works",
    "pi-tui",
    "dist",
    "index.js",
  ),
  typebox: resolve(piPkg, "node_modules", "typebox", "build", "index.mjs"),
};

const { createJiti } = await import(
  resolve(piPkg, "node_modules", "jiti", "lib", "jiti-static.mjs")
);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
const mod = await jiti.import(resolve(here, "index.ts"), { default: true });

type ComponentLike = { render: (width: number) => string[] };
type Renderer = (
  entry: unknown,
  opts: { expanded: boolean },
  theme: unknown,
) => ComponentLike | undefined;
type CommandSpec = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};
type Calls = {
  commands: Record<string, CommandSpec>;
  renderers: Record<string, Renderer>;
  events: Record<string, Array<() => void>>;
  entries: Array<{ type: string; data: unknown }>;
};

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Mock ExtensionAPI capturing registrations.
const calls: Calls = { commands: {}, renderers: {}, events: {}, entries: [] };
const pi = {
  registerCommand: (name: string, spec: CommandSpec) => {
    calls.commands[name] = spec;
  },
  registerEntryRenderer: (type: string, renderer: Renderer) => {
    calls.renderers[type] = renderer;
  },
  on: (event: string, cb: () => void) => {
    (calls.events[event] ||= []).push(cb);
  },
  getActiveTools: () => ["bash", "read"],
  getAllTools: () => [
    { name: "bash", description: "run", parameters: { type: "object" } },
    { name: "read", description: "read", parameters: { type: "object" } },
  ],
  appendEntry: (type: string, data: unknown) => {
    calls.entries.push({ type, data });
  },
};

check("default export is the extension fn", typeof mod === "function");
mod(pi); // run the extension body against the mock

check("registers the btw command", !!calls.commands.btw);
check("btw command has a handler", typeof calls.commands.btw?.handler === "function");
check(
  "registers NO entry renderer (overlay is the only visible /btw surface)",
  calls.renderers["redcode-btw"] === undefined,
);
check(
  "hooks session lifecycle for abort",
  ["session_start", "session_shutdown"].every((e) => calls.events[e]?.length),
);

// Guard path 1: no model selected.
{
  const ctx = { hasUI: false, model: undefined, sessionManager: { getEntries: () => [] } };
  let threw = false;
  try {
    await calls.commands.btw.handler("why btrfs?", ctx);
  } catch (e) {
    threw = true;
  }
  check("no-model guard does not throw", !threw);
}

// Guard path 2: bare /btw with no history.
{
  const ctx = { hasUI: false, model: undefined, sessionManager: { getEntries: () => [] } };
  let threw = false;
  try {
    await calls.commands.btw.handler("", ctx);
  } catch (e) {
    threw = true;
  }
  check("bare /btw (no history) does not throw", !threw);
}

console.log(`load.test: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}