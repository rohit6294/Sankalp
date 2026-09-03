const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken, requirePermission, requireAnyPermission } = require('../auth');
const { ADMIN_SECTIONS, hasPermission } = require('../permissions');
const { resolveCollegeType } = require('../college-types');
const { COUNTS, START, END, categoryFor } = require('../categories');
const { getExamReadiness } = require('../exam-readiness');
const { scoreSubmission, round2, applyExamBonus } = require('../scoring/calculate');
const { defaultRankRows, predictRank, formatRankRange } = require('../scoring/ranking');
const multer = require('multer');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const router = express.Router();
const { sendEmail } = require('../mailer');
const { bustSettingsCache } = require('./predictor');
const { validatePredictorSettings } = require('../predictor-settings');
const { backupYearToFirestore } = require('../database-backup');

const upload = multer({ storage: multer.memoryStorage() });

// Users cache and full users mapping function removed to prevent expensive database reads

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

    if (rawValue === 'BONUS') {
      cleaned[String(qNo)] = 'BONUS';
      continue;
    }

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
      return res.json({ ok: true, message: 'no_submissions_to_recalculate', comparison: [] });
    }

    // 4. Collect user names from submissions, fallback to user docs only if missing
    const userNames = {};
    const missingUserDocsUids = [];
    for (const subDoc of subSnap.docs) {
      const sub = subDoc.data() || {};
      if (sub.studentName) {
        userNames[sub.userId] = sub.studentName;
      } else if (sub.userId && !missingUserDocsUids.includes(sub.userId)) {
        missingUserDocsUids.push(sub.userId);
      }
    }
    if (missingUserDocsUids.length > 0) {
      const userDocs = await Promise.all(
        missingUserDocsUids.map(uid => db.collection('users').doc(uid).get())
      );
      userDocs.forEach(uDoc => {
        if (uDoc.exists) {
          const d = uDoc.data() || {};
          userNames[uDoc.id] = d.name || d.displayName || `${d.firstName || ''} ${d.lastName || ''}`.trim() || 'Unknown';
        }
      });
    }

    // 5. Recalculate, track before/after, and batch update
    let batch = db.batch();
    let updatedCount = 0;
    let batchOpCount = 0;
    const comparison = [];

    for (const subDoc of subSnap.docs) {
      const sub = subDoc.data();
      const oldScores = sub.scores || {};
      const oldRank = sub.expectedRank || {};

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

      // Calculate old engineering/bpharma scores if missing (due to the previous bug)
      const oldEngScore = oldScores.engineering ?? oldScores.total ?? null;
      const oldBphScore = oldScores.bpharma ?? (oldScores.physics !== undefined && oldScores.chemistry !== undefined ? round2(oldScores.physics + oldScores.chemistry) : null);

      const oldEngPredictedRank = oldRank.engineering || (oldEngScore !== null ? predictRank(oldEngScore, engineeringRows) : null);
      const oldBphPredictedRank = oldRank.bpharma || (oldBphScore !== null ? predictRank(oldBphScore, bpharmaRows) : null);

      const formatRank = (val) => {
        if (!val) return '—';
        if (typeof val === 'object') return formatRankRange(val) || '—';
        return String(val);
      };

      // Build comparison entry for admin
      comparison.push({
        studentName: userNames[sub.userId] || 'Unknown',
        userId: sub.userId || '',
        oldEngineering: oldEngScore,
        newEngineering: computedScores.engineering ?? null,
        oldBpharma: oldBphScore,
        newBpharma: computedScores.bpharma ?? null,
        oldEngRank: formatRank(oldEngPredictedRank),
        newEngRank: formatRank(expectedRank.engineering),
        oldBphRank: formatRank(oldBphPredictedRank),
        newBphRank: formatRank(expectedRank.bpharma),
      });

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

    // 6. Clear the needsRecalculation flag
    await examRef.set({ needsRecalculation: false }, { merge: true });

    // 7. Bust stats cache and local rank caches so ranks are recalculated with new scores
    try {
      await db.collection('exams').doc(examId).collection('stats').doc('scores').delete();
      const rankRouter = require('./rank');
      if (rankRouter && typeof rankRouter.bustExamTotalsCache === 'function') {
        rankRouter.bustExamTotalsCache(examId);
      }
    } catch (cacheErr) {
      console.error('[Recalculate] Failed to bust stats cache:', cacheErr);
    }

    // Sort comparison by name
    comparison.sort((a, b) => a.studentName.localeCompare(b.studentName));

    res.json({ ok: true, recalculated: updatedCount, bonus, comparison });
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
    const rankTablesCache = {};
    const getRankRows = async (eId, type) => {
      const cacheKey = `${eId}_${type}`;
      if (rankTablesCache[cacheKey]) return rankTablesCache[cacheKey];
      let rows = defaultRankRows(type);
      try {
        const doc = await db.collection('exams').doc(eId).collection('rankTable').doc(type).get();
        if (doc.exists && doc.data().rows) {
          rows = doc.data().rows;
        }
      } catch (e) {
        // Fallback to defaults on error
      }
      rankTablesCache[cacheKey] = rows;
      return rows;
    };

    for (const doc of subSnap.docs) {
      const data = doc.data() || {};
      const s = data.scores || {};
      
      if (s.engineering === undefined || s.bpharma === undefined || !data.expectedRank || data.expectedRank.engineering === null) {
        const engScore = s.engineering ?? s.total ?? 0;
        const bphScore = s.bpharma ?? (s.physics !== undefined && s.chemistry !== undefined ? round2(s.physics + s.chemistry) : 0);
        
        const engRows = await getRankRows(data.examId, 'engineering');
        const bphRows = await getRankRows(data.examId, 'bpharma');
        
        data.scores = {
          ...s,
          engineering: engScore,
          bpharma: bphScore,
          bonus: s.bonus ?? 0,
        };
        
        data.expectedRank = {
          engineering: (data.expectedRank?.engineering) || predictRank(engScore, engRows),
          bpharma: (data.expectedRank?.bpharma) || predictRank(bphScore, bphRows),
        };
      }
      
      submissions.push({
        id: doc.id,
        ...data,
        submittedAt: normalizeTimestamp(data.submittedAt),
      });
    }

    const reqSnap = await db.collection('resetRequests').where('status', '==', 'pending').get();
    const pendingResets = {};
    reqSnap.forEach(doc => {
      pendingResets[doc.id] = doc.data();
    });

    const joined = [];
    for (const sub of submissions) {
      let studentName = sub.studentName;
      let studentEmail = sub.studentEmail;
      let studentPhone = sub.studentPhone;
      let studentGender = sub.studentGender;
      let studentCaste = sub.studentCaste;
      let studentTFW = sub.studentTFW;
      let studentYear = sub.studentYear;

      // Lazy migration / fallback
      if (!studentName && sub.userId) {
        try {
          const userDoc = await db.collection('users').doc(sub.userId).get();
          if (userDoc.exists) {
            const uData = userDoc.data() || {};
            studentName = uData.name || uData.displayName || `${uData.firstName || ''} ${uData.lastName || ''}`.trim() || 'Unknown Student';
            studentEmail = uData.email || '—';
            studentPhone = uData.phone || '—';
            studentGender = uData.gender || '—';
            studentCaste = uData.caste || '—';
            studentTFW = uData.tfw || '—';
            studentYear = uData.wbjeeYear || '—';

            // Asynchronously save back to Firestore to permanently migrate
            db.collection('submissions').doc(sub.id).update({
              studentName,
              studentEmail,
              studentPhone,
              studentGender,
              studentCaste,
              studentTFW,
              studentYear,
            }).catch(e => console.error(`Lazy migration failed for submission ${sub.id}:`, e));
          }
        } catch (err) {
          console.error(`Error fetching fallback user for submission ${sub.id}:`, err);
        }
      }

      joined.push({
        ...sub,
        studentName: studentName || 'Unknown Student',
        studentEmail: studentEmail || '—',
        studentPhone: studentPhone || '—',
        studentGender: studentGender || '—',
        studentCaste: studentCaste || '—',
        studentTFW: studentTFW || '—',
        studentYear: studentYear || '—',
        resetRequested: !!pendingResets[sub.id],
        resetReason: pendingResets[sub.id] ? pendingResets[sub.id].reason : null,
      });
    }

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
router.get('/predictor/settings', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update college predictor settings
router.put('/predictor/settings', requireAnyPermission([['collegePredictor', 'edit'], ['evaluators', 'edit']]), async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    const existing = doc.exists ? doc.data() : {};

    const profile = req.adminProfile;
    const canEditPredictor = profile.isSuperAdmin || hasPermission(profile.permissions, 'collegePredictor', 'edit');
    const canEditCf = profile.isSuperAdmin || hasPermission(profile.permissions, 'evaluators', 'edit');

    const update = {};

    if (canEditPredictor) {
      if (payload.enabled !== undefined) update.enabled = payload.enabled === true;
      if (payload.requiresPayment !== undefined) update.requiresPayment = payload.requiresPayment === true;
      if (payload.price !== undefined) {
        const price = Number(payload.price);
        if (Number.isFinite(price) && price >= 1) {
          update.price = price;
        }
      }
    } else {
      // Preserve existing predictor settings
      if (existing.enabled !== undefined) update.enabled = existing.enabled;
      if (existing.requiresPayment !== undefined) update.requiresPayment = existing.requiresPayment;
      if (existing.price !== undefined) update.price = existing.price;
    }

    if (canEditCf) {
      if (payload.choiceFillingEnabled !== undefined) update.choiceFillingEnabled = payload.choiceFillingEnabled === true;
      if (payload.choiceFillingRequiresPayment !== undefined) update.choiceFillingRequiresPayment = payload.choiceFillingRequiresPayment === true;
      if (payload.choiceFillingPrice !== undefined) {
        const cfPrice = Number(payload.choiceFillingPrice);
        if (Number.isFinite(cfPrice) && cfPrice >= 1) {
          update.choiceFillingPrice = cfPrice;
        }
      }
      if (payload.choiceFillingMaxAttempts !== undefined) {
        const cfMaxAttempts = Number(payload.choiceFillingMaxAttempts);
        if (Number.isFinite(cfMaxAttempts) && cfMaxAttempts >= 1) {
          update.choiceFillingMaxAttempts = cfMaxAttempts;
        }
      }
      if (payload.choiceFillingTiers !== undefined) {
        update.choiceFillingTiers = payload.choiceFillingTiers;
      }
    } else {
      // Preserve existing choice filling settings
      if (existing.choiceFillingEnabled !== undefined) update.choiceFillingEnabled = existing.choiceFillingEnabled;
      if (existing.choiceFillingRequiresPayment !== undefined) update.choiceFillingRequiresPayment = existing.choiceFillingRequiresPayment;
      if (existing.choiceFillingPrice !== undefined) update.choiceFillingPrice = existing.choiceFillingPrice;
      if (existing.choiceFillingMaxAttempts !== undefined) update.choiceFillingMaxAttempts = existing.choiceFillingMaxAttempts;
    }

    // Now validate the merged settings to ensure the final object is 100% valid
    const merged = { ...existing, ...update };
    const { error, message, settings } = validatePredictorSettings(merged);
    if (error) {
      return res.status(400).json({ error, message });
    }

    await db.collection('settings').doc('college_predictor').set(settings);
    
    // Clear the in-memory predictor settings cache so student requests see the update immediately
    bustSettingsCache();

    res.json({ ok: true, settings, message: 'Settings saved successfully.' });
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

    // 2. Dynamically generate target WBJEE years list instead of scanning the entire users collection
    const currentYear = new Date().getFullYear();
    const years = [
      String(currentYear - 1),
      String(currentYear),
      String(currentYear + 1),
      String(currentYear + 2),
      String(currentYear + 3),
    ];

    res.json({ ok: true, series, years });
  } catch (err) {
    res.status(500).json({ error: 'meta_failed', message: err.message });
  }
});

// Broadcast announcement via email
router.post('/broadcast-announcement', requirePermission('announcements', 'edit'), async (req, res) => {
  const { title, message, targetType, targetValue, targetRules } = req.body || {};
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
        const userIdsArray = Array.from(userIds);
        const chunks = [];
        for (let i = 0; i < userIdsArray.length; i += 30) {
          chunks.push(userIdsArray.slice(i, i + 30));
        }

        const userSnaps = await Promise.all(
          chunks.map(chunk =>
            db.collection('users')
              .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
              .get()
          )
        );

        userSnaps.forEach(userSnap => {
          userSnap.forEach(doc => {
            const data = doc.data() || {};
            if (data.email) emails.push(data.email.trim());
          });
        });
      }
    } else if (targetType === 'segment') {
      if (!targetValue) return res.status(400).json({ error: 'missing_target_value', message: 'Target audience segment selection is required.' });
      const segDoc = await db.collection('studentSegments').doc(String(targetValue).trim()).get();
      if (!segDoc.exists) return res.status(404).json({ error: 'segment_not_found', message: 'Selected audience segment doc does not exist.' });
      const { evaluateSegmentRules } = require('../segment-engine');
      const evalRes = await evaluateSegmentRules(segDoc.data().rules || {});
      emails = evalRes.recipientEmails || [];
    } else if (targetType === 'custom_rules') {
      if (!targetRules) return res.status(400).json({ error: 'missing_target_rules', message: 'Rule condition tree is required for custom broadcast.' });
      const { evaluateSegmentRules } = require('../segment-engine');
      const evalRes = await evaluateSegmentRules(targetRules);
      emails = evalRes.recipientEmails || [];
    } else {
      return res.status(400).json({ error: 'invalid_target_type', message: 'Invalid target type specified.' });
    }

    // Deduplicate emails
    emails = Array.from(new Set(emails)).filter(Boolean);

    if (emails.length === 0) {
      return res.json({ ok: true, recipientCount: 0 });
    }

    // Trigger sending process in the background using parallel batching (chunks of 15)
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

      const chunkSize = 15;
      for (let i = 0; i < emails.length; i += chunkSize) {
        const chunk = emails.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (email) => {
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
        }));
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
  const year = String(req.body.year || '').trim();
  const yearMatch = year.match(/^(\d{4})\b/);
  if (!yearMatch) {
    return res.status(400).json({ error: 'invalid_year', message: 'Please specify a valid academic year starting with a 4-digit year (e.g. 2024, 2024 Mop Up).' });
  }
  const yearNum = parseInt(yearMatch[1], 10);
  if (yearNum < 2000 || yearNum > 2100) {
    return res.status(400).json({ error: 'invalid_year', message: 'The academic year must be between 2000 and 2100.' });
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

        // Back up to Firestore for persistence across deployments
        backupYearToFirestore(year, cleanedRecords).catch(console.error);

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
router.get('/predictor/status', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000); // 10 seconds busy timeout to avoid SQLITE_BUSY


    const stats = {};

    sqliteDb.all('SELECT year, COUNT(*) as count, COUNT(DISTINCT institute) as colleges FROM cutoffs GROUP BY year', [], (err, rows) => {
      if (err) {
        sqliteDb.close();
        return res.status(500).json({ error: 'status_failed', message: err.message });
      }

      if (rows) {
        rows.forEach(r => {
          stats[r.year] = {
            records: r.count,
            colleges: r.colleges
          };
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


    sqliteDb.run('DELETE FROM cutoffs', [], async (err) => {
      sqliteDb.close();
      if (err) {
        return res.status(500).json({ error: 'clear_failed', message: err.message });
      }

      // Clear Firestore backups too for persistence consistency
      try {
        const snapshot = await db.collection('cutoffBackups').get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log('Firestore backups cleared successfully.');
      } catch (backupErr) {
        console.error('Failed to clear Firestore backups:', backupErr);
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
router.get('/predictor/categories', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
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
router.get('/predictor/seat-types', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
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
router.get('/predictor/quotas', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
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

// ── Get Unique Colleges for Explorer ───────────────────────────────────────────
router.get('/predictor/colleges', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  sqliteDb.all('SELECT DISTINCT institute FROM cutoffs ORDER BY institute ASC', [], (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'colleges_load_failed', message: err.message });
    }
    const colleges = rows.map(r => r.institute).filter(Boolean);
    res.json({ colleges });
  });
});

// ── Get Unique Branches for Explorer ───────────────────────────────────────────
router.get('/predictor/branches', requireAnyPermission([['collegePredictor', 'view'], ['evaluators', 'view']]), async (req, res) => {
  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  sqliteDb.all('SELECT DISTINCT program FROM cutoffs ORDER BY program ASC', [], (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'branches_load_failed', message: err.message });
    }
    const branches = rows.map(r => r.program).filter(Boolean);
    res.json({ branches });
  });
});

// ── Get Complete Historical Cutoffs for Explorer ───────────────────────────────
router.get('/predictor/explorer-cutoffs', requirePermission('collegePredictor', 'view'), async (req, res) => {
  const { college, branch } = req.query;
  if (!college) {
    return res.status(400).json({ error: 'missing_college', message: 'Please specify a college name.' });
  }

  const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
  const sqliteDb = new sqlite3.Database(dbPath);
  sqliteDb.configure("busyTimeout", 10000);

  let sql = `
    SELECT program, stream, category, seat_type, quota, year, round, closing_rank
    FROM cutoffs
    WHERE institute = ?
  `;
  const params = [college];

  if (branch && branch !== 'All' && branch.trim() !== '') {
    sql += ' AND program = ?';
    params.push(branch);
  }

  sql += ' ORDER BY program ASC, category ASC, year DESC, round ASC';

  sqliteDb.all(sql, params, (err, rows) => {
    sqliteDb.close();
    if (err) {
      return res.status(500).json({ error: 'explorer_cutoffs_failed', message: err.message });
    }
    res.json({ cutoffs: rows });
  });
});

// ── Admin Prediction Query Route ──────────────────────────────────────────────
router.get('/predictor/predict', requirePermission('collegePredictor', 'view'), async (req, res) => {
  try {
    const { rank, category, courseType, collegeType, seatType, quota, year, collegeName } = req.query;
    let targetYear = year ? String(year).trim() : '2025';
    const yearMatch = targetYear.match(/^(\d{4})\b/);
    let parsedYear = 2025;
    if (yearMatch) {
      parsedYear = parseInt(yearMatch[1], 10);
    } else {
      targetYear = '2025';
    }
    const prevYear = parsedYear - 1;
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
      SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
      FROM cutoffs
      WHERE category = ?
    `, [category], (err, rows) => {
      sqliteDb.close();
      if (err) {
        return res.status(500).json({ error: 'prediction_failed', message: err.message });
      }

      const grouped = {};
      rows.forEach(row => {
        const key = `${row.institute}|${row.program}|${row.seat_type}|${row.quota}`;
        if (!grouped[key]) {
          grouped[key] = {
            institute: row.institute,
            program: row.program,
            stream: row.stream,
            college_type: row.college_type,
            seat_type: row.seat_type,
            quota: row.quota,
            cutoffs: {},
            rounds: {}
          };
        }
        
        const currentCutoff = row.closing_rank;
        const currentRound = row.round || 0;
        const existingRound = grouped[key].rounds[row.year] || 0;
        
        if (grouped[key].cutoffs[row.year] === undefined || 
            (currentRound === 2 && existingRound !== 2) || 
            (currentRound > existingRound && existingRound !== 2)) {
          grouped[key].cutoffs[row.year] = currentCutoff;
          grouped[key].rounds[row.year] = currentRound;
        }
      });

      const results = [];
      let totalMatches = 0;
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;

      Object.keys(grouped).forEach(key => {
        const item = grouped[key];
        const target_cutoff = item.cutoffs[targetYear];
        const prev_cutoff = item.cutoffs[prevYear];

        if (!target_cutoff) return;

        // College Name Filter: Case-insensitive partial match (admin only)
        if (collegeName && String(collegeName).trim() !== '') {
          const searchStr = String(collegeName).toLowerCase();
          if (!String(item.institute).toLowerCase().includes(searchStr)) return;
        }

        // Apply filters
        // Course Type: B.Tech, B.Pharm, All
        if (courseType && courseType !== 'All') {
          const isPharm = String(item.stream).toLowerCase().includes('pharma') || String(item.program).toLowerCase().includes('pharma');
          if (courseType === 'B.Pharm' && !isPharm) return;
          if (courseType === 'B.Tech' && isPharm) return;
        }

        // College Type Filters: GovtGroup, PrivateGroup, specific types, All
        if (collegeType && collegeType !== 'All') {
          const isGovtType = [
            'University/University Department',
            'State Government Engineering College',
            'State Government Pharmacy College',
            'Central Government Engineering College'
          ].includes(item.college_type);
          
          const isPrivateType = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(item.college_type);
          
          if (collegeType === 'GovtGroup' && !isGovtType) return;
          else if (collegeType === 'PrivateGroup' && !isPrivateType) return;
          else if (collegeType !== 'GovtGroup' && collegeType !== 'PrivateGroup' && item.college_type !== collegeType) return;
        }

        // Seat Type Filter: Specific, or All
        if (seatType && seatType !== 'All') {
          if (item.seat_type !== seatType) return;
        }

        // Quota Filter: Specific, or All
        if (quota && quota !== 'All') {
          if (item.quota !== quota) return;
        }

        // Probability prediction logic:
        let chance = '';
        let chanceSort = 0;
        
        if (R <= target_cutoff) {
          chance = 'High';
          chanceSort = 1;
          highCount++;
        } else if (R <= target_cutoff * 1.10) {
          chance = 'Medium';
          chanceSort = 2;
          mediumCount++;
        } else if (R <= target_cutoff * 1.25) {
          chance = 'Low';
          chanceSort = 3;
          lowCount++;
        } else {
          return; // Exclude if too high
        }

        totalMatches++;

        results.push({
          institute: item.institute,
          program: item.program,
          stream: item.stream,
          collegeType: item.college_type,
          seatType: item.seat_type,
          quota: item.quota,
          selectedYear: targetYear,
          prevYear: prevYear,
          closingRank2025: target_cutoff || '—',
          closingRank2024: prev_cutoff || '—',
          latestCutoff: target_cutoff,
          cutoffs: item.cutoffs,
          chance,
          chanceSort
        });
      });

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
    
    // Fetch all successful purchases
    const purchaseSnap = await db.collection('purchases')
      .where('status', '==', 'success')
      .get();
    
    // Map of userId -> { predictorPurchased: true, choiceFillingPurchased: true, choiceFillingPurchaseInfo: { productId, amount, purchasedAt } }
    const userPurchaseMap = {};
    purchaseSnap.forEach((doc) => {
      const pData = doc.data();
      if (pData && pData.userId) {
        const uid = pData.userId;
        if (!userPurchaseMap[uid]) {
          userPurchaseMap[uid] = {
            predictorPurchased: false,
            choiceFillingPurchased: false,
            choiceFillingPurchaseInfo: null
          };
        }
        if (pData.product === 'college_predictor') {
          userPurchaseMap[uid].predictorPurchased = true;
        } else if (pData.product === 'choice_filling') {
          userPurchaseMap[uid].choiceFillingPurchased = true;
          userPurchaseMap[uid].choiceFillingPurchaseInfo = {
            productId: pData.productId || null,
            amount: pData.amount || null,
            purchasedAt: pData.purchasedAt ? (pData.purchasedAt.toDate ? pData.purchasedAt.toDate().toISOString() : pData.purchasedAt) : null
          };
        }
      }
    });

    const students = [];
    userSnap.forEach((doc) => {
      const data = doc.data() || {};
      const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
      
      const purchaseInfo = userPurchaseMap[doc.id] || {
        predictorPurchased: false,
        choiceFillingPurchased: false,
        choiceFillingPurchaseInfo: null
      };

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
        predictorPurchased: purchaseInfo.predictorPurchased,
        choiceFillingUnlocked: data.choiceFillingUnlocked === true,
        choiceFillingUnlimited: data.choiceFillingUnlimited === true,
        choiceFillingAttemptsLeft: data.choiceFillingAttemptsLeft !== undefined ? Number(data.choiceFillingAttemptsLeft) : null,
        choiceFillingPurchased: purchaseInfo.choiceFillingPurchased,
        choiceFillingPurchaseInfo: purchaseInfo.choiceFillingPurchaseInfo,
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

router.patch(
  '/students/:userId/choice-filling-access',
  requirePermission('students', 'edit'),
  requirePermission('evaluators', 'edit'),
  async (req, res) => {
    try {
      const userId = String(req.params.userId || '').trim();
      const unlocked = req.body?.unlocked === true;
      const attempts = req.body?.attempts !== undefined ? Number(req.body.attempts) : 30;

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
          message: 'Choice Filling access can only be toggled for student accounts.',
        });
      }

      const update = {
        choiceFillingUnlocked: unlocked,
        choiceFillingUnlockedUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        choiceFillingUnlockedUpdatedBy: req.user.email || req.user.uid || 'admin',
      };

      if (unlocked) {
        update.choiceFillingUnlockedAt = admin.firestore.FieldValue.serverTimestamp();
        if (attempts === -1) {
          update.choiceFillingUnlimited = true;
          update.choiceFillingAttemptsLeft = -1;
        } else {
          update.choiceFillingUnlimited = false;
          update.choiceFillingAttemptsLeft = attempts;
        }
      } else {
        update.choiceFillingUnlockedAt = admin.firestore.FieldValue.delete();
        update.choiceFillingUnlimited = false;
        update.choiceFillingAttemptsLeft = 0;
      }

      await userRef.update(update);
      res.json({
        ok: true,
        userId,
        choiceFillingUnlocked: unlocked,
        choiceFillingUnlimited: update.choiceFillingUnlimited,
        choiceFillingAttemptsLeft: update.choiceFillingAttemptsLeft
      });
    } catch (err) {
      console.error('Failed to update choice filling access:', err);
      res.status(500).json({ error: 'choice_filling_access_update_failed', message: err.message });
    }
  }
);

module.exports = router;



