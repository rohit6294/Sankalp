const express = require('express');
const { db } = require('../firebase');
const { verifyToken } = require('../auth');

const router = express.Router();

router.get('/', verifyToken, async (_req, res) => {
  try {
    const snap = await db.collection('exams').where('active', '==', true).get();
    const exams = snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
    res.json({ exams });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

module.exports = router;
