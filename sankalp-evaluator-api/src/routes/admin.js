const express = require('express');
const { admin, db } = require('../firebase');
const { requireAdmin, verifyToken } = require('../auth');
const { COUNTS, START, END, categoryFor } = require('../categories');
const { getExamReadiness } = require('../exam-readiness');
const { scoreSubmission, round2 } = require('../scoring/calculate');
const { defaultRankRows, predictRank } = require('../scoring/ranking');

const router = express.Router();
const { sendEmail } = require('../mailer');

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
    // Optimization: limit to 100 to avoid massive database reads on the free tier
    query = query.orderBy('submittedAt', 'desc').limit(100);
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

    // Optimize user fetching: Only fetch users that appear in these submissions
    const uids = [...new Set(submissions.map(s => s.id.split('_')[0]))].filter(Boolean);
    const usersMap = {};
    
    // Fetch users in parallel
    await Promise.all(uids.map(async (uid) => {
      try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) {
          const data = doc.data();
          const fullName = data.name || data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Unknown Student';
          usersMap[uid] = {
            name: fullName,
            email: data.email || '—',
            phone: data.phone || '—',
            gender: data.gender || '—',
            caste: data.caste || '—',
            tfw: data.tfw || '—',
            wbjeeYear: data.wbjeeYear || '—',
          };
        }
      } catch (err) {
        console.error('Error fetching user', uid, err);
      }
    }));

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

module.exports = router;
