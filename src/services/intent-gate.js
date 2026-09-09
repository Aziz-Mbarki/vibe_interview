/**
 * Intent Gate: Fast, local, zero-latency classifier (<1ms, no LLM cost).
 * Runs on the coalesced turn before sending to the model.
 * Distinguishes actionable questions & coding tasks from chitchat fillers ("okay cool").
 */

const QUESTION_MARKS = /\?\s*$/;
const WH = /\b(what|why|how|when|where|which|who|whose|can you|could you|would you|do you|did you|have you|are you|is there|tell me|tell us|walk me|walk us|explain|describe|give me|give us|talk me through|talk us through|suppose|imagine|let's say|let's discuss|present yourself|introduce yourself|share your)\b/i;
const IMPERATIVE_TASK = /\b(write|implement|design|solve|code|build|optimi[sz]e|refactor|debug|find the|return the)\b/i;
const CHITCHAT = /^(ok(ay)?|right|got it|mm+h*|yeah|yes|no|sure|cool|perfect|thanks?|thank you|great|nice|alright|sounds good|makes sense|i see|uh huh)[\s.!,]*$/i;
const FILLER_ONLY = /^[\s.,!?—-]*$/;
const SCREEN_TRIGGER = /\b(on screen|on the screen|the screen|shown on|shown here|this code|this error|this problem|this diagram|this function|in the terminal|in the editor|on my screen)\b/i;

/**
 * Classify a conversational turn.
 * @param {Object|string} turn - Turn object with { text: string } or raw string
 * @param {string} [aggressiveness='balanced'] - 'conservative' | 'balanced' | 'eager'
 * @returns {{ act: 'answer'|'ignore'|'brief', kind?: 'question'|'task'|'context', conf?: number, needsScreen?: boolean, why?: string }}
 */
function classify(turn, aggressiveness = 'balanced') {
  const text = typeof turn === 'string' ? turn : (turn && turn.text ? turn.text : '');
  const t = text.trim();

  if (FILLER_ONLY.test(t) || t.length < 8) {
    return { act: 'ignore', why: 'too short' };
  }

  if (CHITCHAT.test(t)) {
    return { act: 'ignore', why: 'chitchat' };
  }

  const words = t.split(/\s+/).length;
  const isTask = IMPERATIVE_TASK.test(t);
  const isQuestionMark = QUESTION_MARKS.test(t);
  const isWh = WH.test(t);
  const hasScreenRef = SCREEN_TRIGGER.test(t);
  const needsScreen = isTask || hasScreenRef;

  // 1. Explicit task / problem
  if (isTask) {
    return {
      act: 'answer',
      kind: 'task',
      conf: 0.95,
      needsScreen
    };
  }

  // 2. Direct question ending with '?'
  if (isQuestionMark) {
    return {
      act: 'answer',
      kind: 'question',
      conf: 0.95,
      needsScreen
    };
  }

  // 3. WH Question. Whisper frequently omits the terminal `?` on rising
  // intonation, so we do not require a question mark here. Balanced mode
  // accepts 3+ words (was 4) so "what is caching" still fires.
  if (isWh && words >= (aggressiveness === 'eager' ? 2 : 3)) {
    return {
      act: 'answer',
      kind: 'question',
      conf: isQuestionMark ? 0.95 : 0.85,
      needsScreen
    };
  }

  // 4. Screen reference trigger ("take a look at this error on screen", "see the function here")
  if (hasScreenRef && words >= 4) {
    return {
      act: 'answer',
      kind: 'task',
      conf: 0.9,
      needsScreen: true
    };
  }

  // 5. Aggressiveness-dependent handling
  if (aggressiveness === 'eager' && words >= 4) {
    return {
      act: 'answer',
      kind: 'question',
      conf: 0.65,
      needsScreen
    };
  }

  // 5. Long context statement (informational, not direct question)
  if (words > 25) {
    return {
      act: 'brief',
      kind: 'context',
      conf: 0.40,
      needsScreen: false,
      why: 'long_statement'
    };
  }

  return {
    act: 'ignore',
    why: 'statement'
  };
}

const CANDIDATE_PATTERNS = [
  /^\s*(so\s+)?i\s+(think|believe|used|worked|built|created|developed|did|have|prefer|feel|suggest|would|usually|typically|started|am|was|mean)\b/i,
  /\b(in my (experience|previous role|last role|last company|previous company|past|opinion))\b/i,
  /\b(my (approach|solution|idea|thought|recommendation|understanding|background|team|code))\b/i,
  /^\s*(what i did was|from my side|for me,|let me think|give me a second|let me see)\b/i,
  /^\s*(yes|yeah|sure),?\s+so\s+i\b/i
];

const INTERVIEWER_PATTERNS = [
  /\b(can you|could you|would you|have you|did you|how do you|how would you|what do you|tell me|tell us|walk me|walk us|explain to me|describe for me)\b/i,
  /\b(your (resume|background|experience|project|code|thoughts|solution))\b/i,
  /^\s*(what|why|how|when|where|which)\b/i,
  IMPERATIVE_TASK
];

/**
 * Heuristically detect whether the speaker is the candidate ('you') or interviewer ('them').
 * @param {string} text - Transcription text
 * @returns {'you'|'them'}
 */
function detectSpeaker(text) {
  if (!text || typeof text !== 'string') return 'them';
  const t = text.trim();

  // If it matches strong interviewer questions or commands directed to "you", it's 'them'
  for (const pattern of INTERVIEWER_PATTERNS) {
    if (pattern.test(t)) {
      return 'them';
    }
  }

  // If it starts with first-person statements, it's 'you'
  for (const pattern of CANDIDATE_PATTERNS) {
    if (pattern.test(t)) {
      return 'you';
    }
  }

  // Default to 'them' so any incoming query is treated as interviewer
  return 'them';
}

module.exports = {
  classify,
  detectSpeaker,
  QUESTION_MARKS,
  WH,
  IMPERATIVE_TASK,
  CHITCHAT,
  FILLER_ONLY,
  SCREEN_TRIGGER
};
