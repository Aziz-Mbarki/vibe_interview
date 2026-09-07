# OpenCluely → "Smog-grade" UI & Feature Spec

**Audience:** the AI dev agent (or human dev) working in this repo.
**Goal:** rebuild the OpenCluely overlay UX to match the quality bar of https://smog-ai.com
(hub bar + Listen / Vision / Ask / Notes / Params panels), **without rewriting the app**.
Everything below is expressed as *deltas against the files that already exist here*.

> Rule #1: **Do not fork the architecture.** We keep Electron main + `WindowManager` +
> `preload.js` contextBridge + per-window HTML files. We add panels as new window types
> and re-skin the existing ones with a shared design system.

---

## 0. What Smog actually does (the model we are copying)

Smog is a macOS/Windows Electron-style overlay with **one small always-on-top hub bar** and
**detachable translucent panels**. Its product surface:

| Pillar | What it is | Our current equivalent |
|---|---|---|
| **Listen** | Live transcription with speaker separation, session timer/quota chip, live "Question:" extraction, structured answer (Introduction / Content bullets / Conclusion) | `src/services/speech.service.js` + `chat.html` (raw transcript only) |
| **Vision** | Screen capture → code/UI extraction, `Auto` / `On question` modes, "Analyzing screen…" activity state | `capture.service.js` + `llm-response.html` |
| **Ask** | Chat that is *contextually fed by the Listen transcript* ("Using Listen context") | `chat.html` (no listen context) |
| **Notes** | Auto-generated note per session; editable; export PDF / MD / Email / Copy | **missing** |
| **Params** | Response types (General, Meeting, Pro, School, Tech Dev), language detection, themes, shortcuts | partially in `settings.html` |
| **Cross-features** | Full stealth, detach/attach, blackout shortcut, themes & colors, live activity log, history + auto-clean, exports | stealth ✅, rest ❌ |

**The design signature to reproduce:**
1. A **hub bar** (pill) with 5 tabs: `Listen · Vision · Ask · Notes · Params`.
2. Each tab opens a **panel** — a translucent dark card, heavy blur, 1px hairline border,
   large radius (16–18px), soft shadow, **no OS chrome**.
3. Every panel has the **same header grammar**: title-left, *status chip* + *quota chip* right.
4. A **quota/session chip** always visible: `5h | 0% | rest 4h55m`.
5. Content is **card-in-card**: rounded 12px subsections on a slightly lighter surface.
6. **Activity line**: a live one-liner telling the user what the AI is doing right now
   ("Listening…", "Analyzing screen…", "Thinking…").
7. Panels are **detachable** and **snap back** into a bound stack.

---

## 1. Design system (do this FIRST — everything else depends on it)

### 1.1 New file: `src/styles/tokens.css`
Already scaffolded in this repo (see `src/styles/tokens.css`). Import it at the top of
`src/styles/common.css` **before** anything else:

```css
@import url('./tokens.css');
```

Then delete hard-coded colors in `index.html`, `chat.html`, `llm-response.html`,
`settings.html` and replace them with the variables. Mechanical pass:

| Old value | New token |
|---|---|
| `rgba(0,0,0,0.3) → rgba(20,20,20,0.4)` gradient | `var(--surface-1)` |
| `rgba(255,255,255,0.1)` border | `var(--border-1)` |
| `backdrop-filter: blur(25px)` | `var(--blur-panel)` |
| `border-radius: 12px` | `var(--r-panel)` |
| `#4caf50` | `var(--accent)` |
| `#ff4757` | `var(--danger)` |
| `rgba(255,255,255,0.9)` text | `var(--text-1)` |
| `rgba(255,255,255,0.6)` text | `var(--text-2)` |

### 1.2 Type scale
- Panel title `13px/600`, section label `11px/600 uppercase, letter-spacing .06em`,
  body `13px/1.55`, meta `11px`, mono `12px` (`ui-monospace, SFMono-Regular, Menlo`).
- Font stack: keep the existing `-apple-system, BlinkMacSystemFont, 'Segoe UI'`, but add
  `'Inter'` first if you bundle it (recommended — Smog's look is Inter/Geist-ish).

### 1.3 Motion
- All hover/state: `120ms cubic-bezier(.2,.8,.2,1)`.
- Panel open: `opacity 0→1` + `translateY(6px→0)` + `scale(.985→1)` over `180ms`.
- Never animate `backdrop-filter` (Electron repaint cost).

### 1.4 Themes
Add `data-theme="dark|light"` on `<html>`; tokens.css already defines both plus an
`--accent` override so "Themes & Colors" (Smog cross-feature) is a 1-line change:
```js
document.documentElement.dataset.theme = s.theme;         // 'dark' | 'light'
document.documentElement.style.setProperty('--accent', s.accentColor); // '#22c55e'
```
Persist in settings (`ipcMain.handle('save-settings')` already exists in `main.js:863`).

---

## 2. The Hub Bar (replaces the current `index.html` command tab)

### 2.1 Visual spec
- Size: `height 44px` (currently 28 — too cramped for Smog's look), `useContentSize: true`,
  auto width, `border-radius: 999px` (full pill, not 8px).
- Background `var(--surface-hud)`, border `var(--border-1)`, shadow `var(--shadow-hud)`.
- Layout: `[● status] [Listen] [Vision] [Ask] [Notes] [Params] │ [quota chip] [⋯]`
- Tab = icon + label; active tab gets a **pill background** `var(--surface-3)` + accent icon,
  never a colored text glow (drop the current `text-shadow` glow — it reads cheap).
- The whole bar is `-webkit-app-region: drag`; every button is `no-drag` (already the pattern).

### 2.2 Markup (drop-in replacement for the `<div class="command-tab">` block in `index.html`)

```html
<div class="hub" id="hub">
  <span class="hub-dot" id="statusDot" title="Interaction state"></span>

  <nav class="hub-tabs" role="tablist">
    <button class="hub-tab" data-panel="listen" role="tab">
      <i class="fas fa-waveform-lines"></i><span>Listen</span>
      <span class="hub-live" hidden></span>
    </button>
    <button class="hub-tab" data-panel="vision" role="tab">
      <i class="fas fa-eye"></i><span>Vision</span>
    </button>
    <button class="hub-tab" data-panel="ask" role="tab">
      <i class="fas fa-comment-dots"></i><span>Ask</span>
    </button>
    <button class="hub-tab" data-panel="notes" role="tab">
      <i class="fas fa-note-sticky"></i><span>Notes</span>
    </button>
    <button class="hub-tab" data-panel="params" role="tab">
      <i class="fas fa-sliders"></i><span>Params</span>
    </button>
  </nav>

  <span class="hub-sep"></span>
  <div class="quota-chip" id="quotaChip">
    <b id="quotaTotal">5h</b><i>|</i><span id="quotaPct">0%</span><i>|</i>
    <span id="quotaRest">rest 4h55m</span>
  </div>
  <button class="hub-icon" id="hubMore" title="Shortcuts"><i class="fas fa-ellipsis"></i></button>
</div>
```

### 2.3 CSS (append to `src/styles/common.css`)

```css
.hub{
  display:flex; align-items:center; gap:6px; height:44px; padding:0 8px 0 12px;
  background:var(--surface-hud); backdrop-filter:var(--blur-hud);
  border:1px solid var(--border-1); border-radius:999px;
  box-shadow:var(--shadow-hud); -webkit-app-region:drag; user-select:none;
}
.hub-dot{width:8px;height:8px;border-radius:50%;background:var(--danger);flex:0 0 auto;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--danger) 25%,transparent);transition:var(--t)}
.hub-dot.interactive{background:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.hub-tabs{display:flex;align-items:center;gap:2px;-webkit-app-region:no-drag}
.hub-tab{
  display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border:0;
  border-radius:999px;background:transparent;color:var(--text-2);
  font:600 12px/1 var(--font);cursor:pointer;transition:var(--t);white-space:nowrap;
}
.hub-tab i{font-size:13px}
.hub-tab:hover{background:var(--surface-2);color:var(--text-1)}
.hub-tab[aria-selected="true"]{background:var(--surface-3);color:var(--text-0)}
.hub-tab[aria-selected="true"] i{color:var(--accent)}
.hub-live{width:6px;height:6px;border-radius:50%;background:var(--danger);
  animation:blink 1.4s infinite}
@keyframes blink{50%{opacity:.25}}
.hub-sep{width:1px;height:18px;background:var(--border-1);flex:0 0 auto}
.quota-chip{
  display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
  border-radius:999px;background:var(--surface-2);border:1px solid var(--border-1);
  color:var(--text-2);font:500 11px/1 var(--font);-webkit-app-region:no-drag;
}
.quota-chip b{color:var(--text-0);font-weight:700}
.quota-chip i{opacity:.35;font-style:normal}
.hub-icon{width:30px;height:30px;border-radius:50%;border:0;background:transparent;
  color:var(--text-2);cursor:pointer;-webkit-app-region:no-drag;transition:var(--t)}
.hub-icon:hover{background:var(--surface-2);color:var(--text-0)}

/* collapsed / stealth-lite mode: only the dot + active tab remain */
.hub.is-compact .hub-tab:not([aria-selected="true"]),
.hub.is-compact .quota-chip{display:none}
```

### 2.4 Behaviour (`src/ui/main-window.js`)
```js
const hub = document.getElementById('hub');
let openPanel = null;

hub.querySelectorAll('.hub-tab').forEach(tab => {
  tab.addEventListener('click', () => selectPanel(tab.dataset.panel));
});

async function selectPanel(name){
  const next = openPanel === name ? null : name;   // click active tab = close (toggle)
  hub.querySelectorAll('.hub-tab').forEach(t =>
    t.setAttribute('aria-selected', String(t.dataset.panel === next)));
  openPanel = next;
  await window.electronAPI.setActivePanel(next);   // new IPC, see §6
}
```
Keep every existing shortcut working: `Cmd+Shift+C` → `selectPanel('ask')`,
`Alt+R` → toggles Listen, `Cmd+Shift+S` → Vision capture, `Cmd+,` → `selectPanel('params')`.

---

## 3. Panels

All panels share one shell. Create **`src/styles/panel.css`** and import it in every panel HTML.

```css
.panel{
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
  background:var(--surface-1);backdrop-filter:var(--blur-panel);
  border:1px solid var(--border-1);border-radius:var(--r-panel);
  box-shadow:var(--shadow-panel);color:var(--text-1);font:400 13px/1.55 var(--font);
}
.panel-head{
  display:flex;align-items:center;gap:10px;height:46px;padding:0 14px;flex:0 0 auto;
  border-bottom:1px solid var(--border-1);background:var(--surface-2);
  -webkit-app-region:drag;
}
.panel-title{display:flex;align-items:center;gap:8px;font:600 13px/1 var(--font);color:var(--text-0)}
.panel-title i{color:var(--accent)}
.panel-head .spacer{flex:1}
.panel-head button{-webkit-app-region:no-drag}
.panel-body{flex:1;overflow:auto;padding:14px;-webkit-app-region:no-drag}
.panel-foot{flex:0 0 auto;padding:10px 14px;border-top:1px solid var(--border-1);
  background:var(--surface-2);-webkit-app-region:no-drag}

.card{background:var(--surface-2);border:1px solid var(--border-1);
  border-radius:var(--r-card);padding:12px}
.card + .card{margin-top:10px}
.label{font:600 11px/1 var(--font);letter-spacing:.06em;text-transform:uppercase;
  color:var(--text-3);margin-bottom:8px}

.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;
  border-radius:999px;background:var(--surface-3);border:1px solid var(--border-1);
  font:600 11px/1 var(--font);color:var(--text-2)}
.chip.is-live{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,transparent)}
.chip.is-ok{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 35%,transparent)}

/* the "Live Activity" line — Smog's signature */
.activity{display:flex;align-items:center;gap:8px;font:500 11px/1 var(--font);
  color:var(--text-3);padding:8px 14px;border-top:1px solid var(--border-1)}
.activity .pulse{width:6px;height:6px;border-radius:50%;background:var(--accent);
  animation:pulseDot 1.2s infinite}
@keyframes pulseDot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.6);opacity:.4}}
```

Every panel HTML skeleton:
```html
<body>
  <section class="panel">
    <header class="panel-head">
      <div class="panel-title"><i class="fas fa-eye"></i> Vision</div>
      <div class="spacer"></div>
      <span class="chip" id="quota">5h | 0% | rest 4h55m</span>
      <button class="hub-icon" data-act="detach" title="Detach"><i class="fas fa-up-right-from-square"></i></button>
      <button class="hub-icon" data-act="close"><i class="fas fa-xmark"></i></button>
    </header>
    <div class="panel-body"><!-- panel content --></div>
    <div class="activity" id="activity"><span class="pulse"></span><span>Idle</span></div>
  </section>
</body>
```

### 3.1 Listen — `panels/listen.html` (new)
Reuses `speech.service.js` unchanged; only the renderer changes.

Content:
1. **Control card**: big `Start / Stop` button (accent filled when idle, danger outline when
   recording), mode chip (`Free mode` / `Pro`), elapsed timer, waveform.
2. **Transcript stream**: one row per utterance —
   `[speaker pill][hh:mm:ss] text`. Interim text renders at `opacity:.55` italic and is
   replaced in place when final (this repo already emits interim via `interim-overlay`).
3. **Detected question card** — when `skill-router.service.js` classifies an utterance as a
   question, pin it at top: `Question: "So, what's your experience with distributed systems?"`
4. **Structured answer card** — render the LLM answer in Smog's three-part shape:
   `Introduction` (1 sentence) → `Content` (3–5 bullets) → `Conclusion` (1 sentence).
   Enforce it in the prompt, not the UI (see §5).

Speaker separation (new, cheap version): tag utterances by **audio source** —
mic = `You`, system/loopback = `Them`. That covers 95% of interview value without a
diarization model. `speech.service.js` already knows which stream a chunk came from; emit
`{ speaker: 'you'|'them' }` in the transcript event payload.

```css
.utt{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--border-0)}
.utt .spk{flex:0 0 auto;height:20px;padding:0 8px;border-radius:999px;font:700 10px/20px var(--font)}
.utt[data-spk="you"]  .spk{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.utt[data-spk="them"] .spk{background:color-mix(in srgb,var(--info) 18%,transparent);color:var(--info)}
.utt .t{flex:0 0 auto;color:var(--text-3);font:500 11px/20px var(--font)}
.utt.is-interim .txt{opacity:.55;font-style:italic}
```

### 3.2 Vision — reuse `llm-response.html`, restyle + add modes
Add to the header: a segmented control `Auto | On question | Manual`.
- `Auto`: capture every N seconds while Listen is active *only if the screen changed*
  (cheap hash of a downscaled frame — do NOT send identical frames to the model).
- `On question`: capture only when Listen detects a question.
- `Manual`: current `Cmd+Shift+S` behaviour.

```html
<div class="seg" role="radiogroup">
  <button class="seg-btn" data-mode="auto">Auto</button>
  <button class="seg-btn is-on" data-mode="question">On question</button>
  <button class="seg-btn" data-mode="manual">Manual</button>
</div>
```
```css
.seg{display:inline-flex;padding:2px;gap:2px;background:var(--surface-3);
  border:1px solid var(--border-1);border-radius:999px}
.seg-btn{border:0;background:transparent;color:var(--text-2);height:24px;padding:0 10px;
  border-radius:999px;font:600 11px/1 var(--font);cursor:pointer;transition:var(--t)}
.seg-btn.is-on{background:var(--surface-1);color:var(--text-0);box-shadow:var(--shadow-1)}
```
Keep the existing streaming renderer and Prism highlighting in `llm-response-window.js` —
just wrap code blocks in the new `.codecard` (header with language + copy button).

### 3.3 Ask — reuse `chat.html`, restyle + Listen context
Add above the composer:
```html
<label class="ctx-toggle">
  <input type="checkbox" id="useListenCtx" checked>
  <span>Using Listen context</span><span class="chip" id="ctxCount">12 utterances</span>
</label>
```
Implementation: in `ipcMain.handle('send-chat-message')` (`main.js:640`), when the flag is on,
prepend the last N (default 20) transcript turns from `session.manager.js` to the prompt.
Add `sessionManager.getRecentTranscript(n)` if it doesn't exist.

Message bubbles: user right-aligned `var(--surface-3)`, AI left-aligned transparent with an
accent left border. Streaming: append tokens into the last bubble and show a 3-dot pulse.

### 3.4 Notes — `panels/notes.html` (NEW FEATURE, the biggest gap)
Behaviour:
- On **Listen stop**, auto-generate a note: `{ id, title, createdAt, durationMs, summary,
  keyPoints[], decisions[], actionItems[], questions[], transcriptRef }` → JSON file in
  `~/.OpenCluely/notes/<id>.json` (`config.appDataDir` already exists).
- List view (left, 220px) + editor (right). Editor is a `contenteditable` markdown surface;
  save debounced 500ms.
- Buttons: `Copy` · `Markdown` · `PDF` · `Email`.
  - PDF: `BrowserWindow.webContents.printToPDF()` on a hidden window rendering the note HTML.
  - Email: `shell.openExternal('mailto:?subject=…&body=…')`.
  - Markdown: `dialog.showSaveDialog` + `fs.writeFile`.
- Manual notes: `+ New note`.
- Auto-clean: on boot, delete notes older than `settings.notesRetentionDays` (default 30).

```js
// main.js — new handlers
ipcMain.handle('notes:list',   () => notesService.list());
ipcMain.handle('notes:get',    (e,id) => notesService.get(id));
ipcMain.handle('notes:save',   (e,note) => notesService.save(note));
ipcMain.handle('notes:delete', (e,id) => notesService.remove(id));
ipcMain.handle('notes:export', (e,{id,format}) => notesService.export(id, format));
```
Create `src/services/notes.service.js` mirroring the style of `session.manager.js`.

### 3.5 Params — upgrade `settings.html`
Left rail of sections (Smog-style), right pane of controls:
`General · Response types · Languages · Shortcuts · Appearance · Privacy · Advanced`.

- **Response types** = the existing `prompts/*.md` presets, surfaced as selectable cards:
  `General · Meeting · Pro · School · Tech Dev · DSA · System Design · Behavioral`.
  Map to `prompt-loader.js`; adding a preset = adding a `.md` file. Wire to the existing
  `set-interview-preset` handler (`main.js:885`).
- **Languages**: `Auto-detect` toggle + list (fr/en/es/de/it/pt/ja/zh/hi/fa — same set Smog
  advertises). Feeds `speech.service.js` language and an instruction line in the prompt.
- **Shortcuts**: editable accelerators, recorded by keydown, re-registered via
  `globalShortcut.unregisterAll()` + re-register (see `main.js:429`). Must include Smog's four:
  Quick Hide, Push-to-Ask, Start/Stop Listen, Toggle Vision.
- **Appearance**: theme, accent swatches, panel opacity slider (`--surface-alpha`),
  **Blackout** toggle (forces `--surface-1: rgba(0,0,0,.92)` for max readability — Smog's
  "Blackout Shortcut", bind to `Cmd+Shift+B`).
- **Privacy**: kill-switch (blocks all network via
  `session.defaultSession.webRequest.onBeforeRequest` → cancel), offline mode, wipe all data,
  export all data.

---

## 4. Window plumbing (`src/managers/window.manager.js`)

Add the panel windows to `windowConfigs`:

```js
const PANEL_BASE = {
  frame:false, transparent:true, hasShadow:false, skipTaskbar:true,
  resizable:true, alwaysOnTop:true, visibleOnAllWorkspaces:true, fullscreenable:false,
  backgroundColor:'#00000000'
};
listen : { ...PANEL_BASE, width:420, height:560, file:'panels/listen.html', title:'Listen' },
vision : { ...PANEL_BASE, width:840, height:520, file:'llm-response.html', title:'Vision' },
ask    : { ...PANEL_BASE, width:460, height:640, file:'chat.html',        title:'Ask'   },
notes  : { ...PANEL_BASE, width:820, height:600, file:'panels/notes.html', title:'Notes'},
params : { ...PANEL_BASE, width:720, height:560, file:'settings.html',     title:'Params'},
```

Add three methods:

```js
/** Only one docked panel visible at a time; detached panels stay open. */
async setActivePanel(name){
  for (const key of ['listen','vision','ask','notes','params']) {
    const w = this.windows.get(key);
    if (!w || w.isDestroyed()) continue;
    if (this.detached.has(key)) continue;      // detached panels are user-managed
    if (key === name) { this.showOnCurrentDesktop(w); }
    else w.hide();
  }
  this.activePanel = name;
  if (this.bindWindows) this.positionBoundWindows();
}

/** Detach: panel stops following the hub, gets its own position + resizable frame-less card. */
detachPanel(name){ this.detached.add(name); }
attachPanel(name){ this.detached.delete(name); this.positionBoundWindows(); }
```

`positionBoundWindows()` must be updated to lay out **only the active docked panel**
directly under the hub bar, centred on the hub's X, `windowGap` px below.
Keep `setContentProtection(true)` on every new window — that is the stealth guarantee
(line ~650 already does it; make sure the new types go through the same code path in
`createWindow`).

**Blackout:** broadcast to all windows and toggle a class:
```js
blackout(on){ this.windows.forEach(w => w.webContents.send('ui:blackout', on)); }
```
```js
// in every panel renderer
window.electronAPI.on('ui:blackout', on => document.documentElement.classList.toggle('blackout', on));
```
```css
html.blackout{--surface-1:rgba(0,0,0,.94);--surface-2:rgba(255,255,255,.04);--blur-panel:blur(4px)}
```

---

## 5. Prompting changes (so the UI has structured data to render)

`src/services/llm.service.js` — for Listen/Ask answers, request a strict shape and parse it:

```
Answer in EXACTLY this structure, nothing else:

## Introduction
<one sentence, max 20 words>

## Content
- <bullet, max 18 words>
- <bullet>
- <bullet>

## Conclusion
<one sentence, max 15 words>
```
Parse with a tiny splitter and render each part into its own `.card`. If parsing fails,
fall back to the existing markdown renderer (`lib/markdown.js`) — never show a broken panel.

For Vision, keep the current router (`skill-router.service.js`) but add a first-pass
classification: `{ kind: 'code' | 'ui' | 'text' | 'diagram' }` so the panel can pick the right
presentation (code card vs. bullet insights).

---

## 6. New IPC surface (`preload.js`)

Append to the `electronAPI` bridge — keep the existing naming style:

```js
// Panels
setActivePanel: (name) => ipcRenderer.invoke('set-active-panel', name),
detachPanel:    (name) => ipcRenderer.invoke('detach-panel', name),
attachPanel:    (name) => ipcRenderer.invoke('attach-panel', name),
setBlackout:    (on)   => ipcRenderer.invoke('set-blackout', on),

// Listen
getTranscript:  (n)    => ipcRenderer.invoke('listen:transcript', n),
onUtterance:    (cb)   => ipcRenderer.on('listen:utterance', (_e,d) => cb(d)),

// Vision
setVisionMode:  (mode) => ipcRenderer.invoke('vision:set-mode', mode),

// Notes
notes: {
  list:  ()          => ipcRenderer.invoke('notes:list'),
  get:   (id)        => ipcRenderer.invoke('notes:get', id),
  save:  (n)         => ipcRenderer.invoke('notes:save', n),
  remove:(id)        => ipcRenderer.invoke('notes:delete', id),
  export:(id,format) => ipcRenderer.invoke('notes:export', {id, format}),
},

// Quota / activity
onQuota:    (cb) => ipcRenderer.on('quota:update',    (_e,d) => cb(d)),
onActivity: (cb) => ipcRenderer.on('activity:update', (_e,d) => cb(d)),
```

**Activity bus** (Smog's "Live Activity" / transparency promise): every service emits
`activity:update` with `{ stage, detail, at }` — e.g.
`{stage:'vision', detail:'Analyzing screen…'}`, `{stage:'llm', detail:'Streaming answer'}`,
`{stage:'idle'}`. One helper in `src/core/logger.js`:
```js
function emitActivity(stage, detail){ BrowserWindow.getAllWindows()
  .forEach(w => !w.isDestroyed() && w.webContents.send('activity:update',{stage,detail,at:Date.now()})); }
```

---

## 7. Build order (ship in vertical slices, each one independently testable)

| Phase | Deliverable | Files touched | Definition of done |
|---|---|---|---|
| **1** | Design tokens + panel shell CSS | `src/styles/tokens.css`, `common.css`, `panel.css` | All 4 existing windows use tokens; zero hard-coded hex outside tokens.css |
| **2** | Hub bar redesign | `index.html`, `src/ui/main-window.js`, `window.manager.js` (height 44) | 5 tabs render, toggle, keep drag + all old shortcuts |
| **3** | Panel window types + `setActivePanel` + docking | `window.manager.js`, `main.js`, `preload.js` | Clicking a tab shows exactly one panel snapped under the hub; content protection ON |
| **4** | Ask + Vision restyle to the panel shell | `chat.html`, `llm-response.html` + their UI js | Visually identical grammar; streaming still works |
| **5** | Listen panel (speaker tags, question pin, structured answer) | `panels/listen.html`, `speech.service.js`, `llm.service.js` | Live transcript with You/Them, question card, 3-part answer |
| **6** | Notes service + panel + exports | `src/services/notes.service.js`, `panels/notes.html`, `main.js` | Auto-note on Listen stop; edit; Copy/MD/PDF/Email work |
| **7** | Params redesign (response types, languages, shortcuts, appearance, privacy) | `settings.html`, `settings-window.js`, `config.js` | Editable shortcuts persist and re-register; theme/accent/blackout live-apply |
| **8** | Detach/attach, blackout shortcut, activity bus, quota chip, auto-clean | `window.manager.js`, `logger.js`, all panels | All Smog cross-features present |

**Do not start a phase before the previous one is merged and the app boots** (`npm run dev`).

---

## 8. Non-negotiables / guardrails

1. **Stealth must never regress.** Every new `BrowserWindow` goes through
   `WindowManager.createWindow()` so it inherits `setContentProtection(true)`,
   `skipTaskbar`, `visibleOnAllWorkspaces`, and the always-on-top enforcement. Add a smoke
   test in `scripts/` that asserts `win.isContentProtected?.() !== false` for all windows.
2. **`contextIsolation: true` / `nodeIntegration: false` stay as they are** (`config.js:27`).
   All new capability goes through `preload.js`. No `require` in renderers.
3. **Never block the main process.** Notes export, PDF render, screen hashing → async.
4. **Keep transparency + blur cheap:** `blur(24px)` max on panels, `blur(18px)` on the hub.
   On Linux, transparency+blur is unreliable — detect `process.platform === 'linux'` and fall
   back to `--surface-1: rgba(12,12,14,.96)` with no blur.
5. **Local-first, like Smog's claim:** transcripts and notes stay in `~/.OpenCluely/`.
   Only the minimal prompt text leaves the device. Surface that in Params → Privacy.
6. **Accessibility:** every icon-only button needs `title` + `aria-label`; focus ring
   `outline: 2px solid var(--accent); outline-offset: 2px` — do not remove it.
7. **Don't copy Smog's branding, copy, or images.** Reproduce the *interaction and layout
   quality*, write our own strings, keep the OpenCluely name and MIT license.

---

## 9. Quick self-check before calling a phase done

```bash
npm run dev              # app boots, hub visible, no console errors
node scripts/test-router.js
node scripts/test-speech.js
```
- Start a Zoom/Meet screen share → the hub and every open panel are invisible in the share.
- `Cmd+Shift+V` hides everything instantly; `Cmd+Shift+B` blacks out; `Alt+A` toggles
  click-through and the hub dot changes color.
- Resize a panel → content reflows, no clipped headers, no scrollbar on the shell.
