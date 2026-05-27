const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');

const router = express.Router();

router.get('/:examId', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { examId } = req.params;
  try {
    const mine = await db.collection('submissions').doc(`${uid}_${examId}`).get();
    if (!mine.exists) return res.status(404).json({ error: 'no_submission' });
    const myTotal = mine.data().scores?.total ?? 0;

    const examFilter = db.collection('submissions').where('examId', '==', examId);

    const [higherSnap, totalSnap] = await Promise.all([
      examFilter.where('scores.total', '>', myTotal).count().get(),
      examFilter.count().get(),
    ]);

    res.json({
      yourRank: higherSnap.data().count + 1,
      totalParticipants: totalSnap.data().count,
      yourTotal: myTotal,
    });
  } catch (e) {
    res.status(500).json({ error: 'rank_failed', message: e.message });
  }
});

module.exports = router;
