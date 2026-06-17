const { categoryFor } = require('../categories');

const round2 = (n) => Math.round(n * 100) / 100;

function normalizeStudentAnswer(ans) {
  if (ans === null || ans === undefined || ans === '') return null;
  if (Array.isArray(ans)) {
    const clean = ans.filter(Boolean).map(String).map((s) => s.trim().toUpperCase());
    return clean.length ? Array.from(new Set(clean)).sort() : null;
  }
  return String(ans).trim().toUpperCase();
}

function parseCorrect(correctAns) {
  const value = String(correctAns).trim().toUpperCase();
  if (/^[A-D]{2,4}$/.test(value)) {
    return Array.from(new Set(value.split(''))).sort();
  }
  return value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function scoreSubject(studentAns, key, subject) {
  let marks = 0;
  let correct = 0;
  let partial = 0;
  let wrong = 0;
  let skipped = 0;
  let effectiveCorrect = 0;
  const entries = Object.entries(key || {});
  let totalQuestions = 0;

  for (const [qNoStr, correctAns] of entries) {
    if (String(correctAns).trim().toUpperCase() === 'BONUS') {
      continue;
    }
    totalQuestions++;

    const qNo = Number(qNoStr);
    const cat = categoryFor(subject, qNo);
    const ans = normalizeStudentAnswer(studentAns ? studentAns[qNoStr] : null);

    if (ans === null) {
      skipped++;
      continue;
    }

    if (cat === 1) {
      if (ans === String(correctAns).trim().toUpperCase()) {
        marks += 1;
        correct++;
        effectiveCorrect += 1;
      } else {
        marks -= 0.25;
        wrong++;
      }
    } else if (cat === 2) {
      if (ans === String(correctAns).trim().toUpperCase()) {
        marks += 2;
        correct++;
        effectiveCorrect += 1;
      } else {
        marks -= 0.5;
        wrong++;
      }
    } else if (cat === 3) {
      const correctOpts = parseCorrect(correctAns);
      const correctSet = new Set(correctOpts);
      const studentOpts = Array.isArray(ans) ? ans : [ans];
      const anyWrong = studentOpts.some((x) => !correctSet.has(x));
      if (anyWrong) {
        wrong++;
      } else {
        const hit = studentOpts.filter((x) => correctSet.has(x)).length;
        marks += (hit / correctSet.size) * 2;
        effectiveCorrect += hit / correctSet.size;
        if (hit === correctSet.size) {
          correct++;
        } else {
          partial++;
        }
      }
    }
  }

  const answered = totalQuestions - skipped;
  return {
    marks: round2(marks),
    correct,
    partial,
    wrong,
    skipped,
    answered,
    totalQuestions,
    accuracy: answered ? round2((effectiveCorrect / answered) * 100) : 0,
  };
}

function scoreSubmission(answers, keys) {
  const math = scoreSubject(answers.math || {}, keys.math || {}, 'math');
  const physics = scoreSubject(answers.physics || {}, keys.physics || {}, 'physics');
  const chemistry = scoreSubject(answers.chemistry || {}, keys.chemistry || {}, 'chemistry');

  const scores = {
    math: math.marks,
    physics: physics.marks,
    chemistry: chemistry.marks,
    total: round2(math.marks + physics.marks + chemistry.marks),
  };
  const analytics = {
    correct: math.correct + physics.correct + chemistry.correct,
    partial: math.partial + physics.partial + chemistry.partial,
    wrong: math.wrong + physics.wrong + chemistry.wrong,
    skipped: math.skipped + physics.skipped + chemistry.skipped,
  };
  const answered = math.answered + physics.answered + chemistry.answered;
  const effectiveCorrect = (
    (math.accuracy * math.answered) +
    (physics.accuracy * physics.answered) +
    (chemistry.accuracy * chemistry.answered)
  ) / 100;
  analytics.answered = answered;
  analytics.totalQuestions = math.totalQuestions + physics.totalQuestions + chemistry.totalQuestions;
  analytics.accuracy = answered ? round2((effectiveCorrect / answered) * 100) : 0;

  return { scores, analytics, perSubject: { math, physics, chemistry } };
}

function applyExamBonus(scores, bonus = 0) {
  const normalizedBonus = Number.isFinite(Number(bonus)) ? round2(Number(bonus)) : 0;
  const updated = { ...scores, bonus: normalizedBonus };
  updated.engineering = round2((scores.total || 0) + normalizedBonus);
  updated.bpharma = round2((scores.physics || 0) + (scores.chemistry || 0) + normalizedBonus);
  updated.total = updated.engineering;
  return updated;
}

module.exports = { scoreSubject, scoreSubmission, round2, normalizeStudentAnswer, applyExamBonus };
