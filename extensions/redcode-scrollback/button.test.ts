// Unit tests for the jump-to-bottom button logic. Run:
//   node --experimental-strip-types button.test.ts
import {
  BUTTON_TAG,
  buttonRow,
  buttonText,
  isLeftPress,
  linesBelow,
  parseMouse,
  stripAnsi,
} from "./button.ts";

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fails.push(`  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sgr = (button: number, x: number, y: number, kind: "M" | "m") =>
  `\x1b[<${button};${x};${y}${kind}`;

// 1. SGR parsing, including the 1-based → 0-based conversion that decides
//    whether the hit test is off by a row.
{
  const press = parseMouse(sgr(0, 5, 12, "M"));
  check("press parses", press !== undefined);
  check("press is 0-based", press?.x === 4 && press?.y === 11, `${press?.x},${press?.y}`);
  check("press kind", press?.kind === "press");
  check("press is not wheel or motion", press?.wheel === false && press?.motion === false);
  check("release kind", parseMouse(sgr(0, 5, 12, "m"))?.kind === "release");

  const wheelUp = parseMouse(sgr(64, 1, 1, "M"));
  check("wheel flagged", wheelUp?.wheel === true);
  const drag = parseMouse(sgr(32, 1, 1, "M"));
  check("motion flagged", drag?.motion === true);
  const rightClick = parseMouse(sgr(2, 1, 1, "M"));
  check("right button decoded", rightClick?.button === 2);
  check("middle button decoded", parseMouse(sgr(1, 1, 1, "M"))?.button === 1);
}

// 2. Non-mouse input must parse to undefined — the handler passes anything it
//    does not understand straight through, and a false positive here would eat
//    keystrokes.
{
  for (const data of ["", "a", "\x1b[A", "\x1b[200~paste\x1b[201~", "\x1b[<0;5;12", "\x1b[M abc"]) {
    check(`ignores ${JSON.stringify(data)}`, parseMouse(data) === undefined);
  }
}

// 3. Only a bare left press arms the click. Wheel and drag must not, or
//    scrolling with the pointer over the button would be swallowed.
{
  check("left press arms", isLeftPress(parseMouse(sgr(0, 1, 1, "M"))!));
  check("release does not arm", !isLeftPress(parseMouse(sgr(0, 1, 1, "m"))!));
  check("wheel does not arm", !isLeftPress(parseMouse(sgr(64, 1, 1, "M"))!));
  check("drag does not arm", !isLeftPress(parseMouse(sgr(32, 1, 1, "M"))!));
  check("right press does not arm", !isLeftPress(parseMouse(sgr(2, 1, 1, "M"))!));
}

// 4. Hit testing against the composed screen.
{
  const screen = (buttonAt: number, total = 30) =>
    Array.from({ length: total }, (_, i) =>
      i === buttonAt ? `\x1b[48;5;236m  ▼  ${BUTTON_TAG}  42 lines below  \x1b[0m` : `line ${i}`,
    );

  check("finds the button row", buttonRow(screen(25)) === 25);
  check("no button, no row", buttonRow(Array.from({ length: 30 }, (_, i) => `line ${i}`)) === -1);
  check("undefined lines", buttonRow(undefined) === -1);
  check("empty screen", buttonRow([]) === -1);

  // THE COLLISION CASE. The button's words are ordinary English and this file
  // gets read inside a pi session, so a transcript line can contain them. Only
  // the dock band at the bottom counts.
  const withTranscriptEcho = screen(25);
  withTranscriptEcho[2] = `the widget says "${BUTTON_TAG}" when scrolled up`;
  check("transcript echo does not win", buttonRow(withTranscriptEcho) === 25);

  const onlyTranscriptEcho = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  onlyTranscriptEcho[3] = `${BUTTON_TAG} appears here in prose`;
  check("far-up echo is not a hit", buttonRow(onlyTranscriptEcho) === -1);
}

// 5. ANSI stripping — the hit test reads styled lines.
{
  check("strips SGR", stripAnsi("\x1b[1;31mred\x1b[0m") === "red");
  check("strips OSC 8 links", stripAnsi("\x1b]8;;http://x\x07text\x1b]8;;\x07") === "text");
  check("leaves plain text", stripAnsi("plain") === "plain");
}

// 6. The lines-below count. It is decoration, so anything doubtful must come
//    back undefined and be omitted rather than printed wrong.
{
  check("counts lines below", linesBelow(10, 40, 100) === 50);
  check("at the end is undefined", linesBelow(60, 40, 100) === undefined);
  check("past the end is undefined", linesBelow(70, 40, 100) === undefined);
  check("missing scrollTop", linesBelow(undefined, 40, 100) === undefined);
  check("missing viewport", linesBelow(10, undefined, 100) === undefined);
  check("missing content", linesBelow(10, 40, undefined) === undefined);
  check("NaN", linesBelow(Number.NaN, 40, 100) === undefined);
}

// 7. Label text.
{
  check("label carries the tag", buttonText(42).includes(BUTTON_TAG));
  check("label carries the arrow", buttonText(42).includes("▼"));
  check("plural", buttonText(42).includes("42 lines below"));
  check("singular", buttonText(1).includes("1 line below"));
  check("thousands separated", buttonText(1234).includes("1,234 lines"));
  check("count omitted when unknown", !buttonText(undefined).includes("below"));
  check("still a button when unknown", buttonText(undefined).includes(BUTTON_TAG));
}

const total = pass + fails.length;
console.log(`${pass}/${total} passed`);
if (fails.length) {
  console.log(`FAILURES:\n${fails.join("\n")}`);
  process.exit(1);
}
