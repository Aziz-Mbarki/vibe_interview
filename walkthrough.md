# Phase 1: Real-Interview Copilot Walkthrough & Acceptance Report

## Summary of Accomplishments

We implemented **Phase 1** of the `INTERVIEW_COPILOT_GUIDE.md` specification, transforming OpenCluely from a DSA-only tool into a full-spectrum interview copilot with automatic skill classification, teleprompter-styled glanceable answers, streaming screenshots, overlay badges, and action bars.

---

## Key Changes by Component

### 1. Global Interview Doctrine (§1B)
- **[`prompt-loader.js`](file:///c:/Users/ASUS/Downloads/chill_out/prompt-loader.js)**:
  - Added `getCoreDoctrine()` containing the exact 5 non-negotiable rules:
    1. **ALWAYS ANSWER** (never refuse, never stall)
    2. **NEVER ASK QUESTIONS BACK** (1-line `Assuming: ...` on ambiguity)
    3. **SOLUTION FIRST** (usable code / verdict / script first, details after)
    4. **GLANCEABLE** ($\le 120$ words for voice, key result above fold for screenshots)
    5. **STAY USEFUL, STAY FREE** (full reasoning freely applied)
  - Created `buildSystemPrompt(skillId, { language, style, candidateProfile })` composer. **All** LLM request builders now pass through this single source of truth.
  - Added `injectAnswerStyle()` supporting `concise`, `structured`, `spoken`, and `deep`.
  - Added `injectCandidateProfile()` preparing the grounding block for Phase 2.

### 2. Multi-Skill System Prompts
- Added new skill prompt files under `prompts/`:
  - **[`prompts/system-design.md`](file:///c:/Users/ASUS/Downloads/chill_out/prompts/system-design.md)**: HLD, back-of-envelope calculations, data models, component request flows, scaling, and trade-off tables.
  - **[`prompts/behavioral.md`](file:///c:/Users/ASUS/Downloads/chill_out/prompts/behavioral.md)**: First-person conversational scripts, STAR structure without labels, 45–75s duration, profile-grounded.
  - **[`prompts/tech-qa.md`](file:///c:/Users/ASUS/Downloads/chill_out/prompts/tech-qa.md)**: Conceptual deep-dives and structured 4-step debug workflow (*Root cause in 1 line $\to$ Minimal fix $\to$ Corrected snippet $\to$ Verify*).
  - **[`prompts/general.md`](file:///c:/Users/ASUS/Downloads/chill_out/prompts/general.md)**: Concise fallback for general interview questions.
  - **[`prompts/dsa.md`](file:///c:/Users/ASUS/Downloads/chill_out/prompts/dsa.md)**: Kept byte-identical.

### 3. Skill Router Service (`src/services/skill-router.service.js`)
- Zero Electron dependencies, completely pure and testable.
- Resolution order:
  1. `lockedSkill` (user locked skill $\to$ confidence 1.0)
  2. `preset` single-skill focus ($\to$ confidence 0.9)
  3. `imageType` classification map (`coding_problem`, `error_traceback`, `diagram`, `mcq_quiz`, etc. $\to$ confidence 0.85)
  4. `text` keyword scoring using `TEXT_KEYWORDS` (includes `cach` stem, `redis`, `ttl`, `evict`, `lru`, etc. $\to$ confidence 0.55–0.9)
  5. `activeSkill` fallback ($\to$ confidence 0.4)
- **One-call Screenshot Header**: Regex parsing and stripping for `SKILL: <skill> | TYPE: <type> | CONF: <0-1>`.
- Quick action prompt registry (`LLM_ACTION_PROMPTS`).

### 4. LLM Service (`src/services/llm.service.js`)
- Single-call classification header injected into `formatImageInstruction`.
- `processImageWithSkillStream()`: Added streaming for screenshots with robust header concealment that tests the regex before stripping the first line (ensuring non-header first lines are never lost, and single-line streams are fully flushed).
- `checkDoctrineCompliance()`: Real-time sanity checker logging warnings and returning compliance objects.
- `dispatchAction()`: Dispatches overlay/chat actions (`Copy code`, `Shorter`, `STAR-ify`, `Dry run`, `Scale it`, `Fix only`, etc.) inheriting the CORE doctrine.

### 5. Overlay UI & Chat (`llm-response.html`, `chat-window.js`, `main-window.js`)
- **Overlay Window ([`llm-response.html`](file:///c:/Users/ASUS/Downloads/chill_out/llm-response.html))**:
  - Header badge: `<SKILL> · <TYPE> · <STYLE>` with green/amber/red confidence dot and lock indicator.
  - Re-run dropdown menu: Click badge to re-run last input with any skill.
  - Action bar: Instant one-click chips (`Copy code`, `Copy all`, `Shorter`, `Example`, and skill-specific actions like `Dry run`, `Scale it`, `STAR-ify`, `Fix only`).
  - Streaming chunk rendering for both screenshots and voice.
- **Main Command Bar ([`src/ui/main-window.js`](file:///c:/Users/ASUS/Downloads/chill_out/src/ui/main-window.js), [`index.html`](file:///c:/Users/ASUS/Downloads/chill_out/index.html))**:
  - Skill pill now cycles dynamically through all skills + `Auto`.
  - Right-click toggles skill lock (`🔒`).
  - Updated shortcuts modal and global shortcuts:
    - `Ctrl+Shift+A`: Area screenshot capture
    - `Ctrl+Shift+Tab`: Cycle skills / Auto
    - `Ctrl+Shift+L`: Toggle skill lock
    - `Ctrl+Shift+Y`: Cycle answer style
    - `Ctrl+Shift+G`: Copy last code block to clipboard
    - `Ctrl+Shift+E`: Open re-run menu
- **Chat Window ([`src/ui/chat-window.js`](file:///c:/Users/ASUS/Downloads/chill_out/src/ui/chat-window.js))**:
  - Displays skill badge on assistant messages.
  - Prepends `[You]` or `[Interviewer]` labels to voice transcripts.
  - Appends quick action chips under the latest assistant response.
- **Settings ([`settings.html`](file:///c:/Users/ASUS/Downloads/chill_out/settings.html), [`src/ui/settings-window.js`](file:///c:/Users/ASUS/Downloads/chill_out/src/ui/settings-window.js))**:
  - Added **Interview Preset** dropdown (`full`, `coding`, `system-design`, `hr`).
  - Added **Answer Style** dropdown (`auto`, `concise`, `structured`, `spoken`, `deep`).
  - Expanded **Active Skill** dropdown with Auto-detect and all skills.

---

## Verification & Acceptance Results

### 1. Router Test Suite (`scripts/test-router.js`)
Run: `node scripts/test-router.js`
- **Text Keyword Classification**: 25/25 (100%) correct (includes `"caching?"`, `"redis ttl"`, `"lru caching"`)
- **Header Parser Fixtures**: 5/5 (100%) correct
- **Overall Score**: 30/30 (100%)

### 2. Live Doctrine Acceptance Test Suite (`scripts/test-doctrine-acceptance.js`)
Run: `node scripts/test-doctrine-acceptance.js` against live Gemini API:

| # | Test Scenario | Input Type | Routed Skill | Words | Result |
|---|---|---|---|---|---|
| 1 | **Voice: Tell me about yourself** | Audio transcript | `behavioral` | 118 | **PASS ✓** |
| 2 | **Voice: Design URL shortener** | Audio transcript | `system-design` | 102 | **PASS ✓** |
| 3 | **Voice: Process vs Thread** | Audio transcript | `tech-qa` | 105 | **PASS ✓** |
| 4 | **Voice: "uh... so the... caching?"** | Audio transcript | `system-design` | 95 | **PASS ✓** |
| 5 | **Screenshot: LeetCode Two Sum** | Real PNG bytes | `dsa` | 84 | **PASS ✓** |
| 6 | **Screenshot: NullPointerException** | Real PNG bytes (Streaming) | `tech-qa` | 95 | **PASS ✓** |
| 7 | **Screenshot: Activity Diagram** | Real PNG bytes | `tech-qa` | 45 | **PASS ✓** |
| 8 | **Screenshot: Terminal Shell** | Real PNG bytes (Streaming) | `general` | 29 | **PASS ✓** |
| 9 | **Typed: "can we do O(1) space?"** | Chat input | `dsa` | 89 | **PASS ✓** |
| 10 | **Typed: "hello can you hear me"** | Chat input | `general` | 19 | **PASS ✓** |

**Summary: 10/10 PASSED (100%)**
- 100% Live Gemini API execution (zero mock / synthetic fallback).
- Real vision PNG bytes tested through non-streaming and streaming pipelines.
- Zero header leakage in streaming callbacks.
- 0 clarifying questions to the candidate.
- 0 refusals or stalls.
- Usable first lines (solution / hook first).
- Strict adherence to voice teleprompter word count budgets ($\le 120$ words).
