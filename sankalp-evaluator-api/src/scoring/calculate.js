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
  return String(correctAns).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function scoreSubject(studentAns, key, subject) {
  let marks = 0;
  let correct = 0;
  let wrong = 0;
  let skipped = 0;

  for (const [qNoStr, correctAns] of Object.entries(key)) {
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
      } else {
        marks -= 0.25;
        wrong++;
      }
    } else if (cat === 2) {
      if (ans === String(correctAns).trim().toUpperCase()) {
        marks += 2;
        correct++;
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
        if (hit === correctSet.size) correct++;
      }
    }
  }

  return { marks: round2(marks), correct, wrong, skipped };
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
    wrong: math.wrong + physics.wrong + chemistry.wrong,
    skipped: math.skipped + physics.skipped + chemistry.skipped,
  };
  const attempted = analytics.correct + analytics.wrong;
  analytics.accuracy = attempted ? round2((analytics.correct / attempted) * 100) : 0;

  return { scores, analytics, perSubject: { math, physics, chemistry } };
}

module.exports = { scoreSubject, scoreSubmission, round2, normalizeStudentAnswer };
