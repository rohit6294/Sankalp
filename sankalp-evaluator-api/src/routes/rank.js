const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');

const router = express.Router();

// Server-side cache for exam scores list (60-second TTL)
const totalsCache = {}; // { examId: { totals: [...], cachedAt: timestamp } }
const CACHE_TTL_MS = 60000; // 60 seconds

async function getCachedExamTotals(examId) {
  const now = Date.now();
  if (totalsCache[examId] && (now - totalsCache[examId].cachedAt) < CACHE_TTL_MS) {
    return totalsCache[examId].totals;
  }

  const { getExamScores } = require('../exam-stats-cache');
  const totals = await getExamScores(examId);

  totalsCache[examId] = {
    totals,
    cachedAt: now
  };
  return totals;
}

function bustExamTotalsCache(examId) {
  delete totalsCache[examId];
}

router.get('/:examId', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { examId } = req.params;
  try {
    const mine = await db.collection('submissions').doc(`${uid}_${examId}`).get();
    if (!mine.exists) return res.status(404).json({ error: 'no_submission' });
    const myTotal = mine.data().scores?.total ?? mine.data().scores?.engineering ?? 0;

    // Retrieve from 60-second cache instead of hitting Firestore collection scans every time
    const totals = await getCachedExamTotals(examId);

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

router.bustExamTotalsCache = bustExamTotalsCache;
module.exports = router;
