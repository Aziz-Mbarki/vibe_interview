/**
 * Turn Aggregator: Debounces and coalesces spoken utterance fragments from VAD.
 * Real interviewers frequently pause mid-thought or add qualifiers
 * ("Tell me about caching... [0.8s pause] ...and specifically Redis cluster").
 * This service merges additions so the copilot produces 1 coherent answer
 * instead of 2-3 jittery fragments.
 */

const ADDITION_MAX_GAP_MS = 1800; // Pause shorter than this = same turn
const HARD_FLUSH_MS = 12000;      // Never hold a turn longer than this
const ADDITION_STARTERS = /^(and|also|so|but|or|plus|actually|specifically|as well|what about|how about|in addition|another thing|oh)\b/i;
const TRAILING_INCOMPLETE = /\b(the|a|an|to|for|with|about|of|in|on|is|are|would|could|like)\s*$/i;

/**
 * Speculative LLM calls cost a full request even if aborted. Only fire when
 * the first fragment already looks complete: ends in `?`, or classify()
 * returns conf >= 0.9 (tasks / explicit questions). Fragments that trail
 * off on a dangling preposition are almost always continued, so speculation
 * is wasted by construction.
 */
function looksSpeculativeReady(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (TRAILING_INCOMPLETE.test(t)) return false;
  if (/\?\s*$/.test(t)) return true;
  try {
    const { classify } = require('./intent-gate');
    const intent = classify(t, 'balanced');
    return intent.act === 'answer' && (intent.conf || 0) >= 0.9;
  } catch (_) {
    return false;
  }
}

class TurnAggregator {
  /**
   * @param {Function} emit - Called with finalized merged turn { text, speaker, at, parts }
   * @param {Object} options
   * @param {Function} [options.onSpeculativeStart] - Called on first fragment to trigger speculative rendering
   * @param {Function} [options.onSpeculativeCancel] - Called if addition arrives while speculative call is in-flight
   */
  constructor(emit, options = {}) {
    this.emit = emit;
    this.onSpeculativeStart = options.onSpeculativeStart || null;
    this.onSpeculativeCancel = options.onSpeculativeCancel || null;
    this.buf = [];
    this.timer = null;
    this.startedAt = 0;
    this.lastUtteranceAt = 0;
  }

  /**
   * Called for every FINAL utterance coming out of speech recognition.
   * @param {Object} utt - { text: string, speaker: 'you'|'them', at?: number, gapMs?: number }
   */
  push(utt) {
    if (!utt || !utt.text) return;
    if (utt.speaker === 'you') return; // Handled separately (never answer yourself)

    const now = utt.at || Date.now();
    const gapMs = typeof utt.gapMs === 'number'
      ? utt.gapMs
      : (this.lastUtteranceAt > 0 ? (now - this.lastUtteranceAt) : 99999);
    this.lastUtteranceAt = now;

    const lastItem = this.buf.length > 0 ? this.buf[this.buf.length - 1] : null;
    const isAddition =
      this.buf.length > 0 && (
        gapMs <= ADDITION_MAX_GAP_MS ||
        ADDITION_STARTERS.test(utt.text.trim()) ||
        (lastItem && TRAILING_INCOMPLETE.test(lastItem.text.trim()))
      );

    if (isAddition) {
      // An addition arrived! If there is a speculative request in-flight, cancel it
      if (this.onSpeculativeCancel) {
        this.onSpeculativeCancel();
      }
    } else {
      // Previous turn is complete, flush it before starting new turn
      this._flush();
    }

    if (!this.buf.length) {
      this.startedAt = now;
    }

    this.buf.push({
      text: utt.text,
      speaker: utt.speaker || 'them',
      at: now,
      gapMs
    });

    // Notify speculative caller on the very first fragment only when it
    // already looks complete — incomplete fragments just wait for the merge.
    if (this.buf.length === 1 && this.onSpeculativeStart) {
      const first = utt.text.trim();
      if (looksSpeculativeReady(first)) {
        this.onSpeculativeStart(first);
      }
    }

    clearTimeout(this.timer);
    const elapsed = now - this.startedAt;
    if (elapsed >= HARD_FLUSH_MS) {
      this._flush();
      return;
    }
    const remaining = HARD_FLUSH_MS - elapsed;
    const debounceWait = Math.max(100, Math.min(ADDITION_MAX_GAP_MS, remaining));
    this.timer = setTimeout(() => this._flush(), debounceWait);
  }

  /**
   * Force flush buffered fragments immediately
   */
  flush() {
    this._flush();
  }

  _flush() {
    if (!this.buf.length) return;
    const text = this.buf.map(u => u.text.trim()).join(' ').replace(/\s+/g, ' ');
    const turn = {
      text,
      speaker: 'them',
      at: this.buf[0].at,
      parts: this.buf.length
    };
    this.buf = [];
    clearTimeout(this.timer);
    this.timer = null;
    this.startedAt = 0;
    this.emit(turn);
  }

  reset() {
    this.buf = [];
    clearTimeout(this.timer);
    this.timer = null;
    this.startedAt = 0;
    this.lastUtteranceAt = 0;
  }

  cancel() {
    this.reset();
  }
}

module.exports = {
  TurnAggregator,
  ADDITION_MAX_GAP_MS,
  HARD_FLUSH_MS,
  ADDITION_STARTERS,
  TRAILING_INCOMPLETE,
  looksSpeculativeReady
};
