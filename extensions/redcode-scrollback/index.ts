// redcode-scrollback — a clickable "jump to latest" button that appears above
// the editor whenever the transcript is scrolled off the live output.
//
// WHY IT IS NEEDED. In fullscreen (`tuiMode: "fullscreen"`) pi owns the
// scrollback itself: scrolling up detaches the viewport from the tail, and the
// only signals that you are detached are the scrollbar thumb and the absence of
// new output. `End` already jumps back (keybinding `tui.altScreen.bottom`) but
// nothing on screen says so, and there is no pointer route at all. This adds
// both: a visible affordance, and a click target.
//
// It renders NOTHING while following the tail, and the widget container already
// reserves one spacer line whether or not a widget is present
// (interactive-mode.js:1757), so the hidden state costs zero rows.
//
// TWO PIECES OF pi INTERNALS ARE USED, both deliberately:
//
//  1. `tui.currentLayout.lines` — the composed screen — for hit testing. See
//     button.ts for why the layout tree cannot answer this.
//
//  2. `tui.inputListeners` is reordered so this handler runs FIRST. It has to:
//     TuiAltScreen registers its own viewport handler in its constructor, that
//     handler consumes every mouse event unconditionally
//     (tui-alt-screen.js:411-421), and listeners are a Set iterated in
//     insertion order. An extension registering normally via
//     `ctx.ui.onTerminalInput` is therefore always too late to see a click.
//     The handler consumes ONLY a left press/release whose press landed on the
//     button's row; everything else — including every wheel event — passes
//     through untouched, so selection, links and scrolling are unaffected.
//
// Both are re-checked on every frame, so a `/tui` mode switch (which replaces
// the TUI object behind pi's proxy) re-installs rather than silently dying.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUTTON_TAG, buttonRow, buttonText, isLeftPress, linesBelow, parseMouse } from "./button.ts";

/** Reinstate follow-the-tail. `End` is bound to the same thing. */
function jumpToBottom(tui: any): void {
  tui.scrollToBottom?.();
}

/** True only for the fullscreen renderer, which is the only one that scrolls. */
function ownsScrollback(tui: any): boolean {
  return typeof tui?.isFollowingOutput === "boolean";
}

/** Exported for index.test.ts, which drives it against a fake TUI. */
export class JumpToLatestButton {
  /** The listener Set this handler is currently installed in, so a replaced
   *  TUI is detected on the next frame instead of leaving a dead button. */
  private installedIn: Set<unknown> | undefined;
  private pressedOnButton = false;

  private readonly tui: any;
  private readonly theme: any;

  // Written out rather than as parameter properties: extensions are loaded by
  // jiti here but by Node's strip-only transform in the tests, and strip-only
  // mode rejects parameter properties outright.
  constructor(tui: any, theme: any) {
    this.tui = tui;
    this.theme = theme;
  }

  private handleInput = (data: string): { consume?: boolean } | undefined => {
    const event = parseMouse(data);
    // Wheel events must reach the TUI or scrolling stops working entirely.
    if (!event || event.wheel) return undefined;

    const row = buttonRow(this.tui.currentLayout?.lines);
    const onButton = row >= 0 && event.y === row;

    if (isLeftPress(event)) {
      if (!onButton) return undefined;
      this.pressedOnButton = true;
      return { consume: true };
    }
    if (!this.pressedOnButton) return undefined;

    // From here the press was ours, so the whole gesture is ours: swallowing
    // the drag motion stops a click on the button from starting a selection.
    if (event.kind === "release") {
      this.pressedOnButton = false;
      // Released off the button = cancelled, the same as every other UI.
      if (onButton) jumpToBottom(this.tui);
    }
    return { consume: true };
  };

  /** Put this handler ahead of the TUI's own, which consumes all mouse input. */
  private ensureInstalled(): void {
    const listeners = this.tui?.inputListeners as Set<unknown> | undefined;
    if (!listeners || this.installedIn === listeners) return;
    this.installedIn?.delete(this.handleInput);
    const existing = [...listeners];
    listeners.clear();
    listeners.add(this.handleInput);
    for (const listener of existing) listeners.add(listener);
    this.installedIn = listeners;
  }

  render(_width: number): string[] {
    if (!ownsScrollback(this.tui)) return [];
    this.ensureInstalled();
    if (this.tui.isFollowingOutput) return [];

    const view = this.tui.getPrimaryScrollView?.();
    const below = linesBelow(view?.scrollTop, view?.viewportHeight, view?.contentHeight);
    const t = this.theme;

    // `selectedBg` rather than a colour: this is an interactive chip, not a
    // status, and every colour that would read as "button" in one theme carries
    // an unwanted good/bad meaning in another.
    const chip = t.bg("selectedBg", t.fg("text", buttonText(below)));
    return [`${chip}${t.fg("dim", "  End")}`];
  }

  invalidate(): void {}

  dispose(): void {
    this.installedIn?.delete(this.handleInput);
    this.installedIn = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const install = (ctx: any) => {
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget(
      "redcode-scrollback",
      (tui: any, theme: any) => new JumpToLatestButton(tui, theme),
      { placement: "aboveEditor" },
    );
  };

  pi.on("session_start", async (_event, ctx) => install(ctx));

  pi.registerCommand("jump", {
    description: `Scroll the transcript to the latest output (same as End, or click "${BUTTON_TAG}")`,
    handler: async (_args, ctx: any) => {
      if (!ctx?.hasUI) return;
      // The widget factory holds the only TUI reference an extension gets, so
      // re-setting the widget is also how the command reaches the TUI.
      ctx.ui.setWidget(
        "redcode-scrollback",
        (tui: any, theme: any) => {
          jumpToBottom(tui);
          return new JumpToLatestButton(tui, theme);
        },
        { placement: "aboveEditor" },
      );
    },
  });

  pi.on("session_shutdown", async (_event, ctx: any) => {
    if (ctx?.hasUI) ctx.ui.setWidget("redcode-scrollback", undefined);
  });
}
