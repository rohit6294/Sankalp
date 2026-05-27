const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken } = require('../auth');

const router = express.Router();

const VALID_PAPERS = new Set(['math', 'physChem']);
const VALID_SETS = new Set(['A', 'B', 'C', 'D']);
const VALID_RANK_TYPES = new Set(['engineering', 'bpharma']);

router.use(verifyToken, requireAdmin);

function normalizeTimestamp(value) {
  return value && typeof value.toMillis === 'function' ? value.toMillis() : null;
}

function sortExams(exams) {
  return exams.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt - a.createdAt;
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

function ensurePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateAnswerKeyPayload(paper, payload) {
  const data = ensurePlainObject(payload);
  if (paper === 'math') {
    return { math: ensurePlainObject(data.math) };
  }
  return {
    physics: ensurePlainObject(data.physics),
    chemistry: ensurePlainObject(data.chemistry),
  };
}

function validateRankRows(rows) {
  if (!Array.isArray(rows)) return null;
  const cleaned = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return null;
    const marksMin = Number(row.marksMin);
    const marksMax = Number(row.marksMax);
    const rankMin = Number(row.rankMin);
    const rankMax = Number(row.rankMax);
    if ([marksMin, marksMax, rankMin, rankMax].some(Number.isNaN)) return null;
    cleaned.push({ marksMin, marksMax, rankMin, rankMax });
  }
  return cleaned;
}

router.get('/exams', async (_req, res) => {
  try {
    const snap = await db.collection('exams').get();
    const exams = sortExams(
      snap.docs.map((doc) => {
        const data = doc.data() || {};
        return {
          id: doc.id,
          name: data.name || doc.id,
          active: data.active === true,
          createdAt: normalizeTimestamp(data.createdAt),
        };
      }),
    );
    res.json({ exams });
  } catch (e) {
    res.status(500).json({ error: 'admin_exams_failed', message: e.message });
  }
});

router.post('/exams', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!id || !name) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({ error: 'invalid_exam_id' });
  }

  try {
    await db.collection('exams').doc(id).create({
      name,
      active: req.body?.active !== false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message || '')) {
      return res.status(409).json({ error: 'exam_exists' });
    }
    res.status(500).json({ error: 'create_exam_failed', message: e.message });
  }
});

router.patch('/exams/:examId', async (req, res) => {
  const updates = {};
  if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
  if (typeof req.body?.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim();
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_updates' });
  }

  try {
    await db.collection('exams').doc(req.params.examId).set(updates, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'update_exam_failed', message: e.message });
  }
});

router.get('/exams/:examId/answer-keys/:paper/:setId', async (req, res) => {
  const { examId, paper, setId } = req.params;
  if (!VALID_PAPERS.has(paper) || !VALID_SETS.has(setId)) {
    return res.status(400).json({ error: 'invalid_answer_key_ref' });
  }

  try {
    const snap = await db.collection('exams').doc(examId)
      .collection('answerKeys').doc(`${paper}_${setId}`).get();
    const data = snap.exists
      ? snap.data()
      : (paper === 'math' ? { math: {} } : { physics: {}, chemistry: {} });
    res.json({ exists: snap.exists, data });
  } catch (e) {
    res.status(500).json({ error: 'answer_key_load_failed', message: e.message });
  }
});

router.put('/exams/:examId/answer-keys/:paper/:setId', async (req, res) => {
  const { examId, paper, setId } = req.params;
  if (!VALID_PAPERS.has(paper) || !VALID_SETS.has(setId)) {
    return res.status(400).json({ error: 'invalid_answer_key_ref' });
  }

  try {
    const payload = validateAnswerKeyPayload(paper, req.body);
    await db.collection('exams').doc(examId)
      .collection('answerKeys').doc(`${paper}_${setId}`)
      .set(payload, { merge: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'answer_key_save_failed', message: e.message });
  }
});

router.get('/exams/:examId/rank-table/:type', async (req, res) => {
  const { examId, type } = req.params;
  if (!VALID_RANK_TYPES.has(type)) {
    return res.status(400).json({ error: 'invalid_rank_type' });
  }

  try {
    const snap = await db.collection('exams').doc(examId)
      .collection('rankTable').doc(type).get();
    res.json({ rows: snap.exists ? (snap.data().rows || []) : [] });
  } catch (e) {
    res.status(500).json({ error: 'rank_table_load_failed', message: e.message });
  }
});

router.put('/exams/:examId/rank-table/:type', async (req, res) => {
  const { examId, type } = req.params;
  if (!VALID_RANK_TYPES.has(type)) {
    return res.status(400).json({ error: 'invalid_rank_type' });
  }

  const rows = validateRankRows(req.body?.rows);
  if (!rows) {
    return res.status(400).json({ error: 'invalid_rank_rows' });
  }

  try {
    await db.collection('exams').doc(examId)
      .collection('rankTable').doc(type)
      .set({ rows }, { merge: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'rank_table_save_failed', message: e.message });
  }
});

module.exports = router;
