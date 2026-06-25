const { test } = require('node:test');
const assert = require('node:assert/strict');

// Simulates the backend sorting logic implemented in choice-filling.js
function sortChoices(choices, tfwPrioritized) {
  const processedChoices = [...choices];
  if (tfwPrioritized) {
    processedChoices.sort((a, b) => {
      if (a.isTfw && !b.isTfw) return -1;
      if (!a.isTfw && b.isTfw) return 1;
      return a.baseCutoff - b.baseCutoff;
    });
  } else {
    processedChoices.sort((a, b) => a.baseCutoff - b.baseCutoff);
  }
  return processedChoices;
}

test('choice-filling sort: sorts strictly by cutoff rank when TFW prioritization is disabled', () => {
  const mockChoices = [
    { institute: 'A', isTfw: false, baseCutoff: 500 },
    { institute: 'B', isTfw: true, baseCutoff: 1500 },
    { institute: 'C', isTfw: false, baseCutoff: 100 },
    { institute: 'D', isTfw: true, baseCutoff: 800 },
  ];

  const sorted = sortChoices(mockChoices, false);

  // Expected: C (100) -> A (500) -> D (800) -> B (1500)
  assert.deepEqual(sorted.map(c => c.institute), ['C', 'A', 'D', 'B']);
});

test('choice-filling sort: bubbles TFW choices to the top when TFW prioritization is enabled', () => {
  const mockChoices = [
    { institute: 'A', isTfw: false, baseCutoff: 500 },
    { institute: 'B', isTfw: true, baseCutoff: 1500 },
    { institute: 'C', isTfw: false, baseCutoff: 100 },
    { institute: 'D', isTfw: true, baseCutoff: 800 },
  ];

  const sorted = sortChoices(mockChoices, true);

  // TFW choices (B, D) should be at the top, sorted by baseCutoff ascending: D (800) -> B (1500)
  // Non-TFW choices (A, C) should be below, sorted by baseCutoff ascending: C (100) -> A (500)
  assert.deepEqual(sorted.map(c => c.institute), ['D', 'B', 'C', 'A']);
});
