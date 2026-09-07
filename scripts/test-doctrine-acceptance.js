require('dotenv').config();
const fs = require('fs');
const path = require('path');
const promptLoader = require('../prompt-loader');
const skillRouter = require('../src/services/skill-router.service');
const llmService = require('../src/services/llm.service');

const isOffline = process.argv.includes('--offline');

async function runAcceptanceTests() {
  console.log('====================================================');
  console.log('PHASE 1 GLOBAL INTERVIEW DOCTRINE ACCEPTANCE TESTS');
  console.log(`Mode: ${isOffline ? 'OFFLINE (Synthetic validation)' : 'LIVE GEMINI API'}`);
  console.log('====================================================\n');

  // Check 0: Core Doctrine Injection check
  const coreDoctrine = promptLoader.getCoreDoctrine();
  if (!coreDoctrine || !coreDoctrine.includes('LIVE INTERVIEW CONTEXT') || !coreDoctrine.includes('ALWAYS ANSWER')) {
    console.error('FAIL: Core Doctrine block missing or incomplete in prompt-loader!');
    process.exit(1);
  }
  console.log('✓ Check 0: Core Doctrine block verified in prompt-loader\n');

  // Paths to real test images
  const leetcodeImgPath = path.join(__dirname, 'test-leetcode.png');
  const tracebackImgPath = path.join(__dirname, 'test-traceback.png');
  const activityImgPath = path.join(__dirname, '..', 'assests', 'icons', 'activity.png');
  const terminalImgPath = path.join(__dirname, '..', 'assests', 'icons', 'terminal.png');

  // 10 Mixed test inputs: 4 voice, 4 real screenshot vision tests, 2 typed
  const testCases = [
    // 1. Voice - Behavioral
    {
      id: 1,
      type: 'voice',
      label: 'Voice / Behavioral: Tell me about yourself',
      input: 'tell me about yourself and your journey',
      expectedSkill: 'behavioral',
      style: 'spoken',
      maxWords: 180
    },
    // 2. Voice - System Design
    {
      id: 2,
      type: 'voice',
      label: 'Voice / System Design: URL Shortener',
      input: 'in under 100 words, how would you design a url shortener like tinyurl',
      expectedSkill: 'system-design',
      style: 'concise',
      maxWords: 120
    },
    // 3. Voice - Tech Q&A
    {
      id: 3,
      type: 'voice',
      label: 'Voice / Tech Q&A: Process vs Thread',
      input: 'in under 100 words, what is the difference between a process and a thread in operating systems',
      expectedSkill: 'tech-qa',
      style: 'concise',
      maxWords: 120
    },
    // 4. Voice - Fragment / Ambiguous Caching
    {
      id: 4,
      type: 'voice',
      label: 'Voice / Fragment: Ambiguous caching question',
      input: 'uh... so the... caching?',
      expectedSkill: 'system-design',
      style: 'concise',
      maxWords: 120
    },
    // 5. Screenshot - Real PNG Vision Test: LeetCode Two Sum
    {
      id: 5,
      type: 'screenshot_vision',
      label: 'Screenshot / Vision: Real Two Sum image',
      imagePath: leetcodeImgPath,
      expectedSkill: 'dsa',
      expectedImageType: 'coding_problem',
      streaming: false
    },
    // 6. Screenshot - Real PNG Vision Streaming Test: Traceback
    {
      id: 6,
      type: 'screenshot_vision_stream',
      label: 'Screenshot / Vision Streaming: Real NullPointerException traceback image',
      imagePath: tracebackImgPath,
      expectedSkill: 'tech-qa',
      expectedImageType: 'error_traceback',
      streaming: true
    },
    // 7. Screenshot - Real PNG Vision Test: System Architecture Graph
    {
      id: 7,
      type: 'screenshot_vision',
      label: 'Screenshot / Vision: Architecture / activity diagram image',
      imagePath: activityImgPath,
      expectedSkill: 'system-design',
      expectedImageType: 'diagram',
      streaming: false
    },
    // 8. Screenshot - Real PNG Vision Streaming Test: Terminal output
    {
      id: 8,
      type: 'screenshot_vision_stream',
      label: 'Screenshot / Vision Streaming: Terminal command window image',
      imagePath: terminalImgPath,
      expectedSkill: 'tech-qa',
      expectedImageType: 'terminal_output',
      streaming: true
    },
    // 9. Typed - Ambiguous follow-up optimization
    {
      id: 9,
      type: 'typed',
      label: 'Typed / Ambiguous: Follow-up space optimization',
      input: 'can we do O(1) space on the previous solution?',
      expectedSkill: 'dsa'
    },
    // 10. Typed - Chit-chat / Audio greeting (production default activeSkill='dsa')
    {
      id: 10,
      type: 'typed',
      label: 'Typed / Chit-chat: Hello audio check',
      input: 'hello can you hear me',
      expectedSkill: 'general',
      isChitChat: true,
      maxWords: 25
    }
  ];

  let passedTests = 0;
  const results = [];

  for (const tc of testCases) {
    console.log(`--- Test ${tc.id}: ${tc.label} ---`);
    let success = true;
    const failureReasons = [];

    let routedSkill = null;
    let confidence = 0;
    let routerReason = '';

    // 1. Router resolution
    if (tc.type.startsWith('screenshot_vision')) {
      // Vision model headers will classify the image; test fallback router with imageType
      const route = skillRouter.resolveSkill({
        imageType: tc.expectedImageType,
        activeSkill: 'dsa'
      });
      routedSkill = route.skill;
      confidence = route.confidence;
      routerReason = route.reason;
    } else {
      const route = skillRouter.resolveSkill({
        text: tc.input,
        activeSkill: 'dsa' // Production default!
      });
      routedSkill = route.skill;
      confidence = route.confidence;
      routerReason = route.reason;
    }

    console.log(`  Router: ${routedSkill} (Conf: ${confidence.toFixed(2)}, Reason: ${routerReason})`);

    // Strict Assertion: Router MUST match expectedSkill!
    if (routedSkill !== tc.expectedSkill) {
      success = false;
      failureReasons.push(`Routing mismatch: expected '${tc.expectedSkill}', got '${routedSkill}'`);
    }

    // 2. Prompt composition check: CORE must lead
    const systemPrompt = promptLoader.buildSystemPrompt(routedSkill, { language: 'cpp', style: tc.style || 'concise' });
    if (!systemPrompt.startsWith(coreDoctrine)) {
      success = false;
      failureReasons.push('CORE doctrine was NOT at top of composed prompt');
    }

    // 3. Execution
    let responseText = '';
    let streamChunks = [];
    let imageMetadata = null;

    try {
      if (tc.type === 'voice') {
        if (isOffline) {
          responseText = tc.id === 4
            ? "*Assuming: You want a quick summary of caching strategies.* Use Redis cache-aside with a 5-minute TTL to boost read throughput and protect the DB."
            : "Use a hash ring for partition keys. Redis handles 100k RPS caching, and Postgres provides persistent storage with write sharding.";
        } else {
          const res = await llmService.processTranscriptionWithIntelligentResponse(tc.input, {
            activeSkill: routedSkill,
            codingLanguage: 'cpp',
            style: tc.style || 'concise',
            history: []
          });
          responseText = res?.response || '';
        }
      } else if (tc.type === 'typed') {
        if (isOffline) {
          responseText = tc.isChitChat
            ? "Loud and clear. Ready whenever you are."
            : "Assuming: The previous solution stored frequencies in a hash map. We can sort in-place first to achieve O(1) auxiliary space.";
        } else {
          const res = await llmService.processTextWithSkill(tc.input, routedSkill, {
            language: 'cpp',
            style: tc.style || 'concise',
            history: []
          });
          responseText = res?.response || '';
        }
      } else if (tc.type === 'screenshot_vision') {
        // Real PNG bytes live test (non-streaming)
        const imgBuffer = fs.readFileSync(tc.imagePath);
        if (isOffline) {
          responseText = "SKILL: dsa | TYPE: coding_problem | CONF: 0.95\nHash map lookups provide O(N) time and O(N) space.\n```cpp\nclass Solution {};\n```";
          imageMetadata = { skill: tc.expectedSkill, imageType: tc.expectedImageType, skillConfidence: 0.9 };
        } else {
          const res = await llmService.processImageWithSkill(imgBuffer, 'image/png', 'dsa');
          responseText = res?.response || '';
          imageMetadata = res?.metadata || {};
        }
      } else if (tc.type === 'screenshot_vision_stream') {
        // Real PNG bytes live streaming test
        const imgBuffer = fs.readFileSync(tc.imagePath);
        if (isOffline) {
          responseText = "Root cause: The user reference is null on line 42.\nMinimal fix: Check if user is null before invoking getName.";
          streamChunks = [responseText];
          imageMetadata = { skill: tc.expectedSkill, imageType: tc.expectedImageType, skillConfidence: 0.9 };
        } else {
          const res = await llmService.processImageWithSkillStream(
            imgBuffer,
            'image/png',
            'dsa',
            [],
            'cpp',
            {},
            (delta) => {
              streamChunks.push(delta);
            }
          );
          responseText = res?.response || '';
          imageMetadata = res?.metadata || {};
        }
      }
    } catch (err) {
      success = false;
      failureReasons.push(`API Error: ${err.message}`);
    }

    // 4. Vision-specific assertions
    if (tc.type.startsWith('screenshot_vision')) {
      if (imageMetadata) {
        console.log(`  Vision Metadata: skill=${imageMetadata.skill}, type=${imageMetadata.imageType}, conf=${imageMetadata.skillConfidence}`);
        if (!imageMetadata.skill) {
          success = false;
          failureReasons.push('Vision model failed to return detected skill in metadata');
        }
      } else {
        success = false;
        failureReasons.push('No image metadata returned');
      }

      if (tc.streaming) {
        console.log(`  Streaming chunks received: ${streamChunks.length}`);
        if (streamChunks.length === 0) {
          success = false;
          failureReasons.push('No streaming chunks received in onDelta');
        }
        // Verify stream concealment: line 1 must NOT contain SKILL:
        const firstChunk = streamChunks[0] || '';
        if (/^SKILL:\s*[\w-]+/i.test(firstChunk.trim())) {
          success = false;
          failureReasons.push(`Streaming leaked header to client: "${firstChunk}"`);
        }
      }
    }

    // 5. General response checks
    // Strip header if present (as displayed in UI)
    const strippedText = responseText.replace(/^SKILL:\s*[\w-]+\s*\|\s*TYPE:\s*[\w_]+\s*\|\s*CONF:\s*[01](?:\.\d+)?\s*\n?/i, '').trim();
    const firstLine = strippedText.split('\n').filter(l => l.trim().length > 0)[0] || '';
    const wordCount = strippedText.split(/\s+/).filter(w => w.length > 0).length;

    console.log(`  First line: "${firstLine.substring(0, 80)}${firstLine.length > 80 ? '...' : ''}"`);
    console.log(`  Word count: ${wordCount}`);

    // A. Doctrine sanity: No clarifying questions
    const compliance = llmService.checkDoctrineCompliance(strippedText, tc.label);
    if (!compliance.compliant) {
      success = false;
      failureReasons.push(`Asked clarifying question: ${compliance.matches.join(', ')}`);
    }

    // B. No refusals / stalls
    const refusalPatterns = [
      /i cannot answer/i,
      /need more information/i,
      /please provide more context/i,
      /as an ai language model/i
    ];
    for (const rp of refusalPatterns) {
      if (rp.test(strippedText)) {
        success = false;
        failureReasons.push('Model refused or stalled instead of answering');
        break;
      }
    }

    // C. No preamble on first line
    const preamblePatterns = [
      /^sure[!,.]/i,
      /^certainly[!,.]/i,
      /^here is /i,
      /^here's /i,
      /^i would be happy to/i,
      /^great question[!,.]/i
    ];
    for (const pp of preamblePatterns) {
      if (pp.test(firstLine)) {
        success = false;
        failureReasons.push(`First line has conversational preamble: "${firstLine}"`);
        break;
      }
    }

    // D. Strict word budget enforcement
    if (tc.maxWords && wordCount > tc.maxWords) {
      success = false;
      failureReasons.push(`Word count (${wordCount}) exceeded doctrine budget (${tc.maxWords})`);
    }

    if (success) {
      console.log('  RESULT: PASS ✓\n');
      passedTests++;
    } else {
      console.log(`  RESULT: FAIL ✗ (${failureReasons.join('; ')})\n`);
    }

    results.push({
      id: tc.id,
      label: tc.label,
      routedSkill,
      firstLine,
      wordCount,
      passed: success,
      reasons: failureReasons
    });
  }

  console.log('====================================================');
  console.log(`DOCTRINE ACCEPTANCE SUMMARY: ${passedTests}/${testCases.length} PASSED`);
  console.log('====================================================');

  return { passedTests, totalTests: testCases.length, results };
}

runAcceptanceTests().then(summary => {
  if (summary.passedTests === summary.totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}).catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
