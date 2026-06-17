const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken, requirePermission } = require('../auth');
const { ADMIN_SECTIONS } = require('../permissions');
const { resolveCollegeType } = require('../college-types');
const { COUNTS, START, END, categoryFor } = require('../categories');
const { getExamReadiness } = require('../exam-readiness');
const { scoreSubmission, round2, applyExamBonus } = require('../scoring/calculate');
const { defaultRankRows, predictRank } = require('../scoring/ranking');
const multer = require('multer');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const router = express.Router();
const { sendEmail } = require('../mailer');
const { bustSettingsCache } = require('./predictor');

const upload = multer({ storage: multer.memoryStorage() });

let _usersCache = null;
let _usersCacheAt = 0;
const USERS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

async function getCachedUsersMap() {
  const now = Date.now();
  if (_usersCache && (now - _usersCacheAt) < USERS_CACHE_TTL_MS) {
    return _usersCache;
  }

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

  _usersCache = usersMap;
  _usersCacheAt = now;
  return _usersCache;
}

const VALID_PAPERS = new Set(['math', 'physChem']);
const VALID_SETS = new Set(['A', 'B', 'C', 'D']);
const VALID_RANK_TYPES = new Set(['engineering', 'bpharma']);
const VALID_OPTIONS = new Set(['A', 'B', 'C', 'D']);

router.use(verifyToken, requireAdmin);

router.get('/me', (req, res) => {
  res.json({
    admin: req.adminProfile,
    sections: ADMIN_SECTIONS,
  });
});

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

router.get('/exams', requirePermission('evaluators', 'view'), async (_req, res) => {
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
          bonus: Number.isFinite(data.bonus) ? Number(data.bonus) : 0,
          needsRecalculation: data.needsRecalculation === true,
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

router.post('/exams', requirePermission('evaluators', 'edit'), async (req, res) => {
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

router.patch('/exams/:examId', requirePermission('evaluators', 'edit'), async (req, res) => {
  const updates = {};
  if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
  if (typeof req.body?.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim();
  if (req.body?.bonus !== undefined) {
    const bonus = Number(req.body.bonus);
    if (!Number.isFinite(bonus) || bonus < 0) {
      return res.status(400).json({ error: 'invalid_bonus', message: 'Bonus marks must be a non-negative number' });
    }
    updates.bonus = round2(bonus);
    updates.needsRecalculation = true;
  }
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

router.get('/exams/:examId/answer-keys/:paper/:setId', requirePermission('evaluators', 'view'), async (req, res) => {
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

router.put('/exams/:examId/answer-keys/:paper/:setId', requirePermission('evaluators', 'edit'), async (req, res) => {
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
      needsRecalculation: true,
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

router.get('/exams/:examId/rank-table/:type', requirePermission('evaluators', 'view'), async (req, res) => {
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

router.put('/exams/:examId/rank-table/:type', requirePermission('evaluators', 'edit'), async (req, res) => {
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
      
    await db.collection('exams').doc(examId).set({ needsRecalculation: true }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'rank_table_save_failed', message: e.message });
  }
});

// Recalculate all submissions for an exam
router.post('/exams/:examId/recalculate', requirePermission('evaluators', 'edit'), async (req, res) => {
  const { examId } = req.params;

  try {
    const examRef = db.collection('exams').doc(examId);
    const examDoc = await examRef.get();
    if (!examDoc.exists) return res.status(404).json({ error: 'exam_not_found' });
    const bonus = Number(examDoc.data().bonus) || 0;

    // 1. Fetch all answer keys
    const keysSnap = await examRef.collection('answerKeys').get();
    const loadedKeys = {};
    keysSnap.forEach(doc => { loadedKeys[doc.id] = doc.data(); });

    // 2. Fetch rank tables
    const engRankDoc = await examRef.collection('rankTable').doc('engineering').get();
    const bphRankDoc = await examRef.collection('rankTable').doc('bpharma').get();
    const engineeringRows = engRankDoc.exists ? (engRankDoc.data().rows || []) : defaultRankRows('engineering');
    const bpharmaRows = bphRankDoc.exists ? (bphRankDoc.data().rows || []) : defaultRankRows('bpharma');

    // 3. Fetch all submissions
    const subSnap = await db.collection('submissions').where('examId', '==', examId).get();
    if (subSnap.empty) {
      await examRef.set({ needsRecalculation: false }, { merge: true });
      return res.json({ ok: true, message: 'no_submissions_to_recalculate' });
    }

    // 4. Recalculate and batch update
    let batch = db.batch();
    let updatedCount = 0;
    let batchOpCount = 0;

    for (const subDoc of subSnap.docs) {
      const sub = subDoc.data();
      const mathData = loadedKeys[`math_${sub.mathSet}`] || {};
      const physChemData = loadedKeys[`physChem_${sub.physChemSet}`] || {};

      const keys = {
        math: mathData.math || {},
        physics: physChemData.physics || {},
        chemistry: physChemData.chemistry || {},
      };

      const { scores, analytics, perSubject } = scoreSubmission(sub.answers || {}, keys);
      const computedScores = applyExamBonus(scores, bonus);

      const expectedRank = {
        engineering: predictRank(computedScores.engineering, engineeringRows),
        bpharma: predictRank(computedScores.bpharma, bpharmaRows),
      };

      batch.update(subDoc.ref, {
        scores: computedScores,
        analytics,
        perSubject,
        expectedRank,
      });
      updatedCount++;
      batchOpCount++;

      // Firestore batches hold up to 500 operations. Commit and start a fresh batch when needed.
      if (batchOpCount >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOpCount = 0;
      }
    }

    if (batchOpCount > 0) {
      await batch.commit();
    }

    // 5. Clear the needsRecalculation flag
    await examRef.set({ needsRecalculation: false }, { merge: true });

    res.json({ ok: true, recalculated: updatedCount });
  } catch (e) {
    res.status(500).json({ error: 'recalculation_failed', message: e.message });
  }
});

// Get all student submissions with joined user profile details
router.get('/submissions', requirePermission('evaluators', 'view'), async (req, res) => {
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

    const baseUsersMap = await getCachedUsersMap();
    const usersMap = { ...baseUsersMap };

    const uncachedUserIds = [...new Set(
      submissions
        .map(sub => sub.userId)
        .filter(uid => uid && !usersMap[uid])
    )];

    if (uncachedUserIds.length > 0) {
      try {
        const userDocs = await Promise.all(
          uncachedUserIds.map(uid => db.collection('users').doc(uid).get())
        );
        userDocs.forEach(singleUserDoc => {
          if (singleUserDoc.exists) {
            const data = singleUserDoc.data() || {};
            const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
            const uid = singleUserDoc.id;
            usersMap[uid] = {
              name: fullName,
              email: data.email || '—',
              phone: data.phone || '—',
              gender: data.gender || '—',
              caste: data.caste || '—',
              tfw: data.tfw || '—',
              wbjeeYear: data.wbjeeYear || '—',
            };
            if (_usersCache) {
              _usersCache[uid] = usersMap[uid];
            }
          }
        });
      } catch (err) {
        console.error('Failed to fetch uncached users in parallel:', err);
      }
    }

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
router.delete('/submissions/:subId', requirePermission('evaluators', 'edit'), async (req, res) => {
  const { subId } = req.params;
  try {
    const subDoc = await db.collection('submissions').doc(subId).get();
    if (subDoc.exists) {
      const data = subDoc.data() || {};
      const score = data.scores?.total ?? data.scores?.engineering ?? 0;
      const examId = data.examId;
      
      await db.collection('submissions').doc(subId).delete();
      
      try {
        const { removeExamScore } = require('../exam-stats-cache');
        await removeExamScore(examId, score);
      } catch (cacheErr) {
        console.error('Failed to remove score from stats cache on deletion:', cacheErr);
      }
    } else {
      await db.collection('submissions').doc(subId).delete();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'submission_delete_failed', message: e.message });
  }
});

// Fetch mandatory fields configuration (Admin SDK secure backend route)
router.get('/settings/mandatory-fields', requirePermission('settings', 'view'), async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('mandatory_fields').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update mandatory fields configuration (Admin SDK secure backend route)
router.put('/settings/mandatory-fields', requirePermission('settings', 'edit'), async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    await db.collection('settings').doc('mandatory_fields').set(payload, { merge: true });
    
    // Clear the in-memory predictor settings cache so admin changes
    // take effect immediately instead of waiting for the 60-second TTL.
    bustSettingsCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// Fetch college predictor settings
router.get('/predictor/settings', requirePermission('collegePredictor', 'view'), async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update college predictor settings
router.put('/predictor/settings', requirePermission('collegePredictor', 'edit'), async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    await db.collection('settings').doc('college_predictor').set(payload, { merge: true });
    
    // Clear the in-memory predictor settings cache so student requests
    // see the update immediately
    bustSettingsCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// Fetch all transactions/purchases
router.get('/payments/purchases', requirePermission('payments', 'transactions'), async (req, res) => {
  try {
    const snap = await db.collection('purchases').orderBy('purchasedAt', 'desc').get();
    const purchases = [];
    snap.forEach(doc => {
      const data = doc.data() || {};
      purchases.push({
        id: doc.id,
        ...data,
        purchasedAt: normalizeTimestamp(data.purchasedAt),
      });
    });
    res.json({ ok: true, purchases });
  } catch (e) {
    res.status(500).json({ error: 'purchases_load_failed', message: e.message });
  }
});

// Fetch email automations configuration
router.get('/settings/email_automations', requirePermission('settings', 'view'), async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('email_automations').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update email automations configuration
router.put('/settings/email_automations', requirePermission('settings', 'edit'), async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    await db.collection('settings').doc('email_automations').set(payload, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// Fetch metadata for announcements filter dropdowns (years and mock test series)
router.get('/announcement-meta', requirePermission('announcements', 'view'), async (req, res) => {
  try {
    // 1. Fetch all mock test series
    const seriesSnap = await db.collection('mockTestSeries').orderBy('title', 'asc').get();
    const series = [];
    seriesSnap.forEach(doc => {
      const data = doc.data();
      series.push({ id: doc.id, title: data.title || doc.id });
    });

    // 2. Fetch all users to collect unique wbjeeYear
    const usersSnap = await db.collection('users').get();
    const yearsSet = new Set();
    usersSnap.forEach(doc => {
      const data = doc.data();
      if (data.wbjeeYear) {
        const yr = String(data.wbjeeYear).trim();
        if (yr && yr !== '—') {
          yearsSet.add(yr);
        }
      }
    });
    const years = Array.from(yearsSet).sort();

    res.json({ ok: true, series, years });
  } catch (err) {
    res.status(500).json({ error: 'meta_failed', message: err.message });
  }
});

// Broadcast announcement via email
router.post('/broadcast-announcement', requirePermission('announcements', 'edit'), async (req, res) => {
  const { title, message, targetType, targetValue } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'missing_fields' });

  try {
    let emails = [];
    
    if (targetType === 'all') {
      const snap = await db.collection('users').get();
      snap.forEach(doc => {
        const data = doc.data();
        if (data.email) emails.push(data.email.trim());
      });
    } else if (targetType === 'year') {
      if (!targetValue) return res.status(400).json({ error: 'missing_target_value', message: 'Target year is required.' });
      const snap = await db.collection('users').where('wbjeeYear', '==', String(targetValue).trim()).get();
      snap.forEach(doc => {
        const data = doc.data();
        if (data.email) emails.push(data.email.trim());
      });
    } else if (targetType === 'series') {
      if (!targetValue) return res.status(400).json({ error: 'missing_target_value', message: 'Mock Test Series selection is required.' });
      const snap = await db.collection('purchases')
        .where('product', '==', 'mock_test_series')
        .where('productId', '==', String(targetValue).trim())
        .where('status', '==', 'success')
        .get();
      
      const userIds = new Set();
      snap.forEach(doc => {
        const pData = doc.data();
        if (pData && pData.userId) userIds.add(pData.userId);
      });

      if (userIds.size > 0) {
        const usersSnap = await db.collection('users').get();
        usersSnap.forEach(doc => {
          if (userIds.has(doc.id)) {
            const data = doc.data();
            if (data.email) emails.push(data.email.trim());
          }
        });
      }
    } else {
      return res.status(400).json({ error: 'invalid_target_type', message: 'Invalid target type specified.' });
    }

    // Deduplicate emails
    emails = Array.from(new Set(emails)).filter(Boolean);

    if (emails.length === 0) {
      return res.json({ ok: true, recipientCount: 0 });
    }

    // Trigger sending process in the background and return immediately to prevent client timeouts
    let sentCount = 0;
    
    const sendBatch = async () => {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
          <h2 style="color: #C94E1F; margin-top: 0;">${title}</h2>
          <div style="white-space: pre-wrap; font-size: 14px;">${message}</div>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 20px 0;">
          <p style="font-size: 12px; color: #777777; margin-bottom: 0;">You received this email because you are a registered student at Sankalp Learning.<br><strong>Sankalp Learning Team</strong></p>
        </div>
      `;

      for (const email of emails) {
        try {
          const resEmail = await sendEmail({
            to: email,
            subject: title,
            text: message,
            html: emailHtml
          });
          if (resEmail.success) {
            sentCount++;
          }
        } catch (err) {
          console.error(`Failed to send broadcast email to ${email}:`, err);
        }
      }
      console.log(`Broadcast completed. Sent ${sentCount}/${emails.length} successfully.`);
    };

    sendBatch();

    res.json({ ok: true, message: `Broadcast started for ${emails.length} students.`, recipientCount: emails.length });
  } catch (e) {
    console.error('Broadcast failed:', e);
    res.status(500).json({ error: 'broadcast_failed', message: e.message });
  }
});

// ── Reset Request Management (Admin) ─────────────────────────────────────

// Get all pending reset requests
router.get('/reset-requests', requirePermission('evaluators', 'view'), async (_req, res) => {
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
router.post('/reset-approve/:subId', requirePermission('evaluators', 'edit'), async (req, res) => {
  const { subId } = req.params;
  try {
    // Fetch submission to get score & examId before deleting
    const subDoc = await db.collection('submissions').doc(subId).get();
    if (subDoc.exists) {
      const data = subDoc.data() || {};
      const score = data.scores?.total ?? data.scores?.engineering ?? 0;
      const examId = data.examId;
      
      await db.collection('submissions').doc(subId).delete();
      
      try {
        const { removeExamScore } = require('../exam-stats-cache');
        await removeExamScore(examId, score);
      } catch (cacheErr) {
        console.error('Failed to remove score from stats cache on reset approval:', cacheErr);
      }
    } else {
      await db.collection('submissions').doc(subId).delete();
    }
    
    // Mark request as approved
    const reqRef = db.collection('resetRequests').doc(subId);
    const reqDoc = await reqRef.get();
    if (reqDoc.exists) {
      await reqRef.update({ status: 'approved' });
      
      // Email notification
      try {
        const settingsDoc = await db.collection('settings').doc('email_automations').get();
        if (settingsDoc.exists && settingsDoc.data().notifyStudentResetDec) {
          const userId = reqDoc.data().userId;
          const userDoc = await db.collection('users').doc(userId).get();
          const userEmail = userDoc.exists ? userDoc.data().email : null;
          
          if (userEmail) {
            sendEmail({
              to: userEmail,
              subject: 'Update on your Reset Request - Sankalp Learning',
              text: `Hello,\n\nYour request to reset your exam submission has been APPROVED.\n\nYou may now log in to the portal and take the exam again.\n\nBest regards,\nSankalp Learning Team`
            }).catch(console.error);
          }
        }
      } catch (err) {
        console.error('Failed to send reset approval email:', err);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reset_approve_failed', message: e.message });
  }
});

// Reject reset request
router.post('/reset-reject/:subId', requirePermission('evaluators', 'edit'), async (req, res) => {
  const { subId } = req.params;
  try {
    const reqRef = db.collection('resetRequests').doc(subId);
    const reqDoc = await reqRef.get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'request_not_found' });
    await reqRef.update({ status: 'rejected' });
    
    // Email notification
    try {
      const settingsDoc = await db.collection('settings').doc('email_automations').get();
      if (settingsDoc.exists && settingsDoc.data().notifyStudentResetDec) {
        const userId = reqDoc.data().userId;
        const userDoc = await db.collection('users').doc(userId).get();
        const userEmail = userDoc.exists ? userDoc.data().email : null;
        
        if (userEmail) {
          sendEmail({
            to: userEmail,
            subject: 'Update on your Reset Request - Sankalp Learning',
            text: `Hello,\n\nUnfortunately, your request to reset your exam submission has been REJECTED by the admin.\n\nIf you have any questions, please contact support.\n\nBest regards,\nSankalp Learning Team`
          }).catch(console.error);
        }
      }
    } catch (err) {
      console.error('Failed to send reset rejection email:', err);
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reset_reject_failed', message: e.message });
  }
});

// ── Test Email Route ──────────────────────────────────────────

router.get('/test-email', requirePermission('settings', 'edit'), async (req, res) => {
  try {
    const result = await sendEmail({
      to: req.user.email || 'rohitgupta6294@gmail.com',
      subject: 'Test Email from Sankalp Backend',
      text: 'If you are receiving this, your SMTP configuration is perfect!'
    });
    
    if (result.success) {
      res.json({ ok: true, message: 'Email sent successfully!' });
    } else {
      res.status(500).json({ error: 'email_failed', message: `SMTP Error: ${result.error}` });
    }
  } catch (err) {
    res.status(500).json({ error: 'email_failed', message: err.message });
  }
});

// ── College Predictor Cutoff Excel Upload (Requires Admin) ─────────────────────
router.post('/predictor/upload', requirePermission('collegePredictor', 'edit'), upload.single('file'), async (req, res) => {
  const year = Number(req.body.year);
  if (!year || isNaN(year)) {
    return res.status(400).json({ error: 'invalid_year', message: 'Please specify a valid academic year.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'missing_file', message: 'Please upload an Excel file.' });
  }

  try {
    // Read the Excel workbook from buffer
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet);

    if (!rawRows || !rawRows.length) {
      return res.status(400).json({ error: 'empty_file', message: 'The uploaded Excel sheet contains no rows.' });
    }

    // Connect to SQLite database
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000); // 10 seconds busy timeout to avoid SQLITE_BUSY


    // Read column mapping by cleaning keys
    const firstRow = rawRows[0];
    const keyMap = {};
    Object.keys(firstRow).forEach(key => {
      const clean = String(key)
        .replace(/_▲▼/g, '')
        .replace(/_Γû▓Γû╝/g, '')
        .trim();
      keyMap[key] = clean;
    });

    const mappedRows = rawRows.map(row => {
      const mapped = {};
      Object.keys(row).forEach(key => {
        mapped[keyMap[key] || key] = row[key];
      });
      return mapped;
    });

    // Helper to find column case-insensitively
    function findValue(row, subStrKeywords, defaultVal = '') {
      const foundKey = Object.keys(row).find(k => {
        const kLower = k.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, '');
        return subStrKeywords.some(kw => kLower.includes(kw.toLowerCase().replace(/\s+/g, '')));
      });
      return foundKey !== undefined ? row[foundKey] : defaultVal;
    }

    const cleanedRecords = [];

    mappedRows.forEach((row) => {
      const institute = String(findValue(row, ['institute', 'college', 'school', 'inst'], '')).trim();
      const program = String(findValue(row, ['program', 'branch', 'course', 'prog'], '')).trim();
      
      if (!institute || !program) return; // skip header or invalid rows

      const category = String(findValue(row, ['category', 'caste', 'reservation'], 'Open')).trim();
      const opening_rank = parseInt(findValue(row, ['opening', 'op'], 0), 10) || 0;
      const closing_rank = parseInt(findValue(row, ['closing', 'cl'], 0), 10) || 0;

      if (closing_rank <= 0) return; // skip rows without a valid closing rank

      // Round (default to 2 if not present)
      let roundVal = findValue(row, ['round', 'phase'], '');
      let roundNum = 2;
      if (roundVal) {
        const match = String(roundVal).match(/\d+/);
        if (match) roundNum = parseInt(match[0], 10);
      }

      // Stream (default to B.E/B.Tech or B.Pharm)
      let stream = String(findValue(row, ['stream', 'degree'], '')).trim();
      if (!stream) {
        const isPharm = program.toLowerCase().includes('pharma') || program.toLowerCase().includes('pharmacy');
        stream = isPharm 
          ? 'B.Pharm' 
          : 'B.E/B.Tech (WBJEE/JEE(Main) Seats)/B.Arch (WBJEE Seats)';
      }

      // Seat Type (default to WBJEE Seats)
      const seat_type = String(findValue(row, ['seat_type', 'seat type', 'type'], 'WBJEE Seats')).trim();

      // Quota (default to Home State)
      const quota = String(findValue(row, ['quota', 'state'], 'Home State')).trim();

      const suppliedCollegeType = String(findValue(row, ['college_type', 'college type', 'institute_type', 'institute type'], '')).trim();
      const college_type = resolveCollegeType(institute, program, suppliedCollegeType);

      cleanedRecords.push({
        year,
        round: roundNum,
        institute,
        program,
        category,
        opening_rank: opening_rank || closing_rank,
        closing_rank,
        stream,
        seat_type,
        quota,
        college_type
      });
    });

    if (!cleanedRecords.length) {
      sqliteDb.close();
      return res.status(400).json({ error: 'no_valid_rows', message: 'No valid WBJEE cutoff records could be extracted from the Excel sheet. Check column headers.' });
    }

    // Perform database operations in a transaction
    sqliteDb.serialize(() => {
      sqliteDb.run('BEGIN TRANSACTION');

      // Delete existing records for the academic year
      const deleteStmt = sqliteDb.prepare('DELETE FROM cutoffs WHERE year = ?');
      deleteStmt.run(year);
      deleteStmt.finalize();

      // Prepare insert statement
      const insertStmt = sqliteDb.prepare(`
        INSERT INTO cutoffs (year, round, institute, program, category, opening_rank, closing_rank, stream, seat_type, quota, college_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      cleanedRecords.forEach(rec => {
        insertStmt.run(
          rec.year,
          rec.round,
          rec.institute,
          rec.program,
          rec.category,
          rec.opening_rank,
          rec.closing_rank,
          rec.stream,
          rec.seat_type,
          rec.quota,
          rec.college_type
        );
      });

      insertStmt.finalize();

      sqliteDb.run('COMMIT', (commitErr) => {
        sqliteDb.close();
        if (commitErr) {
          return res.status(500).json({ error: 'db_commit_failed', message: commitErr.message });
        }

        // Bust settings/predictor caches to reflect changes immediately
        bustSettingsCache();

        res.json({
          ok: true,
          message: `Successfully imported ${cleanedRecords.length} cutoff records for WBJEE ${year} into the SQL database.`
        });
      });
    });

  } catch (err) {
    console.error('Cutoff Excel import failed:', err);
    res.status(500).json({ error: 'import_failed', message: err.message });
  }
});

// ── Get College Predictor Database Status (Requires Admin) ────────────────────
router.get('/predictor/status', requirePermission('collegePredictor', 'view'), async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000); // 10 seconds busy timeout to avoid SQLITE_BUSY


    const stats = {
      2024: { records: 0, colleges: 0 },
      2025: { records: 0, colleges: 0 }
    };

    sqliteDb.all('SELECT year, COUNT(*) as count, COUNT(DISTINCT institute) as colleges FROM cutoffs GROUP BY year', [], (err, rows) => {
      if (err) {
        sqliteDb.close();
        return res.status(500).json({ error: 'status_failed', message: err.message });
      }

      if (rows) {
        rows.forEach(r => {
          if (stats[r.year]) {
            stats[r.year].records = r.count;
            stats[r.year].colleges = r.colleges;
          }
        });
      }

      sqliteDb.get('SELECT COUNT(DISTINCT category) as catCount FROM cutoffs', [], (errCat, catRow) => {
        sqliteDb.close();
        if (errCat) {
          return res.status(500).json({ error: 'status_failed', message: errCat.message });
        }

        res.json({
          stats,
          uniqueCategories: catRow ? catRow.catCount : 0
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'status_failed', message: err.message });
  }
});

// ── Clear College Predictor Database (Requires Admin) ─────────────────────────
router.post('/predictor/clear', requirePermission('collegePredictor', 'edit'), async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000); // 10 seconds busy timeout to avoid SQLITE_BUSY


    sqliteDb.run('DELETE FROM cutoffs', [], (err) => {
      sqliteDb.close();
      if (err) {
        return res.status(500).json({ error: 'clear_failed', message: err.message });
      }

      // Bust settings/predictor caches to reflect changes immediately
      bustSettingsCache();

      res.json({
        ok: true,
        message: 'SQLite database cleared successfully.'
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'clear_failed', message: err.message });
  }
});

// ── Get Unique Caste Categories (Admin Alias) ─────────────────────────────────
router.get('/predictor/categories', requirePermission('collegePredictor', 'view'), async (req, res) => {
  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  sqliteDb.all('SELECT DISTINCT category FROM cutoffs ORDER BY category ASC', [], (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'categories_load_failed', message: err.message });
    }
    const categories = rows.map(r => r.category).filter(Boolean);
    res.json({ categories });
  });
});

// ── Get Unique Seat Types (Admin Alias) ───────────────────────────────────────
router.get('/predictor/seat-types', requirePermission('collegePredictor', 'view'), async (req, res) => {
  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  sqliteDb.all('SELECT DISTINCT seat_type FROM cutoffs ORDER BY seat_type ASC', [], (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'seat_types_load_failed', message: err.message });
    }
    const seatTypes = rows.map(r => r.seat_type).filter(Boolean);
    res.json({ seatTypes });
  });
});

// ── Get Unique Quotas (Admin Alias) ───────────────────────────────────────────
router.get('/predictor/quotas', requirePermission('collegePredictor', 'view'), async (req, res) => {
  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  sqliteDb.all('SELECT DISTINCT quota FROM cutoffs ORDER BY quota ASC', [], (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'quotas_load_failed', message: err.message });
    }
    const quotas = rows.map(r => r.quota).filter(Boolean);
    res.json({ quotas });
  });
});

// ── Admin Prediction Query Route ──────────────────────────────────────────────
router.get('/predictor/predict', requirePermission('collegePredictor', 'view'), async (req, res) => {
  try {
    const { rank, category, courseType, collegeType, seatType, quota } = req.query;
    const R = Number(rank);
    if (isNaN(R) || R <= 0) {
      return res.status(400).json({ error: 'invalid_rank', message: 'Please enter a valid positive rank number.' });
    }
    if (!category) {
      return res.status(400).json({ error: 'missing_category', message: 'Please specify a reservation category.' });
    }

    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000);

    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota,
             COALESCE(MAX(CASE WHEN year = 2025 AND round = 2 THEN closing_rank END),
                      MAX(CASE WHEN year = 2025 AND round = 1 THEN closing_rank END),
                      MAX(CASE WHEN year = 2025 THEN closing_rank END)) AS closing_rank_2025,
             COALESCE(MAX(CASE WHEN year = 2024 AND round = 2 THEN closing_rank END),
                      MAX(CASE WHEN year = 2024 AND round = 1 THEN closing_rank END),
                      MAX(CASE WHEN year = 2024 THEN closing_rank END)) AS closing_rank_2024
      FROM cutoffs
      WHERE category = ?
      GROUP BY institute, program, seat_type, quota
    `, [category], (err, rows) => {
      sqliteDb.close();
      if (err) {
        return res.status(500).json({ error: 'prediction_failed', message: err.message });
      }

      const results = [];
      let totalMatches = 0;
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;

      for (const row of rows) {
        const c2025 = row.closing_rank_2025;
        const c2024 = row.closing_rank_2024;
        const latest_cutoff = c2025 !== null && c2025 !== undefined ? c2025 : c2024;

        if (!latest_cutoff) continue;

        // Apply filters
        // Course Type: B.Tech, B.Pharm, All
        if (courseType && courseType !== 'All') {
          const isPharm = String(row.stream).toLowerCase().includes('pharma') || String(row.program).toLowerCase().includes('pharma');
          if (courseType === 'B.Pharm' && !isPharm) continue;
          if (courseType === 'B.Tech' && isPharm) continue;
        }

        // College Type Filters: GovtGroup, PrivateGroup, specific types, All
        if (collegeType && collegeType !== 'All') {
          const isGovtType = [
            'University/University Department',
            'State Government Engineering College',
            'State Government Pharmacy College',
            'Central Government Engineering College'
          ].includes(row.college_type);
          
          const isPrivateType = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(row.college_type);
          
          if (collegeType === 'GovtGroup' && !isGovtType) continue;
          else if (collegeType === 'PrivateGroup' && !isPrivateType) continue;
          else if (collegeType !== 'GovtGroup' && collegeType !== 'PrivateGroup' && row.college_type !== collegeType) continue;
        }

        // Seat Type Filter: Specific, or All
        if (seatType && seatType !== 'All') {
          if (row.seat_type !== seatType) continue;
        }

        // Quota Filter: Specific, or All
        if (quota && quota !== 'All') {
          if (row.quota !== quota) continue;
        }

        // Probability prediction logic:
        let chance = '';
        let chanceSort = 0;
        
        if (R <= latest_cutoff) {
          chance = 'High';
          chanceSort = 1;
          highCount++;
        } else if (R <= latest_cutoff * 1.10) {
          chance = 'Medium';
          chanceSort = 2;
          mediumCount++;
        } else if (R <= latest_cutoff * 1.25) {
          chance = 'Low';
          chanceSort = 3;
          lowCount++;
        } else {
          continue; // Exclude if too high
        }

        totalMatches++;

        results.push({
          institute: row.institute,
          program: row.program,
          stream: row.stream,
          collegeType: row.college_type,
          seatType: row.seat_type,
          quota: row.quota,
          closingRank2025: c2025 || '—',
          closingRank2024: c2024 || '—',
          latestCutoff: latest_cutoff,
          chance,
          chanceSort
        });
      }

      // Sort purely by latest closing rank ascending (closest rank shows first)
      results.sort((a, b) => a.latestCutoff - b.latestCutoff);

      res.json({
        ok: true,
        stats: {
          totalMatches,
          highCount,
          mediumCount,
          lowCount
        },
        results
      });
    });
  } catch (e) {
    res.status(500).json({ error: 'prediction_failed', message: e.message });
  }
});

// ── Get All Students List (Requires Admin) ────────────────────────────────────
router.get('/students', requirePermission('students', 'view'), async (req, res) => {
  try {
    const userSnap = await db.collection('users').get();
    
    // Fetch successful college predictor purchases
    const purchaseSnap = await db.collection('purchases')
      .where('product', '==', 'college_predictor')
      .where('status', '==', 'success')
      .get();
    
    const purchasedUserIds = new Set();
    purchaseSnap.forEach((doc) => {
      const pData = doc.data();
      if (pData && pData.userId) {
        purchasedUserIds.add(pData.userId);
      }
    });

    const students = [];
    userSnap.forEach((doc) => {
      const data = doc.data() || {};
      const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
      
      students.push({
        id: doc.id,
        name: fullName,
        email: data.email || '—',
        phone: data.phone || '—',
        gender: data.gender || '—',
        caste: data.caste || '—',
        tfw: data.tfw || '—',
        wbjeeYear: data.wbjeeYear || '—',
        homeState: data.homeState || '—',
        role: data.role || 'student',
        status: data.status || 'active',
        predictorUnlocked: data.predictorUnlocked === true,
        predictorPurchased: purchasedUserIds.has(doc.id),
        createdAt: data.createdAt || null
      });
    });

    res.json({ students });
  } catch (err) {
    console.error('Failed to load students:', err);
    res.status(500).json({ error: 'students_load_failed', message: err.message });
  }
});

router.patch(
  '/students/:userId/predictor-access',
  requirePermission('students', 'edit'),
  requirePermission('collegePredictor', 'edit'),
  async (req, res) => {
    try {
      const userId = String(req.params.userId || '').trim();
      const unlocked = req.body?.unlocked === true;

      if (!userId) {
        return res.status(400).json({ error: 'missing_user_id', message: 'Student id is required.' });
      }

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'student_not_found', message: 'Student account was not found.' });
      }

      const data = snap.data() || {};
      if (data.role === 'admin' || data.isSubAdmin === true) {
        return res.status(400).json({
          error: 'not_student_account',
          message: 'Predictor access can only be toggled for student accounts.',
        });
      }

      const update = {
        predictorUnlocked: unlocked,
        predictorUnlockedUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        predictorUnlockedUpdatedBy: req.user.email || req.user.uid || 'admin',
      };

      if (unlocked) {
        update.predictorUnlockedAt = admin.firestore.FieldValue.serverTimestamp();
      } else {
        update.predictorUnlockedAt = admin.firestore.FieldValue.delete();
      }

      await userRef.update(update);
      res.json({ ok: true, userId, predictorUnlocked: unlocked });
    } catch (err) {
      console.error('Failed to update predictor access:', err);
      res.status(500).json({ error: 'predictor_access_update_failed', message: err.message });
    }
  }
);

module.exports = router;



