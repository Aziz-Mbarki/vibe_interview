/**
 * Skill Router Service
 * Classifies interview inputs (text or screenshots) into appropriate skills and answer styles.
 * Pure logic — zero Electron dependencies for easy testing and portability.
 */

const TEXT_KEYWORDS = {
  'system-design': [
    'design', 'scale', 'scalab', 'microservice', 'load balanc', 'database',
    'shard', 'partition', 'cache', 'cdn', 'queue', 'kafka', 'throughput', 'latency',
    'availability', 'cap theorem', 'consistent hash', 'url shortener', 'tinyurl',
    'news feed', 'chat system', 'rate limit', 'distributed', 'high availability',
    'replication', 'sharding', 'event driven', 'redis', 'nosql', 'sql vs nosql'
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
  'copy-code': 'Extract ONLY the final, complete, runnable code block from the previous solution. No explanation, no commentary, just the code block with appropriate language tag.',
  'copy-all': 'Output the complete previous solution formatted cleanly and directly for the candidate.',
  'shorter': 'Rewrite the previous answer to be 50% more concise. Retain only the most crucial points, code, and complexities. Strip all non-essential words.',
  'example': 'Provide a concrete, step-by-step example with input/output dry run or trace for the previous solution.',
  'follow-up': 'Prepare the next logical follow-up answer or variation for this problem that interviewers commonly ask.',
  // DSA
  'dry-run': 'Provide an explicit variable-by-variable dry-run trace of the algorithm using a short sample test case.',
  'optimize': 'Can this solution be further optimized in time complexity, space complexity, or cache locality? Show the optimized version.',
  'other-approach': 'Provide an alternative algorithmic approach (e.g., iterative instead of recursive, two pointers instead of hash map) and compare trade-offs.',
  // System Design
  'api-detail': 'Detail the REST/gRPC API payloads, parameters, status codes, and error models for this system.',
  'scale-it': 'Walk through scaling this system from 10,000 to 10,000,000 daily active users. Address database sharding, caching layers, and bottlenecks.',
  'trade-offs': 'Provide a focused trade-offs analysis comparing database choices (SQL vs NoSQL), consistency models (CAP/PACELC), and message queue architectures.',
  // Behavioral
  'star-ify': 'Reformat the previous story strictly into STAR format (Situation, Task, Action, Result) with measurable metrics.',
  '60-sec-version': 'Condense this into an exact 60-second spoken elevator pitch (~120 words) with maximum impact.',
  'add-metrics': 'Enhance this answer with realistic quantifiable engineering metrics (e.g. latency % drop, QPS handled, team size, delivery timeline).',
  // Tech Q&A / Debug
  'root-cause': 'Identify the exact root cause of the error or concept in 1-2 lines.',
  'fix-only': 'Provide ONLY the exact code/configuration fix needed to resolve this error with no background preamble.'
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
