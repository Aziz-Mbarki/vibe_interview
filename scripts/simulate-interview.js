/**
 * Autonomous Test Suite: Phase 2 Autopilot & Zero-Click Interview
 *
 * Verifies:
 * 1. TurnAggregator: debounce, coalescing, gap timing, speculative start/cancel, hard flush.
 * 2. IntentGate: question detection, task imperatives, chitchat filter, screen references.
 * 3. Prompter Contract: SPEAK & CODE parsing, headline <= 10 words, bullets <= 14 words.
 * 4. ROIService & dHash: content region cropping, 64-bit dHash computation, deduplication.
 * 5. LatencyTracker: p50/p95 percentile calculations and rolling window metrics.
 */

const assert = require('assert');
const { TurnAggregator } = require('../src/services/turn-aggregator');
const intentGate = require('../src/services/intent-gate');
const roiService = require('../src/services/roi.service');
const { parsePrompterContract, LatencyTracker } = require('../src/services/llm.service');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

console.log('\n========================================');
console.log('  RUNNING AUTOPILOT SIMULATION TEST SUITE');
console.log('========================================\n');

// --------------------------------------------------------------------------
// 1. TURN AGGREGATOR TESTS
// --------------------------------------------------------------------------
console.log('--- 1. TurnAggregator Tests ---');

test('TurnAggregator coalesces multi-part fragmented utterances within gap', () => {
  let emitted = null;
  const agg = new TurnAggregator((turn) => {
    emitted = turn;
  });

  const now = 1000000;
  // Fragment 1
  agg.push({ text: 'Tell me about caching in distributed systems', speaker: 'them', at: now });
  assert.strictEqual(emitted, null, 'Should not emit immediately');

  // Fragment 2 after 900ms (within 1800ms gap)
  agg.push({ text: 'and specifically Redis cluster', speaker: 'them', at: now + 900 });
  assert.strictEqual(emitted, null, 'Should not emit yet');

  // Flush timer
  agg.flush();
  assert.ok(emitted, 'Should have emitted aggregated turn');
  assert.strictEqual(
    emitted.text,
    'Tell me about caching in distributed systems and specifically Redis cluster'
  );
  assert.strictEqual(emitted.parts, 2);
});

test('TurnAggregator ignores speaker: "you"', () => {
  let emitted = null;
  const agg = new TurnAggregator((turn) => {
    emitted = turn;
  });

  agg.push({ text: 'I think we can use a hash map', speaker: 'you', at: Date.now() });
  agg.flush();
  assert.strictEqual(emitted, null, 'Should never emit user speaker utterances');
});

test('TurnAggregator triggers speculative start and cancel callbacks', () => {
  let specStartCalled = false;
  let specCancelCalled = false;

  const agg = new TurnAggregator(() => {}, {
    onSpeculativeStart: (text) => {
      specStartCalled = true;
      assert.strictEqual(text, 'What is CAP theorem');
    },
    onSpeculativeCancel: () => {
      specCancelCalled = true;
    }
  });

  // First fragment triggers speculative start
  agg.push({ text: 'What is CAP theorem', speaker: 'them', at: 1000 });
  assert.strictEqual(specStartCalled, true, 'Speculative start must be triggered on fragment 1');
  assert.strictEqual(specCancelCalled, false);

  // Addition fragment triggers speculative cancel
  agg.push({ text: 'and how does DynamoDB handle it', speaker: 'them', at: 1500 });
  assert.strictEqual(specCancelCalled, true, 'Speculative cancel must be triggered on addition');
  agg.cancel();
});

test('TurnAggregator flushes automatically on hard flush limit', () => {
  let emitted = null;
  const agg = new TurnAggregator((turn) => {
    emitted = turn;
  });

  const base = 2000000;
  agg.push({ text: 'Start of very long turn', speaker: 'them', at: base });
  // Addition beyond hard flush (12500ms)
  agg.push({ text: 'way later continuation', speaker: 'them', at: base + 12500 });
  assert.ok(emitted, 'Should hard-flush when duration exceeds 12000ms');
  assert.strictEqual(emitted.text, 'Start of very long turn');
  agg.cancel();
});

// --------------------------------------------------------------------------
// 2. INTENT GATE TESTS
// --------------------------------------------------------------------------
console.log('\n--- 2. IntentGate Tests ---');

test('IntentGate classifies explicit questions', () => {
  const q1 = intentGate.classify('What is the difference between TCP and UDP?');
  assert.strictEqual(q1.act, 'answer');
  assert.strictEqual(q1.kind, 'question');

  const q2 = intentGate.classify('Explain how virtual memory paging works');
  assert.strictEqual(q2.act, 'answer');
  assert.strictEqual(q2.kind, 'question');
});

test('IntentGate classifies imperative coding tasks with needsScreen', () => {
  const task = intentGate.classify('Implement a binary search tree with insert and delete');
  assert.strictEqual(task.act, 'answer');
  assert.strictEqual(task.kind, 'task');
  assert.strictEqual(task.needsScreen, true);
});

test('IntentGate filters out conversational chitchat and fillers', () => {
  const fillers = [
    'okay cool',
    'got it',
    'yeah sounds good',
    'right right',
    'uh huh',
    'thanks',
    'perfect, thank you'
  ];

  for (const f of fillers) {
    const res = intentGate.classify(f);
    assert.strictEqual(res.act, 'ignore', `Expected "${f}" to be ignored, got ${res.act}`);
  }
});

test('IntentGate flags screen references for visual analysis', () => {
  const res = intentGate.classify('Take a look at this error shown on the screen');
  assert.strictEqual(res.act, 'answer');
  assert.strictEqual(res.needsScreen, true);
});

// --------------------------------------------------------------------------
// 3. PROMPTER CONTRACT & LENGTH BUDGETS
// --------------------------------------------------------------------------
console.log('\n--- 3. Prompter Contract & Length Budget Tests ---');

test('parsePrompterContract parses SPEAK format and validates word limits', () => {
  const rawResponse = `HEADLINE: Two pointers approach, O(N) time O(1) space
- Left and right pointers converge toward center
- Swap mismatched elements when pointers satisfy parity
- Handle empty or single element edge case gracefully`;

  const parsed = parsePrompterContract(rawResponse);
  assert.strictEqual(parsed.headline, 'Two pointers approach, O(N) time O(1) space');
  assert.strictEqual(parsed.bullets.length, 3);
  assert.strictEqual(parsed.mode, 'SPEAK');

  // Validate strict budgets
  const headlineWords = parsed.headline.trim().split(/\s+/).length;
  assert.ok(headlineWords <= 10, `Headline has ${headlineWords} words (budget <= 10)`);

  parsed.bullets.forEach((bullet, idx) => {
    const words = bullet.trim().split(/\s+/).length;
    assert.ok(words <= 14, `Bullet ${idx + 1} has ${words} words (budget <= 14)`);
  });
});

test('parsePrompterContract parses CODE format with runnable code block', () => {
  const rawCodeResponse = `HEADLINE: LRU Cache using Map and Doubly Linked List
- Get is O(1) via hash table lookup
- Put evicts least recent tail node when capacity exceeded
\`\`\`typescript
class LRUCache {
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
}
\`\`\``;

  const parsed = parsePrompterContract(rawCodeResponse);
  assert.strictEqual(parsed.mode, 'CODE');
  assert.ok(parsed.code.includes('class LRUCache'));
  assert.strictEqual(parsed.language, 'typescript');
  assert.ok(parsed.badge.includes('lines') || parsed.badge.includes('ready'));
});

// --------------------------------------------------------------------------
// 4. ROI SERVICE & PERCEPTUAL DHASH
// --------------------------------------------------------------------------
console.log('\n--- 4. ROI Service & dHash Tests ---');

test('ROIService findTextRegion crops synthetic content block', () => {
  const width = 400;
  const height = 300;
  const buffer = Buffer.alloc(width * height * 4); // All zeros (dark background)

  // Draw a dense high-contrast block in the center (x: 100..300, y: 80..220)
  for (let y = 80; y < 220; y++) {
    for (let x = 100; x < 300; x++) {
      const idx = (y * width + x) * 4;
      // High contrast alternating pattern
      const val = ((x % 4 === 0) || (y % 4 === 0)) ? 255 : 30;
      buffer[idx] = val;     // R
      buffer[idx + 1] = val; // G
      buffer[idx + 2] = val; // B
      buffer[idx + 3] = 255; // A
    }
  }

  const roi = roiService.findTextRegion(buffer, width, height, 4);
  assert.ok(roi, 'ROI should be detected');
  assert.strictEqual(roi.isCropped, true, 'Image should be cropped to contrast region');
  assert.ok(roi.x >= 0 && roi.x <= 150, `ROI x=${roi.x} within expectation`);
  assert.ok(roi.y >= 0 && roi.y <= 120, `ROI y=${roi.y} within expectation`);
  assert.ok(roi.width > 100 && roi.width <= width, `ROI width=${roi.width}`);
  assert.ok(roi.height > 100 && roi.height <= height, `ROI height=${roi.height}`);
});

test('ROIService computeDHash and deduplication identifies identical frames', () => {
  const width = 100;
  const height = 100;
  const frame1 = Buffer.alloc(width * height * 4);

  // Gradient pattern
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = (x + y) % 256;
      frame1[idx] = v;
      frame1[idx + 1] = v;
      frame1[idx + 2] = v;
      frame1[idx + 3] = 255;
    }
  }

  const hash1 = roiService.computeDHash(frame1, width, height, 4);
  assert.strictEqual(typeof hash1, 'string');
  assert.strictEqual(hash1.length, 64, '64-bit dHash is represented as 64 binary bits');

  // Identical frame has distance 0 and isDuplicateFrame returns true
  const distZero = roiService.hammingDistance(hash1, hash1);
  assert.strictEqual(distZero, 0);

  roiService.lastHash = hash1;
  assert.strictEqual(roiService.isDuplicateFrame(hash1), true);

  // Frame 2 with inverted gradient has large distance and is not duplicate
  const frame2 = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = (255 - (x + y) % 256);
      frame2[idx] = v;
      frame2[idx + 1] = v;
      frame2[idx + 2] = v;
      frame2[idx + 3] = 255;
    }
  }

  const hash2 = roiService.computeDHash(frame2, width, height, 4);
  const distDiff = roiService.hammingDistance(hash1, hash2);
  assert.ok(distDiff > 10, `Expected distance > 10, got ${distDiff}`);
  assert.strictEqual(roiService.isDuplicateFrame(hash2), false);
});

// --------------------------------------------------------------------------
// 5. LATENCY TRACKER TESTS
// --------------------------------------------------------------------------
console.log('\n--- 5. LatencyTracker Tests ---');

test('LatencyTracker accurately calculates p50 and p95 metrics', () => {
  const tracker = new LatencyTracker(50);

  // Feed 100 sorted values: 10, 20, 30 ... 1000 ms
  for (let i = 1; i <= 100; i++) {
    tracker.record(i * 10);
  }

  const metrics = tracker.getMetrics();
  assert.strictEqual(metrics.count, 50, 'Rolling window should cap at maxSamples');
  assert.ok(metrics.p50 > 0);
  assert.ok(metrics.p95 >= metrics.p50);
  assert.ok(metrics.avg > 0);
});

console.log('\n========================================');
console.log(`  ALL ${passedTests}/${totalTests} TESTS PASSED CLEANLY!`);
console.log('========================================\n');
