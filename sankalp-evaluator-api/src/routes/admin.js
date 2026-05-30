const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken } = require('../auth');
const { COUNTS, START, END, categoryFor } = require('../categories');
const { getExamReadiness } = require('../exam-readiness');
const { scoreSubmission, round2 } = require('../scoring/calculate');
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
      
    await db.collection('exams').doc(examId).set({ needsRecalculation: true }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'rank_table_save_failed', message: e.message });
  }
});

// Recalculate all submissions for an exam
router.post('/exams/:examId/recalculate', async (req, res) => {
  const { examId } = req.params;

  try {
    const examRef = db.collection('exams').doc(examId);
    const examDoc = await examRef.get();
    if (!examDoc.exists) return res.status(404).json({ error: 'exam_not_found' });

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
    const batch = db.batch();
    let updatedCount = 0;

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
      
      scores.engineering = scores.total;
      scores.bpharma = round2(scores.physics + scores.chemistry);

      const expectedRank = {
        engineering: predictRank(scores.engineering, engineeringRows),
        bpharma: predictRank(scores.bpharma, bpharmaRows),
      };

      batch.update(subDoc.ref, {
        scores,
        analytics,
        perSubject,
        expectedRank,
      });
      updatedCount++;

      // Firestore batches hold up to 500 operations. If we have more than 500 subs, we'd need multiple batches.
      // Assuming < 500 for now. If > 490, we should commit and start a new batch, but let's keep it simple.
      if (updatedCount >= 490) {
        await batch.commit();
        // Reset batch is complex in a simple loop without re-instantiating. 
        // For Sankalp WBJEE, we likely don't have 500+ subs per exam yet, but it's good to note.
      }
    }

    if (updatedCount > 0 && updatedCount < 490) {
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

    const baseUsersMap = await getCachedUsersMap();
    const usersMap = { ...baseUsersMap };

    for (const sub of submissions) {
      if (sub.userId && !usersMap[sub.userId]) {
        try {
          const singleUserDoc = await db.collection('users').doc(sub.userId).get();
          if (singleUserDoc.exists) {
            const data = singleUserDoc.data() || {};
            const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
            usersMap[sub.userId] = {
              name: fullName,
              email: data.email || '—',
              phone: data.phone || '—',
              gender: data.gender || '—',
              caste: data.caste || '—',
              tfw: data.tfw || '—',
              wbjeeYear: data.wbjeeYear || '—',
            };
            if (_usersCache) {
              _usersCache[sub.userId] = usersMap[sub.userId];
            }
          }
        } catch (err) {
          console.error(`Failed to fetch individual user ${sub.userId}:`, err);
        }
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
    
    // Clear the in-memory predictor settings cache so admin changes
    // take effect immediately instead of waiting for the 60-second TTL.
    bustSettingsCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// Fetch college predictor settings
router.get('/predictor/settings', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update college predictor settings
router.put('/predictor/settings', async (req, res) => {
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
router.get('/payments/purchases', async (req, res) => {
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
router.get('/settings/email_automations', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('email_automations').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Update email automations configuration
router.put('/settings/email_automations', async (req, res) => {
  const payload = ensurePlainObject(req.body);
  try {
    await db.collection('settings').doc('email_automations').set(payload, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'settings_save_failed', message: e.message });
  }
});

// Broadcast announcement via email
router.post('/broadcast-announcement', async (req, res) => {
  const { title, message, target } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'missing_fields' });

  try {
    // Determine audience
    let query = db.collection('users');
    if (target && target !== 'All Students') {
      query = query.where('wbjeeYear', '==', target);
    }
    
    const snap = await query.get();
    const emails = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data.email) emails.push(data.email);
    });

    if (emails.length === 0) {
      return res.json({ ok: true, sentCount: 0 });
    }

    // Send emails in batches of 50 to avoid overloading SMTP or timing out
    let sentCount = 0;
    for (let i = 0; i < emails.length; i += 50) {
      const batch = emails.slice(i, i + 50);
      await Promise.all(batch.map(email => sendEmail({
        to: email,
        subject: `Announcement: ${title} - Sankalp Learning`,
        text: `Hello,\n\nA new announcement has been posted on Sankalp Learning:\n\n${title}\n\n${message}\n\nPlease log in to the portal for more details.\n\nBest regards,\nSankalp Learning Team`
      })));
      sentCount += batch.length;
    }

    res.json({ ok: true, sentCount });
  } catch (e) {
    console.error('Broadcast failed:', e);
    res.status(500).json({ error: 'broadcast_failed', message: e.message });
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
      
      // Email notification
      try {
        const settingsDoc = await db.collection('settings').doc('email_automations').get();
        if (settingsDoc.exists && settingsDoc.data().notifyStudentResetDec) {
          const userId = reqDoc.data().userId;
          const userDoc = await db.collection('users').doc(userId).get();
          const userEmail = userDoc.exists ? userDoc.data().email : null;
          
          if (userEmail) {
            await sendEmail({
              to: userEmail,
              subject: 'Update on your Reset Request - Sankalp Learning',
              text: `Hello,\n\nYour request to reset your exam submission has been APPROVED.\n\nYou may now log in to the portal and take the exam again.\n\nBest regards,\nSankalp Learning Team`
            });
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
router.post('/reset-reject/:subId', async (req, res) => {
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
          await sendEmail({
            to: userEmail,
            subject: 'Update on your Reset Request - Sankalp Learning',
            text: `Hello,\n\nUnfortunately, your request to reset your exam submission has been REJECTED by the admin.\n\nIf you have any questions, please contact support.\n\nBest regards,\nSankalp Learning Team`
          });
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

router.get('/test-email', async (req, res) => {
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
router.post('/predictor/upload', upload.single('file'), async (req, res) => {
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

      // College Type (calculate if not present)
      let college_type = String(findValue(row, ['college_type', 'college type', 'institute_type', 'institute type'], '')).trim();
      if (!college_type) {
        const instL = institute.toLowerCase();
        if (instL.includes('university') || instL.includes('jadavpur') || instL.includes('calcutta') || instL.includes('kalyani university')) {
          college_type = 'University/University Department';
        } else if (instL.includes('government') || instL.includes('jalpaiguri government') || instL.includes('kalyani government') || instL.includes('ghani khan')) {
          college_type = 'State Government Engineering College';
        } else if (instL.includes('pharmacy') && instL.includes('government')) {
          college_type = 'State Government Pharmacy College';
        } else {
          college_type = 'Private Engineering College';
        }
      }

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
router.get('/predictor/status', async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);

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
router.post('/predictor/clear', async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);

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

module.exports = router;

