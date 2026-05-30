const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');

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

    res.json({
      examId,
      examName: data.examName || examData.name || examId,
      set: data.set || data.mathSet,
      mathSet: data.mathSet,
      physChemSet: data.physChemSet,
      scores: data.scores,
      analytics: data.analytics,
      perSubject: data.perSubject,
      expectedRank: data.expectedRank,
      submittedAt: data.submittedAt ? data.submittedAt.toMillis() : null,
      answers: data.answers || {},
      keys,
    });
  } catch (e) {
    res.status(500).json({ error: 'result_failed', message: e.message });
  }
});

module.exports = router;
