const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreSubject, scoreSubmission, round2, normalizeStudentAnswer } = require('../src/scoring/calculate');
const { categoryFor } = require('../src/categories');
const { predictRank } = require('../src/scoring/ranking');

test('categoryFor: math ranges', () => {
  assert.equal(categoryFor('math', 1), 1);
  assert.equal(categoryFor('math', 50), 1);
  assert.equal(categoryFor('math', 51), 2);
  assert.equal(categoryFor('math', 65), 2);
  assert.equal(categoryFor('math', 66), 3);
  assert.equal(categoryFor('math', 75), 3);
});

test('categoryFor: physics ranges', () => {
  assert.equal(categoryFor('physics', 1), 1);
  assert.equal(categoryFor('physics', 30), 1);
  assert.equal(categoryFor('physics', 31), 2);
  assert.equal(categoryFor('physics', 35), 2);
  assert.equal(categoryFor('physics', 36), 3);
  assert.equal(categoryFor('physics', 40), 3);
});

test('categoryFor: chemistry ranges (1..40 local)', () => {
  assert.equal(categoryFor('chemistry', 1), 1);
  assert.equal(categoryFor('chemistry', 30), 1);
  assert.equal(categoryFor('chemistry', 31), 2);
  assert.equal(categoryFor('chemistry', 35), 2);
  assert.equal(categoryFor('chemistry', 36), 3);
  assert.equal(categoryFor('chemistry', 40), 3);
});

test('Cat 1: correct gives +1, wrong gives -0.25', () => {
  const key = { 1: 'A', 2: 'B', 3: 'C' };
  const ans = { 1: 'A', 2: 'X', 3: 'C' };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 1.75);
  assert.equal(r.correct, 2);
  assert.equal(r.wrong, 1);
  assert.equal(r.skipped, 0);
});

test('Cat 2: correct gives +2, wrong gives -0.5', () => {
  const key = { 51: 'A', 52: 'B', 53: 'C' };
  const ans = { 51: 'A', 52: 'X', 53: 'C' };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 3.5);
  assert.equal(r.correct, 2);
  assert.equal(r.wrong, 1);
});

test('Cat 3 edge: correct=ABC student=AB -> 1.33', () => {
  const key = { 66: 'A,B,C' };
  const ans = { 66: ['A', 'B'] };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 1.33);
  assert.equal(r.wrong, 0);
});

test('Cat 3 edge: correct=ABC student=A -> 0.67', () => {
  const key = { 66: 'A,B,C' };
  const ans = { 66: ['A'] };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 0.67);
});

test('Cat 3 edge: correct=ABC student=ABD -> 0 (any wrong)', () => {
  const key = { 66: 'A,B,C' };
  const ans = { 66: ['A', 'B', 'D'] };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 0);
  assert.equal(r.wrong, 1);
});

test('Cat 3: full match gives 2 and counts as correct', () => {
  const key = { 66: 'A,B,C' };
  const ans = { 66: ['A', 'B', 'C'] };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 2);
  assert.equal(r.correct, 1);
});

test('Skipped: null and undefined both count as skipped, not wrong', () => {
  const key = { 1: 'A', 2: 'B', 66: 'A,B' };
  const ans = { 1: null, 2: undefined, 66: null };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 0);
  assert.equal(r.skipped, 3);
  assert.equal(r.wrong, 0);
});

test('Rounding: marks always rounded to 2dp', () => {
  assert.equal(round2(1.3333333), 1.33);
  assert.equal(round2(0.6666666), 0.67);
  assert.equal(round2(-0.75), -0.75);
});

test('normalizeStudentAnswer: handles strings, arrays, empties', () => {
  assert.equal(normalizeStudentAnswer('a'), 'A');
  assert.deepEqual(normalizeStudentAnswer(['b', 'a']), ['A', 'B']);
  assert.equal(normalizeStudentAnswer(''), null);
  assert.equal(normalizeStudentAnswer(null), null);
  assert.equal(normalizeStudentAnswer([]), null);
});

test('scoreSubmission: aggregates math + physics + chemistry', () => {
  const answers = {
    math: { 1: 'A', 2: 'B' },
    physics: { 1: 'A' },
    chemistry: { 1: 'C' },
  };
  const keys = {
    math: { 1: 'A', 2: 'B' },
    physics: { 1: 'A' },
    chemistry: { 1: 'C' },
  };
  const r = scoreSubmission(answers, keys);
  assert.equal(r.scores.math, 2);
  assert.equal(r.scores.physics, 1);
  assert.equal(r.scores.chemistry, 1);
  assert.equal(r.scores.total, 4);
  assert.equal(r.analytics.correct, 4);
  assert.equal(r.analytics.wrong, 0);
  assert.equal(r.analytics.accuracy, 100);
});

test('predictRank: finds the right band', () => {
  const rows = [
    { marksMin: 0, marksMax: 99, rankMin: 5000, rankMax: 20000 },
    { marksMin: 100, marksMax: 139, rankMin: 2000, rankMax: 4999 },
    { marksMin: 140, marksMax: 159, rankMin: 400, rankMax: 1999 },
    { marksMin: 160, marksMax: 300, rankMin: 1, rankMax: 399 },
  ];
  assert.deepEqual(predictRank(145, rows), { min: 400, max: 1999 });
  assert.deepEqual(predictRank(100, rows), { min: 2000, max: 4999 });
  assert.deepEqual(predictRank(0, rows), { min: 5000, max: 20000 });
  assert.equal(predictRank(999, rows), null);
});
