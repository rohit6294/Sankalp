const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');
const { getExamReadiness } = require('../exam-readiness');

const router = express.Router();

router.get('/', verifyToken, async (_req, res) => {
  try {
    const snap = await db.collection('exams').where('active', '==', true).get();
    const exams = [];
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.ready === true) {
        exams.push({ id: doc.id, name: data.name });
        continue;
      }

      const readiness = await getExamReadiness(doc.ref);
      await doc.ref.set({
        ready: readiness.ready,
        readinessProblems: readiness.problems,
        active: readiness.ready ? true : false,
      }, { merge: true });
      if (readiness.ready) exams.push({ id: doc.id, name: data.name });
    }
    res.json({ exams });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

module.exports = router;
