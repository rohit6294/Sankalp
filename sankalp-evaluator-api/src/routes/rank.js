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
    const myTotal = mine.data().scores?.total ?? mine.data().scores?.engineering ?? 0;

    // Fetch all submissions for this exam and compute rank in JS
    // (avoids Firestore composite index requirement for count + inequality on nested field)
    const allSnap = await db.collection('submissions').where('examId', '==', examId).get();
    const totals = allSnap.docs.map(doc => {
      const s = doc.data().scores || {};
      return s.total ?? s.engineering ?? 0;
    });

    const higher = totals.filter(t => t > myTotal).length;
    const total  = totals.length;

    res.json({
      yourRank: higher + 1,
      totalParticipants: total,
      yourTotal: myTotal,
    });
  } catch (e) {
    res.status(500).json({ error: 'rank_failed', message: e.message });
  }
});

module.exports = router;
