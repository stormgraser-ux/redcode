// goal-state.ts — the one bit of state shared between the goal loop and the
// blast-radius gate.
//
// It lives in a file rather than a module export because pi loads each
// extension as its own jiti module; a shared mutable binding across two
// separately-discovered extensions is not something to rely on. A ~100 byte
// JSON file read on demand is cheaper than being wrong about module identity.
//
// The path honours PI_CODING_AGENT_DIR, the same override pi itself reads, so
// a non-default profile does not end up writing its run state into a profile
// it is not using.
//
// The pid is recorded and checked because several pi sessions can run at once.
// A goal running in one terminal must not silently harden the safety gate in
// another.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GOAL_STATE_FILE = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "goal-run.json",
);

export interface GoalRun {
  pid: number;
  condition: string;
  verify?: string;
  startedAt: number;
  maxTurns: number;
  maxMinutes: number;
}

/** True when THIS process is mid goal run. */
export function goalRunning(): boolean {
  try {
    if (!existsSync(GOAL_STATE_FILE)) return false;
    const s = JSON.parse(readFileSync(GOAL_STATE_FILE, "utf8")) as GoalRun;
    return s.pid === process.pid;
  } catch {
    return false;
  }
}

export function readGoal(): GoalRun | null {
  try {
    if (!existsSync(GOAL_STATE_FILE)) return null;
    const s = JSON.parse(readFileSync(GOAL_STATE_FILE, "utf8")) as GoalRun;
    return s.pid === process.pid ? s : null;
  } catch {
    return null;
  }
}

export function writeGoal(g: GoalRun): void {
  writeFileSync(GOAL_STATE_FILE, JSON.stringify(g, null, 2));
}

export function clearGoal(): void {
  try {
    if (!existsSync(GOAL_STATE_FILE)) return;
    const s = JSON.parse(readFileSync(GOAL_STATE_FILE, "utf8")) as GoalRun;
    // Only clear our own run, never another session's.
    if (s.pid === process.pid) unlinkSync(GOAL_STATE_FILE);
  } catch {
    /* nothing to clear */
  }
}
