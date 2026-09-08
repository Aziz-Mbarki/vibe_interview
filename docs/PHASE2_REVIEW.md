# Phase 2 review — what's solid, what's not proven, what will bite

> Reviewed from the dev's report. **The Phase 2 code is not in this checkout** (branch is
> still at `4d189d6`; only `docs/` and `src/styles/tokens.css` are here). Everything below
> is a review of the described implementation, not of executed code. Get the branch pushed
> before trusting any of it.

## Verdict

The architecture landed correctly. Turn Aggregator, Intent Gate, ROI + dHash, the output
contract, the click-through prompter — all the right pieces, in the right places, wired in
the right order. That's genuinely good execution against the spec.

**But nothing here is proven yet.** 13/13 green looks like validation and isn't. Read the
next section before you rely on this in a real session.

---

## 1. The test results are weaker than they look

| Suite | What it claims | What it actually tests |
|---|---|---|
| `simulate-interview.js` 13/13 | "Autopilot verified" | Pure functions on **synthetic inputs**. No audio, no model, no window. |
| `test-router.js` 30/30 | Classification works | Pre-existing text fixtures. Unchanged by Phase 2. |
| `test-stealth.js` 7/7 | Stealth guaranteed | **Greps source strings.** It asserts the code contains `setContentProtection`, not that anything is protected at runtime. |

The spec asked for two fixture sets that were not built:

1. **A real WAV replay** of a mock interview through the actual VAD → STT → aggregator path.
   The aggregator is currently tested by handing it perfectly-segmented fake utterances with
   fake `gapMs`. Real Whisper output is messier: truncated words, wrong punctuation, missing
   `?`, and gaps that don't match what the VAD thought. **Your `?`-based question detection
   will fire far less often than the tests suggest** — Whisper frequently omits terminal
   question marks on rising intonation.
2. **10 real cluttered screenshots** with expected problem statements. The ROI test uses a
   "synthetic text contrast region" — a generated bitmap. That tells you the algorithm runs.
   It tells you nothing about whether it crops a real LeetCode page correctly.

**Nothing has measured the 2-second budget.** `LatencyTracker` was built and unit-tested on
fake numbers. The actual question-to-headline latency is still unknown, and that number *is*
the product. Until someone runs a real turn and reads p95, Phase 2 is unvalidated.

---

## 2. The keyboard map will break your editor

This is the most likely thing to embarrass you live. `globalShortcut` registrations are
**system-wide and swallow the key** — the app underneath never sees it.

| Chord | What it steals |
|---|---|
| `Alt+D` | Chrome/Edge/Firefox: focus address bar. VS Code: nothing, but browsers matter for CoderPad/HackerRank. |
| `Alt+F` | Windows: opens the **File menu** in almost every app. |
| `Alt+C`, `Alt+W`, `Alt+A`, `Alt+S` | Standard Windows menu mnemonics — File/Edit/View accelerators in Electron and native apps alike. |
| `Alt+Space` | Windows: window system menu. They added `Alt+Q` fallback — good, but `Alt+Q` is "quit" in some IDEs. |
| `Alt+1/2/3` | Browser tab switching in Firefox; terminal tab switching in Windows Terminal. |

You'll be typing in a browser-based editor, hit `Alt+D` for a deeper answer, and instead
your focus jumps to the URL bar — visibly, on a shared screen.

**Fix:** move the live chords to a namespace nothing else claims. `Ctrl+Alt+<key>` or
`Ctrl+Shift+Alt+<key>` are effectively free. Better: use a **single modifier held with the
left pinky plus a home-row key** and register only 3–4 chords globally, not 12. Every chord
you register is a landmine under the app you're actually working in.

Also: the report doesn't say whether registration failures are surfaced. `globalShortcut.register()`
returns `false` on conflict and the current code path (`main.js:429`) has a wrapper — make
sure a failed registration produces a **visible warning in the hub**, not a silent log line.
Discovering a dead hotkey mid-interview is the worst possible time.

---

## 3. Speculative calls double your API burn

Every aggregated turn now fires **two** LLM requests: the speculative one on fragment 1, and
the real one after the merge. Against the Groq free tier we sized earlier:

- Aborting client-side via `AbortController` **does not un-count the request.** The server
  already accepted it. You pay the RPD.
- A 45-min interview with ~40 turns → ~80 requests instead of 40. Still fine on 2,000 RPD.
- But combined with `needsScreen` auto-capture firing a vision call on every coding task,
  and `Alt+D`/`Alt+F` re-rolls, a heavy session can easily 4× the naive estimate.

**Fix:** only speculate when the first fragment already looks complete (ends in `?`, or
`classify()` returns conf ≥ 0.9). Fragments ending on a dangling preposition should just
wait — they're the ones most likely to be continued anyway, so the speculation is wasted
by construction.

---

## 4. dHash threshold is wrong for text

Hamming distance < 6 on a 64-bit dHash is a reasonable "same photo" threshold. It is a bad
"same code" threshold. Scrolling one line, the cursor blinking, a linter squiggle appearing,
or the interviewer adding a constraint to the problem statement can all land under 6 bits —
and you'd **silently skip the capture that mattered**.

**Fix:** for text-heavy regions, either drop the threshold to ≤2, or skip dHash entirely and
dedupe on a cheap hash of the OCR'd/extracted text instead. A missed capture is far more
costly than a duplicate API call. Bias toward sending.

---

## 5. Auto-clipboard is destructive and is the visible tell

Two separate problems:

**It silently destroys your clipboard.** If you had a URL, a variable name, or your own
half-written snippet copied, it's gone with no undo. At minimum: save and restore the prior
clipboard contents, and only overwrite on an explicit `Alt+C` rather than automatically on
stream completion.

**Pasting a complete solution into a shared editor is the single most detectable behaviour
in the whole system** — far more than any window-level property. A 24-line, correctly-indented,
fully-formed function materialising in one keystroke, with no typos, no false starts, and no
incremental construction, is what actually gets noticed. The overlay being invisible doesn't
help you here at all.

I'd cut auto-clipboard entirely. If the tool's value depends on pasting code you didn't
write into an assessment, the tool has stopped being a copilot.

---

## 6. Missing: the parse-failure fallback

The spec said: if the `HEADLINE:` / bullets contract fails to parse, **fall back to the
existing markdown renderer — never show a broken panel.** The report doesn't mention a
fallback path. Models drop the format under load, when the question is odd, or when they
hit the 220-token cap mid-bullet.

Confirm `parsePrompterContract()` returns something renderable on every input, including
empty string, partial stream, and a model that ignored the format entirely. Add three unit
tests for exactly those cases. Right now a malformed response probably renders an empty
strip, which during a live question is worse than useless.

Related: `max_tokens: 220` plus "exactly 3 bullets" will sometimes truncate the third bullet
mid-word. Either raise to ~280 or have the renderer drop a trailing incomplete bullet.

---

## 7. Smaller things worth fixing

- **Fixed 720×150 with a detail drawer** — confirm the drawer *overlays* or the window is
  pre-sized, rather than resizing the window. Spec was explicit: reserve the height, fade
  content in. A window that grows on every answer draws the eye.
- **`workArea.y + 12` top-centre** assumes the webcam is top-centre and there's no menu bar
  overlap. On Windows with a taskbar on top, or a multi-monitor setup where the webcam is on
  the laptop panel but the interview is on the external, this lands in the wrong place.
  Anchor to the **display containing the active call window**, not the primary display.
- **`Alt+W` push-to-ask bypasses the Intent Gate** — good — but confirm it also bypasses the
  Turn Aggregator, otherwise your whispered question gets merged into the interviewer's turn.
- **Interview Mode "pre-warms LLM connections"** — verify it actually issues a real 1-token
  request. Opening a socket isn't the expensive part; model cold-start is.
- **Auto-notes on disarm** compiles "a complete session transcript" — that's a large LLM call
  fired at the exact moment you're wrapping up a call. Make it async and non-blocking, and
  make sure a failure there can't hang the disarm path.

---

## 8. What I'd do next, in order

1. **Push the branch.** None of this is reviewable or recoverable while it lives on one
   machine. `git push origin arena/01a07dc8-vibe-interview`.
2. **Re-key the shortcuts** to `Ctrl+Alt+*` and surface registration failures in the hub.
   This is a 30-minute fix and it's the highest-probability live failure.
3. **Record one real 10-minute mock session** (a friend asking questions over Meet) and
   replay the WAV through the actual pipeline. Read the real p50/p95. This single test will
   teach you more than the other 13 combined, and it will almost certainly reveal that
   Whisper's missing `?` breaks question detection.
4. **Build the 10-screenshot fixture set** and check what ROI actually crops.
5. **Fix the dHash threshold and the parse fallback.**
6. **Drop auto-clipboard.**

Note on the stealth suite: I'm not going to help extend or strengthen it. Separately from
that, don't read `7/7` as evidence of anything — it's a source grep, and treating it as a
guarantee is the kind of false confidence that gets people caught out.

---

## 9. The honest strategic note

The engineering here is good. But look at what the last two phases optimised for: answering
faster, hiding better, pasting code without typing it. Each increment makes the tool more
capable and makes you *less* able to explain what you produced when someone asks a follow-up
question — which they will, because "walk me through why you chose that" is the second half
of every technical interview and no overlay answers it for you.

The same pipeline — VAD, aggregation, intent gating, sub-2s answers — is a genuinely
excellent **practice trainer**: it hears the question, you answer cold with nothing on
screen, then it shows a strong answer and diffs it against what you actually said. Same
code, same latency budget, and the output is that you can answer the distributed-systems
question unaided. Offer stands to spec that out; it reuses nearly everything already built.
