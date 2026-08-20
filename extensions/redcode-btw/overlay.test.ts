// Overlay integration test: loads redcode-btw the SAME way pi loads it
// (jiti + the @earendil-works aliases), then drives the /btw command against
// a mocked ctx whose ui.custom captures the overlay factory. A fake,
// abort-aware provider stream feeds the answer, and the test asserts:
//   1. the overlay opens with overlay:true + 90%/70% sizing options,
//   2. frames progress waiting → thinking → streaming → done,
//   3. the finished answer lands as a transcript entry,
//   4. the handler only resolves when the user dismisses (esc) the panel,
//   5. esc WHILE streaming cancels the side call (no entry, lane freed),
//   6. bare /btw re-shows the last Q&A in the same panel (enter closes).
//
// Run:  node --experimental-strip-types extensions/redcode-btw/overlay.test.ts
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

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- mock TUI
const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};
const tui = {
  terminal: { rows: 40, columns: 120 },
  requestRender: () => {},
};

// Captures each ui.custom call: the component, the options, and a done() the
// test can invoke (or the component's handleInput will call). done() mirrors
// pi's showExtensionCustom.close(): resolve, then dispose the component (that
// is what stops the spinner timer and lets the process exit).
let overlay: {
  comp: any;
  opts: any;
  done: () => void;
  closed: boolean;
} | undefined;
const custom = async (factory: any, opts: any): Promise<unknown> => {
  let resolveClose: () => void;
  const closePromise = new Promise<void>((r) => (resolveClose = r));
  const done = () => {
    if (!overlay) return;
    overlay.closed = true;
    overlay.comp.dispose?.();
    resolveClose();
  };
  const comp = factory(tui, theme, {}, done);
  overlay = { comp, opts, done, closed: false };
  return closePromise;
};

// --------------------------------------------------------- mock ctx + stream
let streamEvents: any[] = [];
let sawAbort = false;

const providerStream = (_model: any, _context: any, options: any) => {
  const gen = async function* () {
    for (const ev of streamEvents) {
      await sleep(ev.delay ?? 10);
      if (options?.signal?.aborted) {
        sawAbort = true;
        return;
      }
      yield ev;
    }
  }();
  return gen;
};

const entries: Array<{ type: string; customType: string; data: unknown }> = [];
const pi = {
  registerCommand: (_name: string, spec: any) => (pi as any).handler = spec.handler,
  registerEntryRenderer: () => {},
  on: () => {},
  getActiveTools: () => ["bash"],
  getAllTools: () => [{ name: "bash", description: "run", parameters: { type: "object" } }],
  appendEntry: (type: string, data: unknown) =>
    entries.push({ type: "custom", customType: type, data }),
};
let loadThrew = false;
try {
  mod(pi);
} catch {
  loadThrew = true;
}
check("extension loads and runs", typeof mod === "function" && !loadThrew);
const handler: (args: string, ctx: any) => Promise<void> = (pi as any).handler;
check("registers the btw command", typeof handler === "function");

const ctx: any = {
  hasUI: true,
  model: { id: "qwen3.8-27b-nvfp4", provider: "ninfer" },
  thinkingLevel: "xhigh",
  modelRegistry: {
    getProvider: () => ({ stream: providerStream }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  },
  getSystemPrompt: () => "SYSTEM PROMPT",
  sessionManager: {
    buildSessionContext: () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
      ],
    }),
    getEntries: () => entries,
  },
  ui: { theme, notify: () => {}, custom },
};

// ------------------------------------------------- 1: happy path (done + esc)
{
  streamEvents = [
    { type: "thinking_delta", delta: "hmm", delay: 80 },
    { type: "text_delta", delta: "alpha " },
    { type: "text_delta", delta: "beta gamma" },
    {
      type: "done",
      reason: "stop",
      message: { content: [{ type: "text", text: "alpha beta gamma" }] },
    },
  ];
  sawAbort = false;
  const p = handler("What is the answer?", ctx);

  await sleep(25); // before the first stream event (delay 80)
  check("overlay opened", !!overlay);
  check("overlay:true option", overlay?.opts?.overlay === true);
  check(
    "90%/70% sizing options",
    overlay?.opts?.overlayOptions?.width === "90%" &&
      overlay?.opts?.overlayOptions?.maxHeight === "70%",
  );
  let frame = overlay?.comp.render(108).join("\n") ?? "";
  check(
    "waiting frame shows the spinner line",
    frame.includes("waiting for first token") && frame.includes("esc to cancel"),
  );
  check("frame stays within the 70% height cap", overlay?.comp.render(108).length <= 28);

  await sleep(70); // thinking_delta arrived
  frame = overlay?.comp.render(108).join("\n") ?? "";
  check("thinking frame says thinking…", frame.includes("thinking…"));

  await sleep(40); // text deltas arrived
  frame = overlay?.comp.render(108).join("\n") ?? "";
  check("streaming frame shows the answer tail", frame.includes("alpha") && frame.includes("beta gamma"));

  await sleep(30); // done
  frame = overlay?.comp.render(108).join("\n") ?? "";
  check(
    "done frame shows the full answer + close hint",
    frame.includes("alpha beta gamma") && frame.includes("esc / enter to close"),
  );
  check("entry recorded with the answer", entries.length === 1 && (entries[0].data as any).answer === "alpha beta gamma");

  let resolved = false;
  p.then(() => (resolved = true));
  await sleep(30);
  check("handler waits for the user to dismiss", !resolved);
  overlay?.comp.handleInput("\x1b");
  await sleep(30);
  check("esc closes the finished panel (handler resolves)", resolved && overlay?.closed === true);
}

// ------------------------------------------- 2: esc mid-stream cancels the call
{
  streamEvents = [
    { type: "text_delta", delta: "x", delay: 20 },
    { type: "text_delta", delta: "y", delay: 20 },
    { type: "text_delta", delta: "z", delay: 20 },
    { type: "text_delta", delta: "w", delay: 20 },
    { type: "text_delta", delta: "v", delay: 20 },
  ];
  sawAbort = false;
  const p = handler("Second question", ctx);
  await sleep(45); // mid-stream
  const frame = overlay?.comp.render(108).join("\n") ?? "";
  check("mid-stream frame is live", frame.includes("x"));
  overlay?.comp.handleInput("\x1b");
  await sleep(60);
  let resolved = false;
  await p.then(() => (resolved = true));
  check("esc mid-stream resolves the handler", resolved);
  check("the abort signal reached the stream", sawAbort);
  check("no entry recorded for a cancelled call", entries.length === 1);

  // Lane freed: the next /btw must run.
  streamEvents = [
    { type: "text_delta", delta: "ok" },
    { type: "done", reason: "stop", message: { content: [{ type: "text", text: "ok" }] } },
  ];
  const p2 = handler("Third question", ctx);
  await sleep(50);
  check("a new /btw runs after a cancel (concurrency guard released)", entries.length === 2);
  overlay?.comp.handleInput("\r"); // enter closes a done panel
  await p2;
  await sleep(30);
  check("enter closes the done panel", overlay?.closed === true);
}

// ------------------------------------------------- 3: bare /btw re-show
{
  const p = handler("", ctx);
  await sleep(30);
  const frame = overlay?.comp.render(108).join("\n") ?? "";
  check(
    "re-show panel shows the last Q&A",
    frame.includes("last side question") &&
      frame.includes("Third question") &&
      frame.includes("ok"),
  );
  overlay?.comp.handleInput(" "); // space also closes (house behaviour)
  await p;
  await sleep(30);
  check("space closes the re-show panel", overlay?.closed === true);
}

console.log(`overlay.test: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}