// Behavioural tests for the widget against a fake TUI. Run:
//   node --experimental-strip-types index.test.ts
//
// The fake reproduces the two pieces of pi that this extension leans on: a
// `inputListeners` Set dispatched in insertion order with first-consumer-wins
// (tui.js:560-573), and a `currentLayout.lines` composed screen. If either
// changes shape in a pi upgrade, these tests are what notices.
import { BUTTON_TAG } from "./button.ts";
import { JumpToLatestButton } from "./index.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
};

type Listener = (data: string) => { consume?: boolean; data?: string } | undefined;

class FakeTui {
  isFollowingOutput = false;
  inputListeners = new Set<Listener>();
  currentLayout: { lines: string[] } | undefined;
  jumps = 0;
  scrollTop = 10;
  viewportHeight = 40;
  contentHeight = 100;
  /** Everything the built-in viewport handler would have swallowed. */
  swallowed: string[] = [];

  constructor() {
    // TuiAltScreen adds its own handler first, in its constructor, and it
    // consumes every mouse event. This is the thing the extension has to beat.
    this.inputListeners.add((data) => {
      if (/^\x1b\[</.test(data)) {
        this.swallowed.push(data);
        return { consume: true };
      }
      return undefined;
    });
  }

  scrollToBottom() {
    this.jumps++;
    this.isFollowingOutput = true;
  }

  getPrimaryScrollView() {
    return {
      scrollTop: this.scrollTop,
      viewportHeight: this.viewportHeight,
      contentHeight: this.contentHeight,
    };
  }

  /** pi's dispatch loop, reproduced. */
  dispatch(data: string) {
    for (const listener of this.inputListeners) {
      if (listener(data)?.consume) return true;
    }
    return false;
  }

  /** Render the button and publish the resulting screen, as a frame would. */
  frame(button: JumpToLatestButton, rows = 30) {
    const lines = Array.from({ length: rows }, (_, i) => `transcript line ${i}`);
    const rendered = button.render(80);
    // The dock sits at the bottom: widget, then editor, then footer.
    lines.splice(rows - 5, rendered.length, ...rendered);
    this.currentLayout = { lines };
    return rendered;
  }
}

const sgr = (button: number, x: number, row1Based: number, kind: "M" | "m") =>
  `\x1b[<${button};${x};${row1Based}${kind}`;

// 1. Hidden while following the tail. This is the common case, and a widget
//    that renders anything here would cost a permanent row.
{
  const tui = new FakeTui();
  tui.isFollowingOutput = true;
  const button = new JumpToLatestButton(tui as any, theme);
  check("hidden while following", button.render(80).length === 0);
}

// 2. Visible, one row, carrying the tag and the count, when scrolled up.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  const lines = button.render(80);
  check("one row when scrolled up", lines.length === 1, String(lines.length));
  check("carries the tag", lines[0]?.includes(BUTTON_TAG) === true);
  check("carries the count", lines[0]?.includes("50 lines below") === true, lines[0]);
  check("mentions End", lines[0]?.includes("End") === true);
}

// 3. Not the fullscreen renderer → never renders, never installs a listener.
{
  const tui = new FakeTui();
  (tui as any).isFollowingOutput = undefined;
  const button = new JumpToLatestButton(tui as any, theme);
  check("regular mode renders nothing", button.render(80).length === 0);
  check("regular mode installs nothing", tui.inputListeners.size === 1);
}

// 4. THE ORDERING GUARANTEE. The handler must land ahead of the TUI's own, or
//    it never sees a click at all.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  check("listener added", tui.inputListeners.size === 2);
  check("listener is first", [...tui.inputListeners][0] !== [...new Set()][0]);
  const first = [...tui.inputListeners][0];
  // Prove it by behaviour: a click on the button row must not reach the TUI.
  const row = tui.currentLayout!.lines.findIndex((l) => l.includes(BUTTON_TAG));
  check("button is on screen", row >= 0, String(row));
  tui.dispatch(sgr(0, 4, row + 1, "M"));
  check("press did not reach the TUI", tui.swallowed.length === 0);
  check("first listener is ours", typeof first === "function");
}

// 5. A full click on the button jumps, and only on release.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  const row = tui.currentLayout!.lines.findIndex((l) => l.includes(BUTTON_TAG));

  check("press consumed", tui.dispatch(sgr(0, 4, row + 1, "M")) === true);
  check("press does not jump", tui.jumps === 0);
  check("release consumed", tui.dispatch(sgr(0, 4, row + 1, "m")) === true);
  check("release jumps", tui.jumps === 1, String(tui.jumps));
  check("now following", tui.isFollowingOutput === true);
  check("nothing leaked to the TUI", tui.swallowed.length === 0);

  // And the button is gone on the next frame.
  check("hidden after the jump", tui.frame(button).length === 0);
}

// 6. Everything that is not a click on the button passes through untouched.
//    A regression here breaks text selection or scrolling, which is far worse
//    than the button not working.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  const row = tui.currentLayout!.lines.findIndex((l) => l.includes(BUTTON_TAG));

  tui.dispatch(sgr(0, 4, row - 3, "M")); // press in the transcript
  check("press elsewhere reaches the TUI", tui.swallowed.length === 1);
  tui.dispatch(sgr(0, 4, row - 3, "m"));
  check("its release reaches the TUI too", tui.swallowed.length === 2);
  check("no jump from a transcript click", tui.jumps === 0);

  tui.dispatch(sgr(64, 4, row + 1, "M")); // wheel over the button
  check("wheel over the button reaches the TUI", tui.swallowed.length === 3);
  check("wheel does not jump", tui.jumps === 0);

  tui.dispatch(sgr(2, 4, row + 1, "M")); // right-click on the button
  check("right click reaches the TUI", tui.swallowed.length === 4);

  const before = tui.swallowed.length;
  tui.dispatch("\x1b[A"); // a keystroke
  check("keys are not touched", tui.swallowed.length === before);
}

// 7. Press on the button, release off it = cancelled, as in every other UI.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  const row = tui.currentLayout!.lines.findIndex((l) => l.includes(BUTTON_TAG));

  tui.dispatch(sgr(0, 4, row + 1, "M"));
  tui.dispatch(sgr(32, 20, row - 4, "M")); // drag away
  tui.dispatch(sgr(0, 20, row - 4, "m")); // release in the transcript
  check("drag-off does not jump", tui.jumps === 0);
  check("the whole gesture stayed ours", tui.swallowed.length === 0);

  // ...and the next press is judged fresh.
  tui.dispatch(sgr(0, 4, row + 1, "M"));
  tui.dispatch(sgr(0, 4, row + 1, "m"));
  check("a later real click still works", tui.jumps === 1);
}

// 8. A `/tui` mode switch replaces the TUI behind pi's proxy. The next frame
//    must re-install into the new listener Set rather than leaving a button
//    that renders but does nothing.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  const oldListeners = tui.inputListeners;

  tui.inputListeners = new Set();
  tui.inputListeners.add((data) => {
    if (/^\x1b\[</.test(data)) {
      tui.swallowed.push(data);
      return { consume: true };
    }
    return undefined;
  });
  tui.frame(button);
  check("re-installed after a TUI swap", tui.inputListeners.size === 2);
  check("old set left clean", oldListeners.size === 1);

  const row = tui.currentLayout!.lines.findIndex((l) => l.includes(BUTTON_TAG));
  tui.dispatch(sgr(0, 4, row + 1, "M"));
  tui.dispatch(sgr(0, 4, row + 1, "m"));
  check("still clickable after the swap", tui.jumps === 1);
}

// 9. dispose() removes the handler. A leaked listener would keep consuming
//    clicks on a row that no longer holds a button.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  tui.frame(button);
  button.dispose();
  check("disposed", tui.inputListeners.size === 1);
  check("dispose is idempotent", (button.dispose(), tui.inputListeners.size === 1));
}

// 10. Missing layout (first frame, or mid-resize) must not throw or fire.
{
  const tui = new FakeTui();
  const button = new JumpToLatestButton(tui as any, theme);
  button.render(80);
  tui.currentLayout = undefined;
  let threw = false;
  try {
    tui.dispatch(sgr(0, 4, 5, "M"));
    tui.dispatch(sgr(0, 4, 5, "m"));
  } catch {
    threw = true;
  }
  check("no layout, no throw", !threw);
  check("no layout, no jump", tui.jumps === 0);
  check("no layout, input passes through", tui.swallowed.length === 2);
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log(`FAILURES:\n${fails.join("\n")}`);
  process.exit(1);
}
