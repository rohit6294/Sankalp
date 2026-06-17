const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');
const { defaultRankRows, predictRank } = require('../scoring/ranking');
const { round2 } = require('../scoring/calculate');

const router = express.Router();

router.get('/:examId', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { examId } = req.params;
  try {
    const snap = await db.collection('submissions').doc(`${uid}_${examId}`).get();
    if (!snap.exists) return res.status(404).json({ error: 'no_submission' });
    const data = snap.data();
    const examSnap = await db.collection('exams').doc(examId).get();
    const examData = examSnap.exists ? examSnap.data() : {};

    // Fetch the two separate answer key documents securely on the server
    const examRef = db.collection('exams').doc(examId);
    const mathKeyRef = examRef.collection('answerKeys').doc(`math_${data.mathSet}`);
    const physChemKeyRef = examRef.collection('answerKeys').doc(`physChem_${data.physChemSet}`);

    const [mathKeyDoc, physChemKeyDoc] = await Promise.all([
      mathKeyRef.get(),
      physChemKeyRef.get(),
    ]);

    const mathData = mathKeyDoc.exists ? (mathKeyDoc.data() || {}) : {};
    const physChemData = physChemKeyDoc.exists ? (physChemKeyDoc.data() || {}) : {};

    const keys = {
      math: mathData.math || {},
      physics: physChemData.physics || {},
      chemistry: physChemData.chemistry || {},
    };

    const s = data.scores || {};
    let finalScores = data.scores;
    let finalExpectedRank = data.expectedRank;

    // Fallback on-the-fly for old submissions that were affected by the scoring bug
    if (s.engineering === undefined || s.bpharma === undefined || !finalExpectedRank || finalExpectedRank.engineering === null) {
      const engRankRef = examRef.collection('rankTable').doc('engineering');
      const bphRankRef = examRef.collection('rankTable').doc('bpharma');
      const [engRankDoc, bphRankDoc] = await Promise.all([
        engRankRef.get(),
        bphRankRef.get(),
      ]);
      const engineeringRows = engRankDoc.exists ? (engRankDoc.data().rows || []) : defaultRankRows('engineering');
      const bpharmaRows = bphRankDoc.exists ? (bphRankDoc.data().rows || []) : defaultRankRows('bpharma');

      const engScore = s.engineering ?? s.total ?? 0;
      const bphScore = s.bpharma ?? (s.physics !== undefined && s.chemistry !== undefined ? round2(s.physics + s.chemistry) : 0);

      finalScores = {
        ...s,
        engineering: engScore,
        bpharma: bphScore,
        bonus: s.bonus ?? 0,
      };

      finalExpectedRank = {
        engineering: (finalExpectedRank?.engineering) || predictRank(engScore, engineeringRows),
        bpharma: (finalExpectedRank?.bpharma) || predictRank(bphScore, bpharmaRows),
      };
    }

    res.json({
      examId,
      examName: data.examName || examData.name || examId,
      set: data.set || data.mathSet,
      mathSet: data.mathSet,
      physChemSet: data.physChemSet,
      scores: finalScores,
      analytics: data.analytics,
      perSubject: data.perSubject,
      expectedRank: finalExpectedRank,
      submittedAt: data.submittedAt ? data.submittedAt.toMillis() : null,
      answers: data.answers || {},
      keys,
    });
  } catch (e) {
    res.status(500).json({ error: 'result_failed', message: e.message });
  }
});

module.exports = router;
