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
    res.json({
      examId,
      set: data.set || data.mathSet,
      mathSet: data.mathSet,
      physChemSet: data.physChemSet,
      scores: data.scores,
      analytics: data.analytics,
      perSubject: data.perSubject,
      expectedRank: data.expectedRank,
      submittedAt: data.submittedAt ? data.submittedAt.toMillis() : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'result_failed', message: e.message });
  }
});

module.exports = router;
