// Behavioural test of the LOCALOPS-MIDCHAIN-COMPACTION patch, driving the real
// patched AgentSession.shouldStopAfterTurn with synthetic turns. Run after any
// pi upgrade, once scripts/pi-patch reports success:
//
//   node scripts/pi-patch-test.mjs
//
// A green pi-patch only proves the anchors matched. This proves the hook fires
// at the threshold, latches, and ignores everything it should.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolved rather than hardcoded: the pi-node directory carries a Node version
// in its name and moves on every runtime bump.
// Ask npm where the package lives rather than shelling out to `which`, which
// is not a Windows program. Same resolution order as scripts/pi-patch.
const npmRoot = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}).trim();
const piDist = join(npmRoot, "@earendil-works", "pi-coding-agent", "dist");
const { createAgentSession, SessionManager } = await import(
  pathToFileURL(join(piDist, "index.js")).href
);

const { session } = await createAgentSession({
  cwd: process.cwd(),
  sessionManager: SessionManager.inMemory(),
});

const hook = session.agent.shouldStopAfterTurn;
let pass = 0;
const fails = [];
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

check("hook is installed", typeof hook === "function");
if (typeof hook !== "function") {
  console.log("FAILED: patch did not install the hook");
  process.exit(1);
}

let model = session.model;
if (!model?.contextWindow) {
    // A fresh machine has no usable model configured (no provider key, or a
    // provider only known to extensions this bare session does not load).
    // The hook under test reads exactly one thing off the session's model —
    // contextWindow — so hand it one. `session.model` is a getter over
    // agent.state.model; setModel() is not an option, it validates auth.
    model = { id: "synthetic", contextWindow: 204800 };
    session.agent.state.model = model;
}
console.log(`model: ${model.id} ctx=${model.contextWindow.toLocaleString()}`);
const win = model.contextWindow;
const reserve = 16384;
const threshold = win - reserve;
console.log(`threshold: ${threshold.toLocaleString()}`);

const turn = (tokens, stopReason = "toolUse", role = "assistant") => ({
  message: { role, stopReason, usage: { totalTokens: tokens, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } },
  toolResults: [],
  context: {},
  newMessages: [],
});

const reset = () => { session._midChainCompactionAttempted = false; session._midChainCompactionPending = false; };

// 1. Below the threshold: the chain must run on untouched.
reset();
check("below threshold does not stop", (await hook(turn(threshold - 5000))) !== true);
check("nothing armed below threshold", session._midChainCompactionPending === false);

// 2. Over the threshold mid-chain: stop and arm.
reset();
check("over threshold stops the chain", (await hook(turn(threshold + 1000))) === true);
check("pending flag armed", session._midChainCompactionPending === true);
check("attempted latch set", session._midChainCompactionAttempted === true);

// 3. The latch prevents an infinite stop/continue loop within one user turn.
check("does not re-arm after attempting", (await hook(turn(threshold + 9000))) !== true);

// 4. Only mid-chain stops. error/length/aborted belong to the overflow path,
//    and a run that is ending already reaches the existing check.
for (const sr of ["stop", "length", "error", "aborted"]) {
  reset();
  check(`stopReason=${sr} is ignored`, (await hook(turn(threshold + 9000, sr))) !== true);
}

// 5. Non-assistant and usage-less messages must not throw or trigger.
reset();
check("toolResult role ignored", (await hook(turn(threshold + 9000, "toolUse", "toolResult"))) !== true);
reset();
check("missing usage ignored", (await hook({ message: { role: "assistant", stopReason: "toolUse" } })) !== true);
reset();
check("empty turn ignored", (await hook({})) !== true);
reset();
check("undefined turn does not throw", (await hook(undefined).catch(() => "threw")) !== "threw");

// 6. Exactly at the boundary: shouldCompact is `>`, so equal must not fire.
reset();
check("exactly at threshold does not stop", (await hook(turn(threshold))) !== true);
reset();
check("one over the threshold stops", (await hook(turn(threshold + 1))) === true);

// 7. Disabling compaction disables the hook.
//    setCompactionEnabled() WRITES TO ~/.pi/agent/settings.json and the restore
//    does not reliably stick, so this stubs the getter instead of touching the
//    user's real config. Learned the hard way: an earlier version of this test
//    left auto-compaction disabled globally.
reset();
const realGet = session.settingsManager.getCompactionSettings.bind(session.settingsManager);
session.settingsManager.getCompactionSettings = () => ({ ...realGet(), enabled: false });
const whenOff = await hook(turn(threshold + 9000));
session.settingsManager.getCompactionSettings = realGet;
check("respects compaction.enabled=false", whenOff !== true);
check("restored after stub", session.settingsManager.getCompactionSettings().enabled === true);

const total = pass + fails.length;
console.log(`\n${pass}/${total} passed`);
if (fails.length) { console.log("FAILURES:\n" + fails.join("\n")); process.exit(1); }
process.exit(0);
