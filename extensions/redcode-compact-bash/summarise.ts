// Pure logic, no pi imports, so it can be unit-tested standalone.

/** Lines of command to show when collapsed. One is usually the whole story. */
export const COLLAPSED_LINES = 1;

/** `cat > /tmp/x.py <<'EOF'` — capture the redirect so we can name the target. */
const HEREDOC = /^(.*?)<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/;

/** True when the command is short enough that collapsing would gain nothing. */
export function isShort(command: string): boolean {
  return command.split("\n").length <= COLLAPSED_LINES + 1;
}

export function summarise(command: string): { head: string; hidden: number } {
  const lines = command.split("\n");
  if (isShort(command)) return { head: command, hidden: 0 };

  // A heredoc's first line already names what is being written and where.
  // Showing it alone beats showing the first N lines of the body.
  const m = lines[0].match(HEREDOC);
  const head = m ? `${m[1].trimEnd()} <<${m[2]}`.trimStart() : lines.slice(0, COLLAPSED_LINES).join("\n");
  return { head, hidden: lines.length - head.split("\n").length };
}
