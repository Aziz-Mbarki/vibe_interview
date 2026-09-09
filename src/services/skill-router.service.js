/**
 * Skill Router Service
 * Classifies interview inputs (text or screenshots) into appropriate skills and answer styles.
 * Pure logic — zero Electron dependencies for easy testing and portability.
 */

const TEXT_KEYWORDS = {
  'system-design': [
    'design', 'scale', 'scalab', 'microservice', 'load balanc', 'database',
    'shard', 'partition', 'cach', 'cdn', 'queue', 'kafka', 'throughput', 'latency',
    'availability', 'cap theorem', 'consistent hash', 'url shortener', 'tinyurl',
    'news feed', 'chat system', 'rate limit', 'distributed', 'high availability',
    'replication', 'sharding', 'event driven', 'redis', 'nosql', 'sql vs nosql',
    'ttl', 'evict', 'lru', 'memcache', 'memcached', 'cache invalidat'
  ],
  'behavioral': [
    'tell me about yourself', 'why ', 'strength', 'weakness', 'conflict',
    'challenge you faced', 'leadership', 'team', 'failure', 'proud', 'motivat',
    'where do you see', 'why should we', 'salary', 'manager', 'deadline pressure',
    'disagreem', 'greatest accomplishment', 'tell me about a time', 'work ethic',
    'cross functional', 'difficult coworker', 'prioritize', 'biggest mistake'
  ],
  'dsa': [
    'leetcode', 'big o', 'complexity', 'array', 'linked list', 'binary tree',
    'graph', 'dynamic programming', 'sliding window', 'two pointer', 'heap',
    'shortest path', 'sort', 'search', 'subarray', 'palindrome', 'permutation',
    'tree node', 'binary search', 'recursion', 'backtrack', 'trie', 'monotonic',
    'dp[', 'dfs', 'bfs', 'time complexity', 'space complexity', 'memoization'
  ],
  'tech-qa': [
    'oop', 'polymorphism', 'inheritance', 'encapsulation', 'thread', 'process vs',
    'deadlock', 'mutex', 'http', 'tcp', 'rest', 'sql vs nosql', 'index', 'transaction',
    'garbage collection', 'event loop', 'promise', 'closure', 'docker', 'kubernetes',
    'ci/cd', 'error', 'exception', 'traceback', 'bug', 'debug', 'not working', 'fails',
    'segmentation fault', 'nullpointer', 'syntax error', 'memory leak', 'coroutine',
    'dependency injection', 'solid principles', 'acid'
  ]
};

const IMAGE_TYPE_SKILL = {
  'coding_problem': 'dsa',
  'error_traceback': 'tech-qa',
  'terminal_output': 'tech-qa',
  'diagram': 'system-design',
  'mcq_quiz': 'tech-qa',
  'doc_text': 'behavioral',
  'whiteboard': 'system-design',
  'ui_bug': 'tech-qa',
  'unknown': 'dsa'
};

const PRESET_SKILLS = {
  'coding': 'dsa',
  'system-design': 'system-design',
  'hr': 'behavioral',
  'full': null // auto-detect
};

const LLM_ACTION_PROMPTS = {
  // Universal
  'copy-code': 'Extract ONLY the final, complete, runnable code block from the previous solution. No explanation, no commentary, just the fenced code with the correct language tag. Do not invent or "improve" APIs.',
  'copy-all': 'Output the complete previous solution formatted cleanly and directly for the candidate. Keep every load-bearing fact. Do not invent new claims.',
  'shorter': 'Rewrite the previous answer more concisely. Keep the verdict, the code, true complexity, and any edge case that makes it correct. Never drop a load-bearing fact for brevity. No invented metrics.',
  'example': 'Provide a concrete, step-by-step dry run of the PREVIOUS solution with a short input. Trace must match that code. State input, each mutation, and output.',
  'follow-up': 'Answer the most common interviewer follow-up for this problem (complexity, alternative, scaling, or "what if n is huge"). Give the correct answer in first person. Never ask a question back.',
  // DSA
  'dry-run': 'Dry-run the PREVIOUS algorithm on a short sample. Variable-by-variable. The trace must match the code already given. Include the empty or n=1 case if it is interesting.',
  'optimize': 'If a strictly better time or space solution exists, give it complete and compiling, with true complexity. If the current solution is already optimal, say so in one line and keep it. Do not claim a better Big-O you cannot implement.',
  'other-approach': 'Give one real alternative (e.g. iterative vs recursive, two pointers vs hash map). Complete enough to implement. Honest trade-offs. Do not invent a worse "clever" trick.',
  // System Design
  'api-detail': 'Detail REST/gRPC endpoints, payloads, status codes, and error models that match the previous design. Do not invent fields that contradict it. Keep numbers internally consistent.',
  'scale-it': 'Scale the previous design from 10k to 10M DAU. Arithmetic must check out (QPS, storage, bandwidth). Name the real bottleneck at each jump. Do not invent capacity numbers that contradict earlier math.',
  'trade-offs': 'Compare the actual choices in the previous design (SQL vs NoSQL, consistency, queue). Honest when each wins. No buzzword dump. First person.',
  // Behavioral
  'star-ify': 'Reformat the previous story into STAR (Situation, Task, Action, Result). Use only facts already given or the candidate profile. Never invent employers, titles, or metrics — use {insert metric} if missing.',
  '60-sec-version': 'Condense into a ~60-second first-person pitch (~120 words). Keep the true result. Do not invent numbers. Do not ask a question back.',
  'add-metrics': 'Add metrics ONLY if they already appear in the previous answer or candidate profile. If a needed number is missing, write {insert metric} — never invent a percentage, QPS, or headcount.',
  // Tech Q&A / Debug
  'root-cause': 'Name the exact root cause in 1-2 lines. Then the one-line fix. Do not guess a trendy cause that the stack trace does not support.',
  'fix-only': 'Provide ONLY the exact code or config change that fixes this error. Complete enough to paste. No preamble. Do not invent APIs that do not exist.'
};

class SkillRouterService {
  /**
   * Resolve appropriate skill using strict resolution order:
   * 1. lockedSkill (user pressed "lock") → confidence 1.0
   * 2. preset single-skill (e.g. HR preset) → 0.9 (unless text strongly points elsewhere)
   * 3. imageType map (if provided) → 0.85
   * 4. text heuristic (keyword scoring) → 0.5–0.85
   * 5. fallback activeSkill → 0.4
   */
  resolveSkill({ lockedSkill = null, preset = 'full', imageType = null, text = '', activeSkill = 'dsa' } = {}) {
    // 1. User manual lock always wins
    if (lockedSkill) {
      return {
        skill: lockedSkill,
        confidence: 1.0,
        reason: 'user_locked'
      };
    }

    // 2. Evaluate text keywords if text exists
    const textClassification = this.classifyText(text);

    // 3. Check preset bias
    const presetTarget = PRESET_SKILLS[preset];
    if (presetTarget) {
      // If text strongly disagrees with preset (score >= 4), text can override
      if (textClassification && textClassification.confidence >= 0.85 && textClassification.skill !== presetTarget) {
        return {
          skill: textClassification.skill,
          confidence: textClassification.confidence,
          reason: `text_override_over_preset (${preset})`
        };
      }
      return {
        skill: presetTarget,
        confidence: 0.9,
        reason: `preset_${preset}`
      };
    }

    // 4. Image type mapping if screenshot provided
    if (imageType && IMAGE_TYPE_SKILL[imageType]) {
      return {
        skill: IMAGE_TYPE_SKILL[imageType],
        confidence: 0.85,
        reason: `image_type_${imageType}`
      };
    }

    // 5. Text heuristic result
    if (textClassification && textClassification.confidence >= 0.55) {
      return {
        skill: textClassification.skill,
        confidence: textClassification.confidence,
        reason: 'text_keyword_match'
      };
    }

    // 6. Fallback to activeSkill
    return {
      skill: activeSkill || 'dsa',
      confidence: textClassification ? textClassification.confidence : 0.4,
      reason: 'active_skill_fallback'
    };
  }

  /**
   * Score input text against keyword dictionaries
   */
  classifyText(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return null;
    }

    const text = rawText.toLowerCase().trim();
    if (text.length === 0) {
      return null;
    }

    // Check for pure greetings / casual chit-chat
    const chitChatPatterns = [
      /^(hello|hi|hey|good morning|good afternoon|good evening|howdy)\b/i,
      /^can you hear me\??$/i,
      /^testing( 1 2 3)?\??$/i,
      /^are you there\??$/i
    ];
    for (const pattern of chitChatPatterns) {
      if (pattern.test(text)) {
        return {
          skill: 'general',
          confidence: 0.95,
          isChitChat: true,
          reason: 'chit_chat_greeting'
        };
      }
    }

    const scores = {
      'system-design': 0,
      'behavioral': 0,
      'dsa': 0,
      'tech-qa': 0
    };

    for (const [skill, keywords] of Object.entries(TEXT_KEYWORDS)) {
      for (const kw of keywords) {
        if (text.includes(kw)) {
          // Behavioral phrases get double weight because they are multi-word questions
          const weight = (skill === 'behavioral' && kw.includes(' ')) ? 2 : 1;
          scores[skill] += weight;
        }
      }
    }

    let highestSkill = null;
    let highestScore = 0;

    for (const [skill, score] of Object.entries(scores)) {
      if (score > highestScore) {
        highestScore = score;
        highestSkill = skill;
      }
    }

    if (highestScore === 0) {
      return {
        skill: 'dsa',
        confidence: 0.4,
        reason: 'no_keywords_matched'
      };
    }

    // Map score to confidence between 0.55 and 0.9
    const confidence = Math.min(0.9, 0.55 + (highestScore * 0.08));

    return {
      skill: highestSkill,
      confidence: Number(confidence.toFixed(2)),
      score: highestScore,
      reason: 'keyword_score'
    };
  }

  /**
   * Parse one-call screenshot header from Gemini reply
   * Header format:
   * SKILL: <dsa|system-design|behavioral|tech-qa|general> | TYPE: <imageType> | CONF: <0-1>
   */
  parseRouterHeader(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      return {
        cleanedText: '',
        headerFound: false,
        skill: null,
        imageType: null,
        skillConfidence: null
      };
    }

    const trimmed = responseText.trimStart();
    const headerRegex = /^SKILL:\s*([\w-]+)\s*\|\s*TYPE:\s*([\w_]+)\s*\|\s*CONF:\s*([01](?:\.\d+)?)/i;
    const match = trimmed.match(headerRegex);

    if (match) {
      const skill = match[1].toLowerCase().trim();
      const imageType = match[2].toLowerCase().trim();
      const confidence = parseFloat(match[3]);

      // Strip first line and following whitespace/newline
      const firstLineEnd = trimmed.indexOf('\n');
      const cleanedText = firstLineEnd !== -1 ? trimmed.slice(firstLineEnd + 1).trimStart() : '';

      return {
        cleanedText,
        headerFound: true,
        skill: (SKILL_META_KEYS.includes(skill) ? skill : 'dsa'),
        imageType,
        skillConfidence: Number.isFinite(confidence) ? confidence : 0.8
      };
    }

    return {
      cleanedText: responseText,
      headerFound: false,
      skill: null,
      imageType: null,
      skillConfidence: null
    };
  }

  getActionPrompt(actionId) {
    return LLM_ACTION_PROMPTS[actionId] || null;
  }
}

const SKILL_META_KEYS = ['dsa', 'system-design', 'behavioral', 'tech-qa', 'general'];

const skillRouterService = new SkillRouterService();

module.exports = skillRouterService;
module.exports.skillRouterService = skillRouterService;
module.exports.SkillRouterService = SkillRouterService;
module.exports.TEXT_KEYWORDS = TEXT_KEYWORDS;
module.exports.IMAGE_TYPE_SKILL = IMAGE_TYPE_SKILL;
module.exports.PRESET_SKILLS = PRESET_SKILLS;
module.exports.LLM_ACTION_PROMPTS = LLM_ACTION_PROMPTS;
