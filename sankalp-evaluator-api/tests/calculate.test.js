const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreSubject, scoreSubmission, round2, normalizeStudentAnswer, applyExamBonus } = require('../src/scoring/calculate');
const { categoryFor } = require('../src/categories');
const { defaultRankRows, predictRank, formatRankRange } = require('../src/scoring/ranking');
const { missingAnswerNumbers } = require('../src/exam-readiness');

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

test('categoryFor: chemistry ranges (41..80 paper)', () => {
  assert.equal(categoryFor('chemistry', 41), 1);
  assert.equal(categoryFor('chemistry', 70), 1);
  assert.equal(categoryFor('chemistry', 71), 2);
  assert.equal(categoryFor('chemistry', 75), 2);
  assert.equal(categoryFor('chemistry', 76), 3);
  assert.equal(categoryFor('chemistry', 80), 3);
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
  assert.equal(r.partial, 1);
  assert.equal(r.wrong, 0);
  assert.equal(r.accuracy, 66.67);
});

test('Cat 3 edge: correct=ABC student=A -> 0.67', () => {
  const key = { 66: 'A,B,C' };
  const ans = { 66: ['A'] };
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 0.67);
  assert.equal(r.partial, 1);
  assert.equal(r.accuracy, 33.33);
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
  assert.equal(r.partial, 0);
});

test('Cat 3: compact answer key ABC is treated as A,B,C', () => {
  const key = { 66: 'ABC' };
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
    chemistry: { 41: 'C' },
  };
  const keys = {
    math: { 1: 'A', 2: 'B' },
    physics: { 1: 'A' },
    chemistry: { 41: 'C' },
  };
  const r = scoreSubmission(answers, keys);
  assert.equal(r.scores.math, 2);
  assert.equal(r.scores.physics, 1);
  assert.equal(r.scores.chemistry, 1);
  assert.equal(r.scores.total, 4);
  assert.equal(r.analytics.correct, 4);
  assert.equal(r.analytics.partial, 0);
  assert.equal(r.analytics.wrong, 0);
  assert.equal(r.analytics.accuracy, 100);
});

test('scoreSubmission: partial answers are counted in analytics', () => {
  const answers = {
    math: { 66: ['A', 'B'] },
    physics: {},
    chemistry: {},
  };
  const keys = {
    math: { 66: 'A,B,C' },
    physics: {},
    chemistry: {},
  };
  const r = scoreSubmission(answers, keys);
  assert.equal(r.scores.math, 1.33);
  assert.equal(r.analytics.correct, 0);
  assert.equal(r.analytics.partial, 1);
  assert.equal(r.analytics.wrong, 0);
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
  assert.deepEqual(predictRank(-10, rows), { min: 5000, max: 20000 });
  assert.deepEqual(predictRank(999, rows), { min: 1, max: 399 });
});

test('defaultRankRows: provides engineering and bpharma fallbacks', () => {
  assert.ok(defaultRankRows('engineering').length > 0);
  assert.ok(defaultRankRows('bpharma').length > 0);
});

test('formatRankRange: formats rank bands without object coercion', () => {
  assert.equal(formatRankRange({ min: 400, max: 1999 }), '400 - 1,999');
  assert.equal(formatRankRange({ min: 125, max: 125 }), '125');
  assert.equal(formatRankRange(94), '94');
  assert.equal(formatRankRange(null), '');
});

test('missingAnswerNumbers: detects incomplete keys', () => {
  const key = {};
  for (let qNo = 1; qNo <= 75; qNo += 1) key[String(qNo)] = 'A';
  delete key['17'];
  delete key['75'];
  assert.deepEqual(missingAnswerNumbers('math', key), [17, 75]);
});

test('applyExamBonus: always returns engineering and bpharma scores', () => {
  const scores = {
    math: 10,
    physics: 15,
    chemistry: 20,
    total: 45,
  };
  
  // Test with bonus = 0
  const updated0 = applyExamBonus(scores, 0);
  assert.equal(updated0.bonus, 0);
  assert.equal(updated0.engineering, 45);
  assert.equal(updated0.bpharma, 35);
  assert.equal(updated0.total, 45);

  // Test with bonus = 5
  const updated5 = applyExamBonus(scores, 5);
  assert.equal(updated5.bonus, 5);
  assert.equal(updated5.engineering, 50);
  assert.equal(updated5.bpharma, 40);
  assert.equal(updated5.total, 50);
});

test('scoreSubject: ignores BONUS questions entirely', () => {
  const key = { 1: 'A', 2: 'BONUS', 3: 'C' };
  const ans = { 1: 'A', 2: 'A', 3: 'X' }; // Q2 is answered incorrectly, Q3 is incorrect
  const r = scoreSubject(ans, key, 'math');
  assert.equal(r.marks, 0.75); // Q1 (+1), Q2 (ignored/0), Q3 (-0.25) -> 0.75
  assert.equal(r.correct, 1);
  assert.equal(r.wrong, 1); // Q3 is wrong
  assert.equal(r.skipped, 0);
  assert.equal(r.totalQuestions, 2); // Q2 is excluded
});
