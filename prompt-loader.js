const fs = require('fs');
const path = require('path');

const SKILL_META = {
  'dsa': {
    id: 'dsa',
    label: 'Data Structures & Algorithms',
    shortLabel: 'DSA',
    icon: 'code',
    needsCode: true,
    defaultStyle: 'concise',
    description: 'Optimal LeetCode algorithms, time/space complexity, production code'
  },
  'system-design': {
    id: 'system-design',
    label: 'System Design',
    shortLabel: 'System Design',
    icon: 'layers',
    needsCode: false,
    defaultStyle: 'structured',
    description: 'High-level architecture, capacity calculations, DB choice, scaling & trade-offs'
  },
  'behavioral': {
    id: 'behavioral',
    label: 'HR / Behavioral',
    shortLabel: 'Behavioral',
    icon: 'user-tie',
    needsCode: false,
    defaultStyle: 'spoken',
    description: 'STAR framework, speakable interview answers, leadership & conflict stories'
  },
  'tech-qa': {
    id: 'tech-qa',
    label: 'Technical Q&A / Debug',
    shortLabel: 'Tech Q&A',
    icon: 'terminal',
    needsCode: 'sometimes',
    defaultStyle: 'concise',
    description: 'Concepts, OOP, OS, networking, language trivia, and instant bug/error diagnosis'
  },
  'general': {
    id: 'general',
    label: 'General Interview',
    shortLabel: 'General',
    icon: 'compass',
    needsCode: false,
    defaultStyle: 'concise',
    description: 'Direct, versatile guidance for any general interview situation'
  }
};

class PromptLoader {
  constructor() {
    this.prompts = new Map();
    this.promptsLoaded = false;
    this.skillPromptSent = new Set();
    this.skillsRequiringProgrammingLanguage = ['dsa'];
  }

  /**
   * §1B Global Interview Doctrine (CORE text)
   * Prepend to every system prompt so the LLM operates with live-interview discipline.
   */
  getCoreDoctrine() {
    return `## LIVE INTERVIEW CONTEXT (highest priority — always applies)
You are assisting a candidate DURING A LIVE technical/HR interview, in real time.
The candidate glances at your answer for a few seconds while speaking to the interviewer.

CANDIDATE PERSONA (CRITICAL):
You ARE the candidate speaking directly to the interviewer. Always formulate answers in the first person ("I", "my approach", "in my experience").
NEVER say "You should say...", "Tell the interviewer...", "As a candidate...", or meta-instructions.
Every sentence must be ready for the candidate to read aloud word-for-word as their own voice without editing or stumbling.

HARD RULES:
1. ALWAYS ANSWER. Whatever you receive (screenshot, voice transcript, fragment, typo, half
   sentence, greeting, ambiguous question) — produce the most useful best-effort response.
   NEVER refuse, NEVER say you need more information, NEVER stall.
2. NEVER ASK QUESTIONS BACK. The candidate cannot converse with you mid-interview. If the
   input is ambiguous: pick the most common interview reading, state it in ONE short line
   ("*Assuming: …*"), then answer that fully. No clarifying questions, ever.
3. SOLUTION FIRST. Lead with the usable answer (the code / the fix / the one-line answer /
   the spoken script), THEN supporting explanation. The candidate may only read your first lines.
4. GLANCEABLE. Short, scannable, low-word-count. Bullets over paragraphs. No preamble
   ("Sure!", "Here's…"), no filler, no repetition of the question. Long reading = the
   interviewer notices. Default budgets: voice answers ≤120 words; screenshot answers put
   the key result above the fold; details go after, clearly separated.
5. STAY USEFUL, STAY FREE. Use your full reasoning freely — code, debug, design, explain,
   suggest, compare. The skill section below only sets FORMAT and FOCUS, not limits on
   what you may do to help the candidate succeed right now.
6. CORRECTNESS OVER SPEED. A short wrong answer is worse than a slightly longer right one.
   - Never invent APIs, Big-O, metrics, employers, constraints, or signatures that are not in the input.
   - Prefer the standard interview-optimal solution over a clever trick that is easy to get wrong.
   - Code must compile, match the required signature, and handle empty / n=1 / duplicates / overflow.
   - Numbers (QPS, storage, complexity) must be internally consistent with the rest of the answer.
   - If you cannot be sure, pick the most common reading, mark "*Assuming:*", and solve that completely.`;
  }

  /**
   * Load all skill prompts from the prompts directory
   */
  loadPrompts() {
    if (this.promptsLoaded) {
      return;
    }

    const promptsDir = path.join(__dirname, 'prompts');

    try {
      const files = fs.readdirSync(promptsDir);

      for (const file of files) {
        if (file.endsWith('.md')) {
          const skillName = path.basename(file, '.md');
          const filePath = path.join(promptsDir, file);
          const promptContent = fs.readFileSync(filePath, 'utf8');

          this.prompts.set(skillName, promptContent);
        }
      }

      this.promptsLoaded = true;
    } catch (error) {
      console.error('Error loading skill prompts:', error);
      throw new Error(`Failed to load skill prompts: ${error.message}`);
    }
  }

  /**
   * Get raw markdown content of a skill prompt without doctrine or wrappers
   */
  getRawSkillPrompt(skillName) {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const normalized = this.normalizeSkillName(skillName);
    let promptContent = this.prompts.get(normalized);

    if (!promptContent) {
      // Fallback to dsa or general if requested prompt not found
      promptContent = this.prompts.get('general') || this.prompts.get('dsa') || '';
    }

    return promptContent;
  }

  /**
   * Primary composer: builds the complete system prompt with CORE doctrine,
   * skill rules, language specifications, style instructions, and candidate profile.
   * Nothing reaches the Gemini API without the CORE doctrine.
   */
  buildSystemPrompt(skillId, { language = null, style = null, candidateProfile = null } = {}) {
    const normSkill = this.normalizeSkillName(skillId);
    const core = this.getCoreDoctrine();
    let rawSkillPrompt = this.getRawSkillPrompt(normSkill);
    const meta = this.getSkillMeta(normSkill);
    const resolvedStyle = style || meta.defaultStyle || 'concise';

    // Inject programming language if needed
    if (language && (meta.needsCode === true || meta.needsCode === 'sometimes')) {
      rawSkillPrompt = this.injectProgrammingLanguage(rawSkillPrompt, language, normSkill);
    }

    // Compose CORE + Skill
    let composed = `${core}\n\n${rawSkillPrompt}`;

    // Append answer style block
    composed = this.injectAnswerStyle(composed, resolvedStyle);

    // Append candidate profile if relevant (behavioral, general, or if explicitly provided)
    if (candidateProfile || normSkill === 'behavioral') {
      composed = this.injectCandidateProfile(composed, candidateProfile);
    }

    return composed;
  }

  /**
   * Backward-compatible getter. Returns the fully-composed system prompt by default.
   */
  getSkillPrompt(skillName, programmingLanguage = null, options = {}) {
    if (options && options.raw === true) {
      return this.getRawSkillPrompt(skillName);
    }
    return this.buildSystemPrompt(skillName, {
      language: programmingLanguage,
      style: options.style || null,
      candidateProfile: options.candidateProfile || null
    });
  }

  /**
   * Inject answer style instructions (§5)
   */
  injectAnswerStyle(promptContent, style) {
    const styleNormalized = (style || 'concise').toLowerCase();
    let styleBlock = '';

    switch (styleNormalized) {
      case 'spoken':
        styleBlock = `\n\n## ANSWER STYLE: SPOKEN / TELEPROMPTER
Candidate reads this WHILE talking — every extra sentence is a risk.
1. Line 1 = the correct opening (verdict / thesis / first sentence they should say).
2. Above the fold = 3-5 true, specific bullets. No invented metrics.
3. Target 45-75 seconds spoken (~120-180 words). No tables. First person ("I").
Correctness beats brevity: do not drop the fact that makes the answer right.`;
        break;

      case 'structured':
        styleBlock = `\n\n## ANSWER STYLE: STRUCTURED (System Design & Architecture)
1. Line 1 = Direct high-level vision that would actually work at the stated scale.
2. Headed sections: Requirements → API → Data Model → Components → Scaling → Trade-offs.
3. Quantify users, QPS, storage, bandwidth. Arithmetic must check out. Trade-offs: 3 rows max.`;
        break;

      case 'deep':
        styleBlock = `\n\n## ANSWER STYLE: DEEP
Full correct explanation + concrete code/system + edges + trade-offs. Subheadings, scannable blocks.
Do not pad. Every extra paragraph must add a fact the interviewer can probe.`;
        break;

      case 'concise':
      default:
        styleBlock = `\n\n## ANSWER STYLE: CONCISE
1. Line 1 = Direct correct verdict or key insight (speakable immediately).
2. Glanceable bullets + complete code if coding + tight time/space.
3. Prose under 200 words. Solution first. Never sacrifice a load-bearing edge case for brevity.`;
        break;
    }

    return promptContent + styleBlock;
  }

  /**
   * Inject candidate profile grounding (§7.5)
   */
  injectCandidateProfile(promptContent, profile) {
    const profileText = profile && typeof profile === 'string' && profile.trim().length > 0
      ? profile.trim().slice(0, 2000)
      : '(no profile provided — use [Company]/[Project] placeholders + {hint} markers)';

    const block = `\n\n## CANDIDATE PROFILE (facts about the candidate — use for behavioral/experience answers)
${profileText}
RULES: Ground every story in these facts (real employers, projects, tech). Never invent
employers, titles, or metrics. If a needed fact is missing, use a placeholder with a brace
hint, e.g. "at [Company] {insert employer}, I cut latency by {insert metric}".`;

    return promptContent + block;
  }

  /**
   * Inject programming language context into skill prompts
   */
  injectProgrammingLanguage(promptContent, programmingLanguage, skillName) {
    const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript', go: 'Go', rust: 'Rust', typescript: 'TypeScript', ts: 'TypeScript' };
    const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript', go: 'go', rust: 'rust', typescript: 'typescript', ts: 'typescript' };
    const norm = (programmingLanguage || '').toLowerCase();
    const languageTitle = languageMap[norm] || (programmingLanguage ? programmingLanguage.charAt(0).toUpperCase() + programmingLanguage.slice(1) : 'C++');
    const fenceTag = fenceTagMap[norm] || norm || 'text';
    const languageUpper = (languageMap[norm] || languageTitle).toUpperCase();

    let languageInjection = '';

    switch (skillName) {
      case 'dsa':
        languageInjection = `\n\n## IMPLEMENTATION LANGUAGE: ${languageUpper}
STRICT REQUIREMENTS:
- Respond ONLY in ${languageTitle}. No snippets or alternatives in other languages.
- All code blocks use triple backticks with the exact tag: \`\`\`${fenceTag}\`\`\`.
- If a starter signature exists, implement it exactly (name, params, return, in-place vs new).
- Complete, compiling ${languageTitle}: no TODO, no omitted branches, no pseudocode.
- Handle empty / n=1 / duplicates / negatives / overflow as the language requires.
- Brief approach, then the full implementation, then tight time/space of THAT code.
- Idiomatic stdlib only. Do not use APIs that do not exist in ${languageTitle}.`;
        break;
      default:
        languageInjection = `\n\n## PROGRAMMING LANGUAGE: ${languageUpper}\nAll code and examples must be in ${languageTitle}. Use code fences with tag: \`\`\`${fenceTag}\`\`\`.`;
        break;
    }

    return promptContent + languageInjection;
  }

  isFirstTimeInteraction(storedMemory) {
    return !storedMemory || storedMemory.length === 0;
  }

  shouldSendAsModelMemory(skillName, storedMemory) {
    const normalizedSkillName = this.normalizeSkillName(skillName);

    if (this.isFirstTimeInteraction(storedMemory)) {
      return true;
    }

    const hasSkillInMemory = storedMemory.some(event =>
      event.skillUsed === normalizedSkillName && event.promptSentAsMemory === true
    );

    return !hasSkillInMemory;
  }

  getRequestComponents(skillName, userMessage, storedMemory, programmingLanguage = null, options = {}) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const shouldUseModelMemory = this.shouldSendAsModelMemory(skillName, storedMemory);
    const skillPrompt = this.buildSystemPrompt(normalizedSkillName, {
      language: programmingLanguage,
      style: options.style || null,
      candidateProfile: options.candidateProfile || null
    });

    return {
      skillName: normalizedSkillName,
      userMessage,
      skillPrompt,
      shouldUseModelMemory,
      isFirstTime: this.isFirstTimeInteraction(storedMemory),
      modelMemory: shouldUseModelMemory && skillPrompt ? skillPrompt : null,
      messageContent: userMessage,
      programmingLanguage,
      requiresProgrammingLanguage: this.requiresProgrammingLanguage(normalizedSkillName)
    };
  }

  requiresProgrammingLanguage(skillName) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const meta = this.getSkillMeta(normalizedSkillName);
    return meta ? meta.needsCode === true : this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName);
  }

  getSkillsRequiringProgrammingLanguage() {
    return ['dsa'];
  }

  normalizeSkillName(skillName) {
    if (!skillName) return 'dsa';

    const normalized = skillName.toLowerCase().trim();

    const skillMap = {
      'dsa': 'dsa',
      'data-structures': 'dsa',
      'algorithms': 'dsa',
      'data-structures-algorithms': 'dsa',
      'coding': 'dsa',
      'system-design': 'system-design',
      'systems-design': 'system-design',
      'architecture': 'system-design',
      'distributed-systems': 'system-design',
      'hld': 'system-design',
      'behavioral': 'behavioral',
      'behavioral-interview': 'behavioral',
      'behavior': 'behavioral',
      'hr': 'behavioral',
      'tech-qa': 'tech-qa',
      'technical-qa': 'tech-qa',
      'tech_qa': 'tech-qa',
      'debug': 'tech-qa',
      'debugging': 'tech-qa',
      'programming': 'tech-qa',
      'software-development': 'tech-qa',
      'general': 'general'
    };

    return skillMap[normalized] || (SKILL_META[normalized] ? normalized : 'dsa');
  }

  getSkillMeta(skillName) {
    const norm = this.normalizeSkillName(skillName);
    return SKILL_META[norm] || SKILL_META['general'];
  }

  getAvailableSkills() {
    return Object.values(SKILL_META);
  }

  getAvailableSkillIds() {
    return Object.keys(SKILL_META);
  }

  resetSession() {
    this.skillPromptSent.clear();
  }

  getSessionStats() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    return {
      totalPrompts: this.prompts.size,
      skillsUsedInSession: this.skillPromptSent.size,
      availableSkills: this.getAvailableSkills(),
      skillsUsed: Array.from(this.skillPromptSent),
      skillsRequiringProgrammingLanguage: this.skillsRequiringProgrammingLanguage
    };
  }
}

const promptLoader = new PromptLoader();

module.exports = promptLoader;
module.exports.promptLoader = promptLoader;
module.exports.PromptLoader = PromptLoader;
module.exports.SKILL_META = SKILL_META;