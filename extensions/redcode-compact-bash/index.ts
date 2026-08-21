// redcode-compact-bash — make a long bash command obey ctrl+o like everything
// else does.
//
// THE GAP. Every built-in tool honours the collapsed/expanded state for its
// OUTPUT (bash 5 lines, read 10, write 10, grep 15, ls/find 20). None of them
// truncate the tool CALL. `formatBashCall` in core/tools/bash.js renders
// `$ ${command}` verbatim, and its renderCall never looks at
// `context.expanded`. So a 30-line heredoc — `cat > /tmp/x.py <<'EOF' ... EOF`,
// which is how an agent writes a script over ssh — occupies 30 lines of screen
// forever, and ctrl+o does nothing to it. That is usually far more of the
// transcript than any tool output.
//
// THE RENDER FIX. We take the built-in definition and replace one function on
// it: renderCall. `parameters`, `renderResult`, `promptSnippet` and the details
// shape are the same object properties the built-in had. Collapsing is a
// display concern and that part touches only display.
//
// THIS ALSO ENFORCES A TIMEOUT POLICY, which is NOT render-only — see
// timeout.ts for why (pi arms no timer at all when the model omits `timeout`,
// and 90% of real calls omit it). `execute` is wrapped to inject a default and
// clamp a maximum, and the description is extended so the model is told the
// policy instead of guessing. Everything else about execution is unchanged.
//
// Registering under the name "bash" replaces the built-in (pi prints a warning
// at startup, which is expected). The name is preserved deliberately: the
// blast-radius gate matches on it, and the model's prompt still says "bash".
//
// Collapsed shows the first meaningful line plus a hint; ctrl+o restores the
// full command. Heredocs are summarised by their redirect target rather than
// their body, since `cat > file <<EOF` tells you everything the 28 lines of
// Python don't.

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cwd as getCwd } from "node:process";
import { isShort, summarise } from "./summarise.ts";
import {
  DEFAULT_TIMEOUT_S,
  LONG_DEFAULT_TIMEOUT_S,
  LONG_MAX_TIMEOUT_S,
  MAX_TIMEOUT_S,
  resolveTimeout,
  timeoutGuidance,
} from "./timeout.ts";

// pi builds the real bash tool as
//   createAllToolDefinitions(cwd, { bash: { commandPrefix, shellPath } })
// with both values read from settings (see core/agent-session.js _buildRuntime).
// Calling the factory bare would silently drop them — an override that quietly
// stops honouring `shellCommandPrefix` is exactly the kind of trap that surfaces
// months later as "aliases stopped working". So read the same two settings.
function bashOptions(): { commandPrefix?: string; shellPath?: string } {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
    return { commandPrefix: s.shellCommandPrefix, shellPath: s.shellPath };
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  const builtin: any = createBashToolDefinition(getCwd(), bashOptions() as any);
  const renderCallBuiltin = builtin.renderCall;
  const executeBuiltin = builtin.execute;

  pi.registerTool({
    ...builtin,

    // Keep the built-in wording (it documents truncation) and append the policy,
    // so the model stops being told there is no default timeout.
    description:
      `${builtin.description} Timeout defaults to ${DEFAULT_TIMEOUT_S}s and is capped at ${MAX_TIMEOUT_S}s. ` +
      `Recognised long-running tools (benchmarks, builds, model servers, media renders, package upgrades) ` +
      `default to ${LONG_DEFAULT_TIMEOUT_S}s and are capped at ${LONG_MAX_TIMEOUT_S}s. ` +
      `Nothing runs unbounded: to exceed a cap, start the job detached and poll its log instead of raising the timeout.`,

    async execute(toolCallId: any, args: any, signal: any, onUpdate: any, ctx: any) {
      const command = typeof args?.command === "string" ? args.command : "";
      const resolved = resolveTimeout(command, args?.timeout);
      try {
        return await executeBuiltin.call(builtin, toolCallId, { ...args, timeout: resolved.timeout }, signal, onUpdate, ctx);
      } catch (err: any) {
        // pi throws `... Command timed out after N seconds`. Replace the bare
        // statement with the reason and the way out, preserving captured output.
        const message = typeof err?.message === "string" ? err.message : "";
        if (/Command timed out after /.test(message)) {
          err.message = `${message}\n\n${timeoutGuidance(resolved)}`;
        }
        throw err;
      }
    },

    renderCall(args: any, theme: any, context: any) {
      const command = typeof args?.command === "string" ? args.command : "";
      // Show the timeout that will actually apply, not the one the model wrote.
      // A silent 2,000-second stall is exactly what this is meant to surface.
      const effective = command ? resolveTimeout(command, args?.timeout).timeout : undefined;
      const shown = effective === undefined ? args : { ...args, timeout: effective };

      // Expanded, still streaming, or short enough to not be a problem: hand
      // back to the built-in so timers, partial args and styling stay exact.
      if (context.expanded || !command || isShort(command)) {
        return renderCallBuiltin.call(builtin, shown, theme, context);
      }

      // Keep the built-in's side effect: it stamps the start time on first
      // execution, and renderResult reads it back to show the duration.
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }

      const { head, hidden } = summarise(command);
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(
        theme.fg("toolTitle", theme.bold(`$ ${head}`)) +
          theme.fg("muted", ` … ${hidden} more line${hidden === 1 ? "" : "s"} (ctrl+o)`) +
          (effective === undefined ? "" : theme.fg("muted", ` (timeout ${effective}s)`)),
      );
      return text;
    },
  } as any);
}
