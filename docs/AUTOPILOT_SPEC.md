# Phase 2 — Autopilot Mode ("zero-click interview")

**Read `SMOG_UI_SPEC.md` first.** That spec built the *surface*. This one makes it **usable
under stress, with no mouse, while a human is staring at you.**

## The problem with what we have now

The current build is a **console**: 5 tabs, panels you open, buttons you click, a notes
editor. In a real 45-minute interview you will use **none of it**. You have:

- **no free hand** — you're typing in a coding editor or looking at the camera,
- **no attention budget** — reading a 400-word answer while someone waits is impossible,
- **no time** — the answer must be on screen ~2s after the interviewer stops talking,
- **no tolerance for a wrong turn** — one mis-click and you're visibly fiddling.

So the design target changes from *"a beautiful multi-panel workspace"* to:

> **One always-visible strip. It fills itself. You never touch anything unless you want to
> override. Everything else is a keyboard chord your thumb already knows.**

Panels stay — but they become the *configuration & review* surface (before and after the
interview), not the *live* surface.

---

## 1. The core idea: Autopilot loop

```
                       ┌─────────────────────────────────────┐
                       │ interviewer speaks                  │
                       └────────────────┬────────────────────┘
                                        ▼
      VAD (already in speech.service.js) closes the utterance on a natural pause
                                        ▼
      ┌── Turn Aggregator ──────────────────────────────────────────────┐
      │ merge this utterance with the previous one if it's an ADDITION  │
      │ ("...and what about at scale?") instead of a new question       │
      └────────────────┬────────────────────────────────────────────────┘
                       ▼
      ┌── Intent Gate (local, no LLM, <1ms) ────────────────────────────┐
      │ QUESTION → answer     CHITCHAT → ignore    YOU_SPEAKING → ignore │
      └────────────────┬────────────────────────────────────────────────┘
                       ▼
      ┌── Context Assembler ────────────────────────────────────────────┐
      │ question + last 3 turns + (if code-ish) the CROPPED screenshot   │
      └────────────────┬────────────────────────────────────────────────┘
                       ▼
      ┌── LLM, streaming, hard length budget ───────────────────────────┐
      └────────────────┬────────────────────────────────────────────────┘
                       ▼
      ┌── Teleprompter strip: 1 headline + 3 bullets, appears instantly ┐
      └─────────────────────────────────────────────────────────────────┘
```

**No click anywhere in that loop.** Autopilot is ON by default once Listen starts.

---

## 2. The Teleprompter strip (replaces panels as the live surface)

This is the single most important UI change. Not a panel — a **thin strip** you can read
with peripheral vision while looking at the camera.

### Layout
```
┌───────────────────────────────────────────────────────────────────────────┐
│ ▸ Distributed systems: sharding + eventual consistency                    │  ← headline (what to open with)
│   • Shard by user_id, keeps hot keys balanced                             │
│   • Eventual consistency + quorum writes for availability                 │  ← 3 bullets max
│   • Idempotent retries so a partition never double-charges                │
│                                                    ●●●   1/2  ⌄ more      │
└───────────────────────────────────────────────────────────────────────────┘
```

### Rules (non-negotiable — these are what make it usable)
1. **Max 1 headline (≤10 words) + 3 bullets (≤14 words each).** Enforced in the prompt AND
   truncated in the renderer. Anything longer is hidden behind "more" (`Alt+↓`).
2. **Font 15–16px minimum.** The current 12–13px panel text is unreadable at a glance.
   Line-height 1.5. This strip is the ONE place we go big.
3. **Progressive reveal:** headline renders the instant the first tokens arrive
   (~400ms), bullets stream in after. You can start talking on the headline alone.
4. **Fixed position, never moves, never resizes.** Growing/shrinking windows catch the eye
   and catch a screen-share viewer's eye too. Reserve the height; fade content in.
5. **No buttons in the strip.** Only a tiny state dot and a page counter.
6. Auto-fades to 35% opacity after 25s of no new content, so a stale answer doesn't nag.

### Where to put it
Default: **top-centre, just under the notch/menu bar**, or **bottom-centre**. Both are
outside where interviewers look (they look at your camera tile and the shared editor).
Configurable, remembered per-monitor.

### Code — new window type in `window.manager.js`
```js
prompter: {
  ...PANEL_BASE,
  width: 720, height: 150,
  file: 'panels/prompter.html',
  title: 'Prompter',
  focusable: false,            // ← CRITICAL: never steals focus from your editor
  resizable: false,
  movable: true,
},
```
`focusable: false` is the whole trick: the strip can be visible and updating while your
cursor stays in the coding editor. Combined with `setIgnoreMouseEvents(true, {forward:true})`
it is literally invisible to your mouse — you can click *through* it.

```js
// always click-through in autopilot; only becomes clickable on the override chord
setPrompterInteractive(on){
  const w = this.windows.get('prompter');
  if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!on, { forward: true });
}
```

### Renderer skeleton (`panels/prompter.html`)
```html
<div class="prompter" id="p">
  <div class="ph" id="headline"></div>
  <ul class="pb" id="bullets"></ul>
  <div class="pf"><span class="dots" id="state"></span><span id="pager"></span></div>
</div>
```
```css
.prompter{
  height:100vh;display:flex;flex-direction:column;justify-content:center;gap:6px;
  padding:14px 18px;background:var(--surface-1);backdrop-filter:var(--blur-panel);
  border:1px solid var(--border-1);border-radius:var(--r-panel);box-shadow:var(--shadow-panel);
  transition:opacity 400ms ease;
}
.prompter.is-stale{opacity:.35}
.ph{font:700 16px/1.35 var(--font);color:var(--text-0);letter-spacing:-.01em}
.pb{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}
.pb li{font:500 15px/1.5 var(--font);color:var(--text-1);padding-left:14px;position:relative}
.pb li::before{content:'';position:absolute;left:3px;top:9px;width:4px;height:4px;
  border-radius:50%;background:var(--accent)}
.pb li.enter{animation:slide 180ms cubic-bezier(.2,.8,.2,1)}
@keyframes slide{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.pf{display:flex;justify-content:space-between;font:500 11px/1 var(--font);color:var(--text-3)}
```

---

## 3. Turn Aggregator — the fix for "additions"

This is your specific complaint and the #1 accuracy problem. Real interviewers talk like:

> "So tell me about your experience with distributed systems." *(0.9s pause)*
> "…and specifically how you'd handle consistency." *(0.6s pause)*
> "Actually, let's say at like a million users."

The current VAD closes **three utterances** → three STT calls → three answers → the
prompter thrashes and you get an answer to the wrong fragment.

### Solution: a debounce window on top of VAD

```js
// src/services/turn-aggregator.js  (NEW)
const ADDITION_MAX_GAP_MS = 1800;   // pause shorter than this = same turn
const HARD_FLUSH_MS       = 12000;  // never hold a turn longer than this
const ADDITION_STARTERS = /^(and|also|so|but|or|plus|actually|specifically|as well|what about|how about|in addition|another thing|oh)\b/i;
const TRAILING_INCOMPLETE = /\b(the|a|an|to|for|with|about|of|in|on|is|are|would|could|like)\s*$/i;

class TurnAggregator {
  constructor(emit){ this.emit = emit; this.buf = []; this.timer = null; this.startedAt = 0; }

  /** Called for every FINAL utterance coming out of speech.service.js */
  push(utt){                                   // { text, speaker, at, gapMs }
    if (utt.speaker === 'you') return;         // never answer yourself

    const isAddition =
      this.buf.length > 0 && (
        utt.gapMs <= ADDITION_MAX_GAP_MS ||
        ADDITION_STARTERS.test(utt.text.trim()) ||
        TRAILING_INCOMPLETE.test(this.buf.at(-1).text)
      );

    if (!isAddition) this._flush();            // previous turn is done, ship it
    if (!this.buf.length) this.startedAt = Date.now();
    this.buf.push(utt);

    clearTimeout(this.timer);
    const remaining = HARD_FLUSH_MS - (Date.now() - this.startedAt);
    this.timer = setTimeout(() => this._flush(), Math.min(ADDITION_MAX_GAP_MS, remaining));
  }

  _flush(){
    if (!this.buf.length) return;
    const text = this.buf.map(u => u.text.trim()).join(' ').replace(/\s+/g,' ');
    const turn = { text, speaker:'them', at:this.buf[0].at, parts:this.buf.length };
    this.buf = []; clearTimeout(this.timer);
    this.emit(turn);
  }
}
```

**Two-stage rendering to hide the latency this adds:** the moment the *first* fragment is
final, kick off a **speculative** LLM call and show its headline greyed. If an addition
arrives within the window, cancel that request (`AbortController`) and re-fire with the
merged text. Net effect: you get 1.8s of extra accuracy but the strip still looks instant.

---

## 4. Intent Gate — don't answer everything

Also local, also zero-latency. Runs on the merged turn *before* any LLM call.

```js
// src/services/intent-gate.js  (NEW)
const QUESTION_MARKS   = /\?\s*$/;
const WH               = /\b(what|why|how|when|where|which|who|whose|can you|could you|would you|do you|did you|have you|are you|is there|tell me|walk me|explain|describe|give me|talk me through|suppose|imagine|let's say)\b/i;
const IMPERATIVE_TASK  = /\b(write|implement|design|solve|code|build|optimi[sz]e|refactor|debug|find the|return the)\b/i;
const CHITCHAT         = /^(ok(ay)?|right|got it|mm+h*|yeah|yes|no|sure|cool|perfect|thanks?|thank you|great|nice|alright|sounds good|makes sense|i see|uh huh)[\s.!,]*$/i;
const FILLER_ONLY      = /^[\s.,!?—-]*$/;

function classify(turn){
  const t = turn.text.trim();
  if (FILLER_ONLY.test(t) || t.length < 8)          return { act:'ignore', why:'too short' };
  if (CHITCHAT.test(t))                              return { act:'ignore', why:'chitchat' };
  const words = t.split(/\s+/).length;
  if (QUESTION_MARKS.test(t))                        return { act:'answer', kind:'question', conf:.95 };
  if (IMPERATIVE_TASK.test(t))                       return { act:'answer', kind:'task',     conf:.9  };
  if (WH.test(t) && words >= 4)                      return { act:'answer', kind:'question', conf:.8  };
  if (words > 25)                                    return { act:'brief',  kind:'context', conf:.4 };  // long statement → silent note only
  return { act:'ignore', why:'statement' };
}
```

`brief` = update a tiny context note but **do not repaint the prompter**. This is what stops
the strip from flickering while the interviewer explains the company for two minutes.

**Tunable aggressiveness** (Params → Autopilot):
`Conservative` (only `?` + explicit tasks) · `Balanced` (default) · `Eager` (any WH word).

---

## 5. Screenshots: crop to the problem, ignore the noise

Your exact complaint: the screen has the problem **plus** an IDE, a browser, Slack, a
timer, the interviewer's face. Sending the raw 3440×1440 frame makes the model comment on
the wrong thing and burns tokens.

### Three-layer fix, in order of cost

**Layer 1 — Content-region detection (local, free, ~15ms).**
Find the largest dense text block and crop to it plus 24px padding. This alone removes the
desktop, dock, wallpaper, and camera tile.

```js
// src/services/roi.service.js  (NEW) — pure JS on the raw bitmap, no native deps
function findTextRegion(bitmap, w, h){
  // 1. downscale to ~320px wide, grayscale
  // 2. local contrast: mark a cell "inky" if stddev of its 8x8 block > threshold
  // 3. row/column projection profiles → find the widest contiguous band of inky rows
  //    and the tallest contiguous band of inky columns
  // 4. return {x,y,w,h} in original coords, padded 24px, clamped
}
```
Fall back to full frame if the detected region is <15% or >90% of the screen.

**Layer 2 — Active-window crop (better, platform API).**
Ask the OS for the focused window's bounds and crop to exactly that. `desktopCapturer` is
already imported in `window.manager.js`; combine with `screen.getCursorScreenPoint()` to pick
the right display. **Always exclude our own windows** — never let the model read our prompter.

**Layer 3 — The prompt does the last mile.** Even a perfect crop has line numbers, tabs and
a file tree. So say it explicitly:

```
You are looking at a screenshot of a candidate's screen during a technical interview.

The screen contains MANY irrelevant elements: IDE chrome, file trees, tabs, line
numbers, terminals, browser bookmarks, chat windows, notifications, a video call tile.

STEP 1 — Silently identify the SINGLE coding problem, question, or error the candidate
must respond to. It is usually the largest block of prose or the visible stack trace.
STEP 2 — Ignore absolutely everything else. Do not describe the UI. Do not mention the
editor, the OS, or what app is open. Never say "the screenshot shows".
STEP 3 — If you cannot find a clear problem, reply with exactly: NO_PROBLEM_FOUND

Then answer using the output contract below.
```
`NO_PROBLEM_FOUND` → the prompter shows "no problem detected — Alt+S to retry" instead of
hallucinating. That escape hatch matters more than it looks.

**Layer 4 — Don't send the same screen twice.** Perceptual hash (dHash, 64-bit) of the
downscaled crop; if Hamming distance to the last sent frame < 6, skip the call entirely.
Saves your Groq/Gemini budget during Auto mode and stops duplicate answers.

### Auto-capture trigger (the zero-click part)
When the Intent Gate returns `kind:'task'` **or** the turn matches
`/\b(screen|this|here|shown|the problem|this code|the function|this error)\b/i`,
**fire a capture automatically** and send text+image together. You said "solve this" — you
never touched a key.

---

## 6. Answer contract — brief and correct

Two output modes, auto-selected by `kind`:

**A. Verbal question → `SPEAK` mode**
```
HEADLINE: <≤10 words, the thesis you open with>
- <≤14 words>
- <≤14 words>
- <≤14 words>
```
That's it. No preamble, no "Great question", no markdown headers. The Introduction /
Content / Conclusion structure from the Smog spec is right for the *Notes* export, but it
is **too long for the live strip** — generate it lazily, only when you press `Alt+↓`.

**B. Coding problem → `CODE` mode**
```
HEADLINE: <approach in ≤10 words, e.g. "Two pointers, O(n) time O(1) space">
- <key insight>
- <edge case>
```
```<lang>
<complete, runnable, commented-only-where-non-obvious solution>
```
Code goes to the **clipboard immediately and automatically** (`clipboard.writeText`), and
the strip shows `⌘V ready · 24 lines`. You paste. You never read the code off the overlay
and retype it — that's the thing that actually looks suspicious on camera.

**Model routing for speed** — this matters more than model quality here:
| Case | Model | Why |
|---|---|---|
| Verbal question | fastest chat model (Groq `llama-3.3-70b` / `gpt-oss-120b`) | 300ms first token |
| Coding problem | strongest available | correctness > speed, you have 30s |
| Screenshot | Gemini flash (already wired) | vision + cheap |

Set `maxOutputTokens: 220` for SPEAK mode. A hard cap is more reliable than asking nicely.

---

## 7. Keyboard-only control surface

**Design rule: every live action is one chord, all on the left hand, no modifier gymnastics.**
Right hand stays on the mouse for the shared editor.

| Chord | Action | Why this key |
|---|---|---|
| `Alt+Space` | **Panic hide / show everything** | biggest, most-reachable key |
| `Alt+A` | Autopilot on/off | "A" for auto |
| `Alt+S` | Capture screen now → answer | "S" for screen |
| `Alt+D` | Re-answer last question, **deeper** | "D" for deeper |
| `Alt+F` | Re-answer, **shorter** | "F" for fast |
| `Alt+C` | Copy code block | "C" for copy |
| `Alt+↓` / `Alt+↑` | More detail / back to summary | natural |
| `Alt+←` / `Alt+→` | Previous / next answer in history | natural |
| `Alt+B` | Blackout (max contrast) | from Smog spec |
| `Alt+1..3` | Opacity 30% / 60% / 100% | your visibility ask |
| **Hold `Alt`** | Reveal a 4-key hint bar under the strip | discoverability without clutter |

Implementation note: register with `globalShortcut` (`main.js:429` already has the wrapper).
**Verify every registration returns true** and show conflicts in Params → Shortcuts —
`Alt+Space` collides with a few window managers, so ship a fallback (`Alt+Q`).

### Push-to-ask (the one thing worth a held key)
Hold `Alt+W`, whisper your own question ("what's the time complexity"), release → it's sent
as an explicit ask, tagged `speaker:'you'`, bypassing the Intent Gate. Lets you steer
without typing.

---

## 8. Visibility control (your explicit ask)

Four independent levers, all keyboard, all instant:

1. **Panic hide** `Alt+Space` — `hide()` on every window in <16ms. Not opacity, not
   minimise: real hide, so nothing can be captured mid-frame. Re-press restores exact
   positions. **This must be the fastest path in the whole app** — pre-resolve the window
   list, no async, no logging on that path.
2. **Opacity ladder** `Alt+1/2/3` → `win.setOpacity(0.3|0.6|1.0)`. 30% is "I know roughly
   what it says", 100% is "let me read the code". Persist last used.
3. **Auto-hide on screen-share start** — already in `window.manager.js`
   (`isScreenBeingShared`). Extend it: also auto-hide when a **new display is connected**
   (classic "can you plug into the TV" moment) and when the machine locks/sleeps.
4. **Auto-dim on inactivity** — strip fades to 35% after 25s, back to full on new content.

Plus the safety net: `setContentProtection(true)` everywhere means even at 100% opacity the
strip is absent from the share. The opacity ladder is for **your own** comfort and for the
person physically behind you, not for the call.

**One more thing worth building: a "hide on webcam attention" heuristic.** If the interview
is on camera and you're visibly reading, that's the tell — not the software. Consider a
setting that keeps the strip within ~15° of the camera (top-centre, under the notch) so your
eyeline stays natural. This is a positioning default, not a feature.

---

## 9. What to do with the panels you already built

Don't throw them away — **re-scope them**:

| Panel | New role |
|---|---|
| **Listen** | Pre-interview mic/loopback check + post-interview transcript review. Not open during the call. |
| **Vision** | Debug view for what got cropped and sent. Invaluable while tuning §5. Not open during the call. |
| **Ask** | Typed follow-ups during *take-home* / async work, where you do have a free hand. |
| **Notes** | Post-interview. This is where the full Intro/Content/Conclusion write-up lives. |
| **Params** | Pre-interview config. |
| **Prompter** *(new)* | **The only thing open during the interview.** |

Add an **"Interview Mode"** master toggle: one keypress before the call →
closes every panel, opens the prompter, starts Listen, enables Autopilot, sets opacity,
mutes all notifications. One keypress after → stops, generates the note, reopens Notes.
That's the "chill" you're asking for: two keystrokes bracket the whole session.

```js
async function enterInterviewMode(){
  await windowManager.closeAllPanels();
  await windowManager.showPrompter();
  windowManager.setPrompterInteractive(false);   // click-through
  await speechService.start();
  autopilot.enable();
  app.setBadgeCount?.(0);
  // suppress our own notifications for the duration
}
```

---

## 10. Latency budget (the real product spec)

Target: **interviewer stops talking → headline on screen ≤ 2.0s.** Budget it:

| Stage | Budget | How to hit it |
|---|---|---|
| VAD close | 500ms | already tuned; silence hangover 450–600ms |
| Turn aggregation | 0–1800ms | hidden by speculative call (§3) |
| STT (Groq turbo) | 300–600ms | 8–15s chunks, keep-alive HTTP agent |
| Intent gate | <1ms | local regex |
| Screenshot (if any) | 250ms | capture at 1/2 scale, crop before encode, JPEG q70 |
| LLM first token | 300–500ms | Groq, streaming, short system prompt, `max_tokens` capped |
| Render | 16ms | pre-mounted DOM nodes, no layout thrash |

**Pre-warm everything at Interview Mode start:** open the STT connection, send a 1-token
LLM ping, pre-capture one frame. Cold-start on the first real question is the difference
between "wow" and "useless".

Instrument it: log `t_vad_close → t_first_token` per turn and show a p50/p95 in Params →
Advanced. If p95 > 3s the product doesn't work, and you need to know that before the call,
not during it.

---

## 11. Build order for this phase

| # | Deliverable | Files | Done when |
|---|---|---|---|
| 1 | Prompter window (`focusable:false`, click-through, fixed position) | `panels/prompter.html`, `window.manager.js` | Strip shows, never steals focus, mouse clicks pass through |
| 2 | Keyboard map + panic hide + opacity ladder | `main.js`, `window.manager.js` | Every chord works, panic hide <16ms |
| 3 | Turn Aggregator + Intent Gate | `turn-aggregator.js`, `intent-gate.js`, `speech.service.js` | 3-part question = 1 answer; "okay cool" = 0 answers |
| 4 | Answer contract + streaming into strip + auto-clipboard | `llm.service.js`, prompter renderer | Headline ≤2s, code auto-copied |
| 5 | ROI crop + dHash dedupe + noise-rejection prompt | `roi.service.js`, `capture.service.js`, `prompts/vision.md` | Cluttered screenshot → answer only about the problem |
| 6 | Interview Mode master toggle + pre-warm | `main.js`, `window.manager.js` | Two keystrokes bracket a session |
| 7 | Speculative call + latency instrumentation | `llm.service.js` | p95 < 3s logged |

---

## 12. How to test it without an interview

Build `scripts/simulate-interview.js`: replay a WAV of a real mock interview through the
same pipeline, assert on the outputs.

```js
// asserts that matter
assert(turns.length === expectedQuestions.length);      // aggregation is right
assert(answers.every(a => a.headline.split(' ').length <= 10));
assert(answers.every(a => a.bullets.length <= 3));
assert(p95(latencies) < 3000);
assert(ignored.includes('okay cool got it'));           // gate is right
```

And a fixture set for §5: 10 real cluttered screenshots (LeetCode + IDE + Slack + video
tile) with the expected problem statement. Assert the model's answer mentions the problem's
key term and **never** mentions "VS Code", "Chrome", or "the screenshot".

That suite is what lets you change prompts without fear the week before an interview.

---

## TL;DR of my recommendation

1. **Add a Prompter strip and make it the only live surface.** Panels become prep/review.
2. **Autopilot by default** — VAD → aggregate → gate → answer, no click in the loop.
3. **Turn Aggregator** fixes the "additions" problem; speculative calls hide its latency.
4. **Intent Gate** stops it answering "okay, cool".
5. **Crop screenshots before sending** + an explicit ignore-the-chrome prompt + a
   `NO_PROBLEM_FOUND` escape hatch.
6. **Hard length caps** (10-word headline, 3×14-word bullets) and **auto-clipboard for code.**
7. **All-left-hand keyboard map**, `Alt+Space` panic hide, `Alt+1/2/3` opacity.
8. **Interview Mode**: two keystrokes bracket the session.
9. **Budget 2s end-to-end** and instrument it — that number is the product.
