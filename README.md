# redcode

The crimson profile for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a theme, a set of extensions, and a `/connect` command that points pi at a private OpenAI-compatible model server.

**This repository contains no models, no endpoints, and no keys.** It is the client side only. To use it you need a base URL and an API key from whoever runs the server. Without those, redcode installs fine and does nothing useful.

Works on Linux, macOS, and Windows (see [Windows](#windows)).

---

## Install

```bash
npm install -g @earendil-works/pi-coding-agent
git clone https://github.com/stormgraser-ux/redcode.git
cd redcode
./install.sh
```

Then start it and connect:

```bash
./bin/redcode
```

```
/connect
```

`/connect` asks for two things — the endpoint URL and the API key — checks them against the live server before saving anything, and writes them to `~/.pi/agent/redcode.json` with owner-only permissions. Then pick your model with `/model`.

You type the key into a dialog box, not into the chat, so it never enters the session transcript and is never sent to a model.

If the probe fails, `/connect` says which layer failed — DNS, connection refused, timeout, or a rejected key — rather than a generic error. Nothing is saved on a failure, so a stored key is always one that worked at least once.

### Other commands

| Command | Does |
|---|---|
| `/connect` | Add an endpoint (interactive) |
| `/connect status` | List endpoints, redacted keys, and whether each is currently answering |
| `/disconnect` | Remove an endpoint and its stored key |

`install.sh --link` symlinks instead of copying, so `git pull` updates the profile live. `install.sh --uninstall` removes it and restores whatever it displaced.

---

## What you get

**`/connect`** — private model endpoints, described above.

**A header that says what this session is** — the crimson masthead, then which endpoint is answering and which model, the repo and branch with its dirty and ahead counts, where you are, and which `AGENTS.md` / `CLAUDE.md` files were auto-loaded into the system prompt before you typed anything. It reads the endpoint pi actually selected via `defaultProvider` rather than assuming the most recently added one, and says so when those disagree. A fresh install with no endpoint yet gets told to run `/connect` instead of a blank space. It is a static snapshot of how the session began — `/header` re-takes it, `/builtin-header` restores pi's own.

**Modes on shift+tab** — normal / discussion / plan. Discussion withholds the editing tools so you can think out loud without the agent quietly rewriting your files. Plan mode investigates, asks you the real judgement calls as dialogs, then writes a plan to `.pi/plans/` and offers to implement it in a fresh session.

**A two-line dock** replacing pi's footer: mode chip, provider and model and thinking level, and a context gauge on the right; then where you are with its git branch, session token totals, and the per-turn telemetry below. Standing state sits right, identity left, so the number you glance at is always in the same place. The context bar exists because "how close to the edge am I" is a proportion, and pi's own `1.4%/205k` buried in a run of separators does not answer it at a glance. `/footer default` restores pi's if it ever misbehaves. There is no VRAM gauge, deliberately — that bar is scaled to a limit on whichever machine is running the model, and yours is not it.

**Per-turn telemetry under the command line** — decode rate, time to first token, and output size, measured by the client rather than read from any server's log. Both timings start at the first *content* delta, not the first byte: servers routinely emit a `message_start` frame before prefilling anything, and timing from the first byte folds the whole prefill into what you then call the decode rate — reporting ~40 tok/s for a model doing ~124. A rate that is still climbing is coloured differently from a settled one.

**A visible plan checklist** (`redcode-todo`) whose steps cannot silently move. The failure it exists for: an agent writes a six-step plan, does step one, and then quietly re-scopes the rest.

**A compaction progress bar** with an elapsed timer and a time-remaining estimate. Against a local model compaction routinely runs 60–120 seconds, and pi's built-in spinner gives you no way to tell a slow compaction from a wedged one. The bar is a *fitted prediction*, not a token count — summarization bypasses the agent loop, so only the start and the end are observable from an extension. It calibrates itself against your last dozen compactions.

**Blast-radius guardrails** — a destructive command is judged by how much it can destroy, measured as path depth below an anchor like your home or project directory, not by which tool ran it. `rm -rf ~/code` is refused, `rm -rf ~/code/project/build` runs. This never prompts: prompt fatigue is the failure mode it is designed around. *Unix paths only for now — see [Windows](#windows).*

**Web content cannot reach root in the same session.** The first command that pulls from a public host taints the session, and from then on `sudo`, `pkexec`, `doas`, `su` and `runuser` are refused until you start a new one. A single command that does *both* — the model really does emit `webfetch https://example.com; sudo -n id` as one call — is refused outright, because ordering is no defence when the fetch half may be a redirect chain that resolves at run time. Loopback, private-LAN and tailnet addresses deliberately do not taint; if every fetch counted, a session would taint in seconds and the rule would be noise. `/trust-status` says where the taint came from, `/trust-reset` clears it after you have looked at what came back. This is advisory, not a kernel boundary: it constrains the agent, not you.

**A clickable "jump to latest" button** when you have scrolled back.

**`/effort`** to change the thinking level in one keystroke, offering only the levels your model actually accepts. An unsupported reasoning level returns a 400 that pi silently retries, so the turn **hangs** rather than erroring — the filter is what makes that impossible.

**`/cd`** moves a live session to another project directory with its full history: tools, AGENTS.md, skills, and trust all rebind. Set `REDCODE_PROJECTS` if your projects do not live in `~/code`.

**`/btw <question>`** — a one-shot side question that never enters the main conversation. It forks the session's effective context and re-sends the exact prefix the session last used — same system prompt, messages, tools, and thinking level — so the engine's prefix cache means only the appended question is prefilled. The answer streams into a pinned overlay on top of the output (it captures focus, so esc closes it without touching the main turn — and esc while it is still streaming cancels the side call); the Q&A is also recorded as a transcript entry that never re-enters LLM context and renders nowhere in the transcript — the overlay is the only visible `/btw` output, and a bare `/btw` re-shows the last answer from that entry in the same dismissible panel. The tools stay in the rendered prompt on purpose (stripping them would break the cache); the side call simply has no tool executor, so nothing can run even if the model emits a call. It uses the engine's second concurrency lane, so you can ask while the main turn is still streaming.

**A leaked tool call still runs** (`redcode-toolcall-recover`). Qwen-family models write tool calls as an XML scaffold, and two positions in it sit on a BPE merge boundary — at the temperature Qwen itself recommends for thinking, the model occasionally draws the neighbouring token and emits `<function= bash>` or `<parameter>command>`. One token wrong. A strict server parser rejects the block, hands it back as content, and **the turn ends**: markup printed as the answer, no tool run, nothing to do but type "continue". Counted against one local engine over four days: 4 in 2,005 tool-calling turns, which is exactly the rate that reads as the model degrading rather than as a decoding accident. This rebuilds the block into a real tool call on the same turn. It refuses to touch a *truncated* block — its last argument is half-written, and running half a command or writing half a file is worse than the failure.

**No bash command runs unbounded** (`redcode-compact-bash`). pi arms a timeout only when the model supplies one, and models omit it on roughly nine calls in ten — so one command waiting on a prompt that never comes takes the session with it, and the transcript shows a turn that simply never ended. Every call now gets a default of 120s and a ceiling of 900s; programs whose whole purpose is to run long (model servers, builds, `ffmpeg`, `rsync`, package upgrades, `git clone`) get an hour by default and six at most. Add your own with `REDCODE_LONG_PROGRAMS=train.py,render-all`. The model is told the policy in the tool description instead of guessing at it, the call renders the timeout that will actually apply rather than the one it asked for, and a timeout failure names the detached-and-poll pattern so the model has somewhere to go other than retrying with a bigger number.

**A failed `edit` comes back with the file's real bytes** (`redcode-edit-recover`). pi matches `oldText` exactly, and every error it can raise is a restatement of that rule — not one byte of the file comes back. The model re-reads and guesses again, often several times, and a run of failed edits reads as the model getting worse; the instinct is to blame the quant or the context length when it is a leading-whitespace mismatch. On a failure this re-reads the file and rewrites the tool *result* to quote the real text at the place the model meant: the nearest indentation-blind match when nothing was found, or every occurrence with disambiguating context when there were too many. It does not re-apply the edit itself — pi serialises writes through its own mutation queue and writing from a hook would run outside it. One extra round-trip beats a concurrency hazard.

**Double-tap escape clears the command line.** The gesture was free: with text typed and nothing running, escape does nothing at all in pi. It never seizes the key — a raw input listener declines and lets the real handler run — so aborting a turn, aborting a bash call, and the double-escape tree selector all keep working. It stays out of the way entirely while a turn is streaming, because that is when escape means "abort" and pi restores your queued messages into the editor as part of it.

**`/goal`** — keep working until a condition is met, with no evaluator model. `--verify "npm test"` runs after every turn and exit 0 ends the run; that is the trustworthy signal, because a model declaring itself finished is the weakest one available. For work no command can check, the model writes a sentinel line instead. Turn and minute ceilings bound it either way.

**Muscle-memory aliases** — `/clear` and `/exit` for people arriving from Claude Code. Additive; pi's `/new` and `/quit` keep working.

**Smaller things** — bash tool calls collapse under ctrl+o like every other tool; the agent is told its bash tool already runs in the working directory, which stops it prefixing `cd <cwd> &&` onto most commands; per-request payload sizes are logged so you can see what is actually filling your context.

### The pi patch

`scripts/pi-patch` fixes one real bug: **pi never tests the compaction threshold during a tool-calling chain.**

It checks in two places — after a whole agent run finishes, and when you submit. A long tool chain reaches neither, so context climbs unchecked until the request no longer fits. Measured on a 204,800-token session: sixteen consecutive tool-use messages ran 187,191 → 200,896 tokens, straight past the 188,416 threshold, and the turn died with `stopReason: "length"`. pi recovers by compacting and retrying, so nothing is lost — but a full generation is thrown away every time it happens.

The patch hooks `shouldStopAfterTurn`, which the agent loop already calls after every turn inside a chain, and ends the run cleanly so the existing auto-compaction path runs and the chain resumes by itself.

`bin/redcode` re-applies it on every launch, because an npm upgrade silently reverts it. Already-patched is a string search costing milliseconds. A backup is kept next to each patched file, and `scripts/pi-patch --revert` restores it.

Run `npm run patch:test` after upgrading pi — it exercises the patched code path against the real installed pi.

---

## Windows

pi supports Windows and **requires a bash shell** there. [Git for Windows](https://git-scm.com/download/win) is enough; pi finds `C:\Program Files\Git\bin\bash.exe` automatically, or you can point `shellPath` in `~/.pi/agent/settings.json` at Cygwin or MSYS2.

Run `install.sh` and `bin/redcode` **from Git Bash**, not from PowerShell or cmd.

Two things to know:

- **`Alt+Enter` is fullscreen in Windows Terminal by default.** Remap it, or pi cannot receive the shortcut.
- **Blast-radius guardrails are Unix-path-shaped.** The protected-prefix list is `/etc`, `/usr`, `/home` and friends. On a Windows path they simply do not match, so nothing is blocked. Treat the guardrails as absent on Windows until that is fixed — the rest of the profile is unaffected.
- **`install.sh --link` may quietly copy instead.** Git Bash only makes real symlinks with `MSYS=winsymlinks:nativestrict` and Windows developer mode enabled, and it exits 0 either way. The installer checks and tells you when this happened; if it did, re-run `./install.sh` after each `git pull`.

Fresh-Windows verification: `.github/workflows/windows-smoke.yml` runs the whole install — `npm i -g pi`, `install.sh` under Git Bash, unit tests, `pi-patch`, and one full `pi --mode json` round trip — on a pristine Windows image per run, against the bundled mock server; a manual variant joins your tailnet and hits your real model. See [docs/windows-ci.md](docs/windows-ci.md). If something still breaks on a real machine, please open an issue with whatever breaks.

Everything else — the theme, `/connect`, modes, the todo list, the compaction bar, the patch — is plain Node and portable. `scripts/pi-patch` resolves pi through `npm root -g` rather than `which`, because a Node script on Windows runs against the Windows PATH even when launched from Git Bash.

---

## Model catalog

An OpenAI-compatible `/v1/models` response gives you three fields: `id`, `object`, `owned_by`. It does not tell a client the context window, whether the model takes images, or which reasoning levels it accepts. pi needs all three, so `extensions/redcode-connect/catalog.ts` holds a small table keyed by model-id prefix.

A model not in the table still works — it gets deliberately timid defaults (32K context, text only, no thinking levels). Pi will compact earlier than necessary and offer no effort ladder, both recoverable. The alternative, assuming a large window and a full ladder, produces rejected prompts and hung turns, which are not.

Correct any of it per-endpoint in `~/.pi/agent/redcode.json`:

```json
{
  "endpoints": [
    {
      "name": "home",
      "baseUrl": "https://host.example.ts.net:8449/v1",
      "apiKey": "sk-…",
      "models": [
        { "id": "my-model", "name": "My Model", "contextWindow": 131072, "vision": true }
      ]
    }
  ]
}
```

Restart pi after editing it by hand.

---

## Running the server side

redcode is a client. If you want to be the one handing out keys, you need an OpenAI-compatible server that:

- accepts `Authorization: Bearer <key>`, ideally **more than one key**, so a guest key is revocable without rotating your own;
- is reachable by the people you are sharing with — a Tailscale tailnet is the low-effort answer, and keeps the server off the public internet entirely;
- round-trips `reasoning_content` on assistant messages if it does prefix caching. Dropping it is a history mutation, and on a server with prefix reuse that means a full re-prefill on every single turn.

Anything OpenAI-compatible works — llama.cpp's server, vLLM, NInfer.

---

## Development

```bash
npm install        # types only; nothing is compiled
npm test           # unit tests for every extension
npm run patch:check
./scripts/windows-smoke.sh install   # rehearsal: profile install, tests, patch check
./scripts/windows-smoke.sh smoke     # + one full round trip via the bundled mock
node scripts/mock-openai.mjs         # the mock server alone, on any port
```

There is no test framework by design. Each test file is a plain script that counts assertions and exits non-zero, running under bare `node --experimental-strip-types`. pi loads `.ts` extensions directly through jiti, so there is no build step either.

Pin TypeScript to 5.x. TypeScript 7 is the Go rewrite and ships no `tsserver`, so editors report "no valid TypeScript installation" while typescript is plainly installed.

---

## License

MIT. See [LICENSE](LICENSE).
