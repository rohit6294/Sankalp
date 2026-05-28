const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken } = require('../auth');
const { COUNTS, START, END, categoryFor } = require('../categories');
const { getExamReadiness } = require('../exam-readiness');

const router = express.Router();

const VALID_PAPERS = new Set(['math', 'physChem']);
const VALID_SETS = new Set(['A', 'B', 'C', 'D']);
const VALID_RANK_TYPES = new Set(['engineering', 'bpharma']);
const VALID_OPTIONS = new Set(['A', 'B', 'C', 'D']);

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

function validationError(error, message) {
  const err = new Error(message || error);
  err.status = 400;
  err.error = error;
  return err;
}

function normalizeAnswerKeySubject(subject, value) {
  const source = ensurePlainObject(value);
  const cleaned = {};
  const start = START[subject];
  const end = END[subject];

  for (const qNoStr of Object.keys(source)) {
    if (!/^\d+$/.test(qNoStr)) {
      throw validationError('invalid_question_number', `${subject} question numbers must be numeric`);
    }

    const qNo = Number(qNoStr);
    if (!Number.isInteger(qNo) || qNo < start || qNo > end) {
      throw validationError('invalid_question_number', `${subject} question ${qNoStr} is out of range`);
    }

    const raw = source[qNoStr];
    if (raw === null || raw === undefined || raw === '') continue;
    const category = categoryFor(subject, qNo);
    const rawValue = String(raw).trim().toUpperCase();

    const options = category === 3 && /^[A-D]{2,4}$/.test(rawValue)
      ? rawValue.split('')
      : rawValue.split(',').map((option) => option.trim()).filter(Boolean);
    const uniqueOptions = Array.from(new Set(options)).sort();

    if (!uniqueOptions.length) continue;
    if (uniqueOptions.some((option) => !VALID_OPTIONS.has(option))) {
      throw validationError('invalid_answer_option', `${subject} question ${qNo} must use only A, B, C, or D`);
    }

    if (category !== 3 && uniqueOptions.length !== 1) {
      throw validationError('invalid_single_answer', `${subject} question ${qNo} accepts exactly one option`);
    }

    cleaned[String(qNo)] = category === 3 ? uniqueOptions.join(',') : uniqueOptions[0];
  }

  return cleaned;
}

function validateAnswerKeyPayload(paper, payload) {
  const data = ensurePlainObject(payload);
  if (paper === 'math') {
    return { math: normalizeAnswerKeySubject('math', data.math) };
  }
  return {
    physics: normalizeAnswerKeySubject('physics', data.physics),
    chemistry: normalizeAnswerKeySubject('chemistry', data.chemistry),
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
    if (![marksMin, marksMax, rankMin, rankMax].every(Number.isFinite)) return null;
    if (marksMin > marksMax || rankMin > rankMax) return null;
    if (rankMin < 1 || rankMax < 1) return null;
    cleaned.push({ marksMin, marksMax, rankMin, rankMax });
  }
  return cleaned.sort((a, b) => a.marksMin - b.marksMin);
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
          ready: data.ready === true,
          readinessProblems: Array.isArray(data.readinessProblems) ? data.readinessProblems : [],
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
      active: false,
      ready: false,
      readinessProblems: ['Answer keys are not complete yet'],
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
    const examRef = db.collection('exams').doc(req.params.examId);
    if (updates.active === true) {
      const readiness = await getExamReadiness(examRef);
      updates.ready = readiness.ready;
      updates.readinessProblems = readiness.problems;
      if (!readiness.ready) {
        return res.status(400).json({
          error: 'exam_not_ready',
          message: `Complete all answer keys before activating: ${readiness.problems.slice(0, 3).join('; ')}`,
          problems: readiness.problems,
        });
      }
    }
    await examRef.set(updates, { merge: true });
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
    const examRef = db.collection('exams').doc(examId);
    const readiness = await getExamReadiness(examRef);
    const examUpdates = {
      ready: readiness.ready,
      readinessProblems: readiness.problems,
    };
    if (!readiness.ready) examUpdates.active = false;
    await examRef.set(examUpdates, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    if (e.status === 400) {
      return res.status(400).json({ error: e.error || 'invalid_answer_key', message: e.message });
    }
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

// Get all student submissions with joined user profile details
router.get('/submissions', async (req, res) => {
  const { examId } = req.query;
  try {
    let query = db.collection('submissions');
    if (examId) {
      query = query.where('examId', '==', examId);
    }
    const subSnap = await query.get();
    const submissions = [];
    subSnap.forEach((doc) => {
      const data = doc.data() || {};
      submissions.push({
        id: doc.id,
        ...data,
        submittedAt: normalizeTimestamp(data.submittedAt),
      });
    });

    const userSnap = await db.collection('users').get();
    const usersMap = {};
    userSnap.forEach((doc) => {
      const data = doc.data() || {};
      const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
      usersMap[doc.id] = {
        name: fullName,
        email: data.email || '—',
        phone: data.phone || '—',
        gender: data.gender || '—',
        caste: data.caste || '—',
        tfw: data.tfw || '—',
        wbjeeYear: data.wbjeeYear || '—',
      };
    });

    const reqSnap = await db.collection('resetRequests').where('status', '==', 'pending').get();
    const pendingResets = {};
    reqSnap.forEach(doc => {
      pendingResets[doc.id] = doc.data();
    });

    const joined = submissions.map((sub) => {
      const user = usersMap[sub.userId] || {
        name: 'Unknown Student',
        email: sub.userId || '—',
        phone: '—',
        gender: '—',
        caste: '—',
        tfw: '—',
        wbjeeYear: '—'
      };
      return {
        ...sub,
        studentName: user.name,
        studentEmail: user.email,
        studentPhone: user.phone,
        studentGender: user.gender,
        studentCaste: user.caste,
        studentTFW: user.tfw,
        studentYear: user.wbjeeYear,
        resetRequested: !!pendingResets[sub.id],
        resetReason: pendingResets[sub.id] ? pendingResets[sub.id].reason : null,
      };
    });

    res.json({ submissions: joined });
  } catch (e) {
    res.status(500).json({ error: 'submissions_load_failed', message: e.message });
  }
});

// Delete a submission (Reset attempt)
router.delete('/submissions/:subId', async (req, res) => {
  const { subId } = req.params;
  try {
    await db.collection('submissions').doc(subId).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'submission_delete_failed', message: e.message });
  }
});

// Fetch mandatory fields configuration (Admin SDK secure backend route)
router.get('/settings/mandatory-fields', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('mandatory_fields').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update mandatory fields configuration (Admin SDK secure backend route)
router.put('/settings/mandatory-fields', async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    await db.collection('settings').doc('mandatory_fields').set(payload, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// ── Reset Request Management (Admin) ─────────────────────────────────────

// Get all pending reset requests
router.get('/reset-requests', async (_req, res) => {
  try {
    const snap = await db.collection('resetRequests').where('status', '==', 'pending').get();
    const requests = {};
    snap.forEach(doc => {
      const data = doc.data();
      requests[doc.id] = {
        userId: data.userId,
        examId: data.examId,
        reason: data.reason || '',
        status: data.status,
        requestedAt: normalizeTimestamp(data.requestedAt),
      };
    });
    res.json({ requests });
  } catch (e) {
    res.status(500).json({ error: 'reset_requests_load_failed', message: e.message });
  }
});

// Approve reset: delete submission + mark request as approved
router.post('/reset-approve/:subId', async (req, res) => {
  const { subId } = req.params;
  try {
    // Delete the submission
    await db.collection('submissions').doc(subId).delete();
    // Mark request as approved
    const reqRef = db.collection('resetRequests').doc(subId);
    const reqDoc = await reqRef.get();
    if (reqDoc.exists) {
      await reqRef.update({ status: 'approved' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reset_approve_failed', message: e.message });
  }
});

// Reject reset request
router.post('/reset-reject/:subId', async (req, res) => {
  const { subId } = req.params;
  try {
    const reqRef = db.collection('resetRequests').doc(subId);
    const reqDoc = await reqRef.get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'request_not_found' });
    await reqRef.update({ status: 'rejected' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reset_reject_failed', message: e.message });
  }
});

module.exports = router;
