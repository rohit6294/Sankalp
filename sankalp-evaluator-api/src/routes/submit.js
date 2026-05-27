const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken } = require('../auth');
const { COUNTS } = require('../categories');
const { scoreSubmission, round2 } = require('../scoring/calculate');
const { predictRank } = require('../scoring/ranking');

const router = express.Router();

function validateAnswerKeyBlock(subject, keyMap) {
  const missing = [];
  const count = COUNTS[subject] || 0;
  for (let qNo = 1; qNo <= count; qNo += 1) {
    const value = keyMap ? keyMap[String(qNo)] : undefined;
    if (typeof value !== 'string' || !value.trim()) {
      missing.push(qNo);
    }
  }
  return missing;
}

router.post('/', verifyToken, async (req, res) => {
  const { examId, mathSet, physChemSet, answers } = req.body || {};
  if (!examId || !mathSet || !physChemSet || !answers) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const sets = ['A', 'B', 'C', 'D'];
  if (!sets.includes(mathSet) || !sets.includes(physChemSet)) {
    return res.status(400).json({ error: 'invalid_set' });
  }

  const uid = req.user.uid;
  const docId = `${uid}_${examId}`;
  const subRef = db.collection('submissions').doc(docId);

  try {
    const existing = await subRef.get();
    if (existing.exists) {
      return res.status(409).json({ error: 'already_submitted' });
    }

    // Fetch the two separate answer key documents
    const mathKeyRef = db.collection('exams').doc(examId).collection('answerKeys').doc(`math_${mathSet}`);
    const physChemKeyRef = db.collection('exams').doc(examId).collection('answerKeys').doc(`physChem_${physChemSet}`);

    const [mathKeyDoc, physChemKeyDoc] = await Promise.all([
      mathKeyRef.get(),
      physChemKeyRef.get(),
    ]);

    if (!mathKeyDoc.exists || !physChemKeyDoc.exists) {
      return res.status(404).json({ error: 'answer_key_not_found' });
    }

    const mathData = mathKeyDoc.data() || {};
    const physChemData = physChemKeyDoc.data() || {};

    const keys = {
      math: mathData.math || {},
      physics: physChemData.physics || {},
      chemistry: physChemData.chemistry || {},
    };

    const missingMath = validateAnswerKeyBlock('math', keys.math);
    const missingPhysics = validateAnswerKeyBlock('physics', keys.physics);
    const missingChemistry = validateAnswerKeyBlock('chemistry', keys.chemistry);
    if (missingMath.length || missingPhysics.length || missingChemistry.length) {
      const problems = [];
      if (missingMath.length) problems.push(`math missing ${missingMath.length}`);
      if (missingPhysics.length) problems.push(`physics missing ${missingPhysics.length}`);
      if (missingChemistry.length) problems.push(`chemistry missing ${missingChemistry.length}`);
      return res.status(400).json({
        error: 'incomplete_answer_key',
        message: `Answer key is incomplete: ${problems.join(', ')}`,
      });
    }

    const { scores, analytics, perSubject } = scoreSubmission(answers, keys);

    // Compute Engineering and B-Pharma scores
    scores.engineering = scores.total;
    scores.bpharma = round2(scores.physics + scores.chemistry);

    // Fetch both rank tables
    const engRankRef = db.collection('exams').doc(examId).collection('rankTable').doc('engineering');
    const bphRankRef = db.collection('exams').doc(examId).collection('rankTable').doc('bpharma');

    const [engRankDoc, bphRankDoc] = await Promise.all([
      engRankRef.get(),
      bphRankRef.get(),
    ]);

    let expectedRank = { engineering: null, bpharma: null };

    if (engRankDoc.exists) {
      expectedRank.engineering = predictRank(scores.engineering, engRankDoc.data().rows || []);
    }
    if (bphRankDoc.exists) {
      expectedRank.bpharma = predictRank(scores.bpharma, bphRankDoc.data().rows || []);
    }

    const payload = {
      userId: uid,
      examId,
      mathSet,
      physChemSet,
      answers,
      scores,
      analytics,
      perSubject,
      expectedRank,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      locked: true,
    };
    await subRef.create(payload);

    res.json({ ok: true, scores, analytics, expectedRank });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message || '')) {
      return res.status(409).json({ error: 'already_submitted' });
    }
    res.status(500).json({ error: 'submit_failed', message: e.message });
  }
});

module.exports = router;
