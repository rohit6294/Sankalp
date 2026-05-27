const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken } = require('../auth');
const { scoreSubmission } = require('../scoring/calculate');
const { predictRank } = require('../scoring/ranking');

const router = express.Router();

router.post('/', verifyToken, async (req, res) => {
  const { examId, set, answers } = req.body || {};
  if (!examId || !set || !answers) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (!['A', 'B', 'C', 'D'].includes(set)) {
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

    const keyDoc = await db
      .collection('exams').doc(examId)
      .collection('answerKeys').doc(set)
      .get();
    if (!keyDoc.exists) {
      return res.status(404).json({ error: 'answer_key_not_found' });
    }
    const keys = keyDoc.data();

    const { scores, analytics, perSubject } = scoreSubmission(answers, keys);

    let expectedRank = null;
    const rankDoc = await db
      .collection('exams').doc(examId)
      .collection('rankTable').doc('data')
      .get();
    if (rankDoc.exists) {
      expectedRank = predictRank(scores.total, rankDoc.data().rows || []);
    }

    const payload = {
      userId: uid,
      examId,
      set,
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
