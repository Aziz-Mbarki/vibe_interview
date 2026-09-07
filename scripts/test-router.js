const { skillRouterService } = require('../src/services/skill-router.service');

const testCases = [
  { input: "design a URL shortener", expected: "system-design" },
  { input: "tell me about a conflict you had with a teammate", expected: "behavioral" },
  { input: "reverse a linked list in place", expected: "dsa" },
  { input: "what is a deadlock and how to prevent it", expected: "tech-qa" },
  { input: "why do you want to work for our company", expected: "behavioral" },
  { input: "how would you scale this architecture to 10M users", expected: "system-design" },
  { input: "fix this null pointer exception in java", expected: "tech-qa" },
  { input: "can you hear me?", expected: "general" },
  { input: "solve two sum on leetcode with hash map", expected: "dsa" },
  { input: "design twitter news feed and caching with redis", expected: "system-design" },
  { input: "tell me about yourself and your journey", expected: "behavioral" },
  { input: "what is polymorphism and inheritance in OOP", expected: "tech-qa" },
  { input: "longest substring without repeating characters using sliding window", expected: "dsa" },
  { input: "explain kafka message queue throughput and partition key", expected: "system-design" },
  { input: "tell me about a time you handled deadline pressure", expected: "behavioral" },
  { input: "difference between process and thread in modern operating systems", expected: "tech-qa" },
  { input: "binary tree maximum path sum depth first search", expected: "dsa" },
  { input: "design a distributed rate limiter for API gateway", expected: "system-design" },
  { input: "what is your greatest failure and how did you overcome it", expected: "behavioral" },
  { input: "how does garbage collection and event loop work in nodejs", expected: "tech-qa" },
  { input: "find median from data stream using max heap and min heap", expected: "dsa" },
  { input: "how to implement consistent hashing for database sharding", expected: "system-design" }
];

console.log('=== RUNNING SKILL ROUTER TEST SUITE ===\n');

let passed = 0;
let total = testCases.length;

testCases.forEach((tc, idx) => {
  const result = skillRouterService.resolveSkill({ text: tc.input });
  const isMatch = result.skill === tc.expected;
  if (isMatch) {
    passed++;
    console.log(`[PASS] #${idx + 1}: "${tc.input}" → ${result.skill} (conf: ${result.confidence})`);
  } else {
    console.error(`[FAIL] #${idx + 1}: "${tc.input}" → got: ${result.skill}, expected: ${tc.expected} (conf: ${result.confidence})`);
  }
});

console.log(`\nText Classification Score: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)\n`);

// Test Router Header Parser
console.log('=== TESTING ROUTER HEADER PARSER ===');
const headerFixtures = [
  {
    raw: "SKILL: dsa | TYPE: coding_problem | CONF: 0.95\n```cpp\nint solution() {}\n```",
    expectedSkill: "dsa",
    expectedType: "coding_problem",
    expectedConf: 0.95,
    hasClean: true
  },
  {
    raw: "SKILL: system-design | TYPE: diagram | CONF: 0.88\nRequirements:\n1. 10M DAU",
    expectedSkill: "system-design",
    expectedType: "diagram",
    expectedConf: 0.88,
    hasClean: true
  },
  {
    raw: "SKILL: behavioral | TYPE: doc_text | CONF: 0.9\nI led the migration...",
    expectedSkill: "behavioral",
    expectedType: "doc_text",
    expectedConf: 0.9,
    hasClean: true
  },
  {
    raw: "SKILL: tech-qa | TYPE: error_traceback | CONF: 0.82\nRoot cause: off-by-one error",
    expectedSkill: "tech-qa",
    expectedType: "error_traceback",
    expectedConf: 0.82,
    hasClean: true
  },
  {
    raw: "No header present\nJust direct answer",
    expectedSkill: null,
    expectedType: null,
    expectedConf: null,
    hasClean: false
  }
];

let headerPassed = 0;
headerFixtures.forEach((fix, idx) => {
  const parsed = skillRouterService.parseRouterHeader(fix.raw);
  const match = parsed.skill === fix.expectedSkill &&
                parsed.imageType === fix.expectedType &&
                (fix.expectedConf === null ? parsed.skillConfidence === null : Math.abs(parsed.skillConfidence - fix.expectedConf) < 0.01);
  if (match) {
    headerPassed++;
    console.log(`[PASS] Header #${idx + 1}`);
  } else {
    console.error(`[FAIL] Header #${idx + 1}:`, parsed, 'expected:', fix);
  }
});

console.log(`Header Parser Score: ${headerPassed}/${headerFixtures.length}`);

if (passed >= 18 && headerPassed === headerFixtures.length) {
  console.log('\n✅ ALL ROUTER CRITERIA MET (≥ 18/20 text + 100% header parsing)');
  process.exit(0);
} else {
  console.error('\n❌ ROUTER CRITERIA FAILED');
  process.exit(1);
}
