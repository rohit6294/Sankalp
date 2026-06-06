const express = require('express');
const { db, admin } = require('../firebase');
const { verifyToken, requirePermission } = require('../auth');

const router = express.Router();

// ── 0. Mock Test Series CRUD (Admin) ─────────────────────────────────────────
router.get('/series', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('mockTestSeries').orderBy('createdAt', 'desc').get();
    const series = [];
    snap.forEach(doc => series.push({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, series });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

router.post('/series', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { title, description, price } = req.body;
    const docRef = await db.collection('mockTestSeries').add({
      title,
      description: description || '',
      price: Number(price) || 0,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid
    });
    res.json({ ok: true, id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: 'creation_failed', message: err.message });
  }
});

router.put('/series/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = Number(price);
    
    await db.collection('mockTestSeries').doc(id).update(updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'update_failed', message: err.message });
  }
});

router.delete('/series/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('mockTestSeries').doc(id).delete();
    // Optionally: remove seriesId from associated tests, but leaving it dangling is fine too
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', message: err.message });
  }
});


// ── 1. Create a new Mock Test (Admin) ────────────────────────────────────────
router.post('/', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { title, type, subject, durationMin, accessType, price, totalQuestions, seriesId, chapter, cat1Qs, cat2Qs, cat3Qs } = req.body;
    
    const docRef = await db.collection('mockTests').add({
      title,
      type,
      chapter: chapter || null,
      subject,
      durationMin: Number(durationMin) || 60,
      totalQuestions: Number(totalQuestions) || 0,
      cat1Qs: Number(cat1Qs) || 0,
      cat2Qs: Number(cat2Qs) || 0,
      cat3Qs: Number(cat3Qs) || 0,
      accessType: accessType || 'free',
      price: accessType === 'paid' ? Number(price) || 0 : 0,
      seriesId: seriesId || null,
      status: 'draft', // defaults to draft until published
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid
    });
    
    res.json({ ok: true, id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: 'creation_failed', message: err.message });
  }
});

// ── 2. Add/Edit Questions to a Test (Admin) ──────────────────────────────────
router.post('/:id/questions', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { questions } = req.body; // Array of question objects
    
    const testDoc = await db.collection('mockTests').doc(id).get();
    if (!testDoc.exists) return res.status(404).json({ error: 'not_found' });
    
    const batch = db.batch();
    
    // First delete all existing questions for this test to perform a clean overwrite
    const existingQs = await db.collection('mockTestQuestions').where('testId', '==', id).get();
    existingQs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    // Add new questions
    questions.forEach(q => {
      const qRef = db.collection('mockTestQuestions').doc();
      batch.set(qRef, {
        testId: id,
        text: q.text,
        image: q.image || null,
        options: q.options || [], // Array of {text, image}
        correctOptions: q.correctOptions || [], // Array of indices like [0, 2]
        category: Number(q.category) || 1, // 1, 2, or 3
        subject: q.subject || testDoc.data().subject
      });
    });
    
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'save_failed', message: err.message });
  }
});

// ── 3. Fetch Available Tests (Student/Admin) ─────────────────────────────────
router.get('/available', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('mockTests').orderBy('createdAt', 'desc').get();
    
    const tests = [];
    snap.forEach(doc => {
      tests.push({ id: doc.id, ...doc.data() });
    });
    
    // Determine access for students
    const uid = req.user.uid;
    const isContentAdmin = req.user.permissions?.content?.view;
    
    // Fetch user's subscription and purchases in parallel
    const [subDoc, purchasesSnap] = await Promise.all([
      db.collection('subscriptions').doc(uid).get(),
      db.collection('purchases').where('userId', '==', uid).get()
    ]);
    
    const hasActiveSub = subDoc.exists && subDoc.data().validUntil.toDate() > new Date();
    const purchasedIds = new Set();
    const purchasedSeriesIds = new Set();
    
    purchasesSnap.docs.forEach(d => {
      const data = d.data();
      if (data.status === 'success') {
        if (data.product === 'mock_test') purchasedIds.add(data.productId);
        if (data.product === 'mock_test_series') purchasedSeriesIds.add(data.productId);
      }
    });
    
    const finalTests = tests.map(t => {
      let allowed = false;
      if (isContentAdmin) allowed = true;
      else if (t.accessType === 'free') allowed = true;
      else if (hasActiveSub) allowed = true; // global pass unlocks everything
      else if (t.accessType === 'paid' && purchasedIds.has(t.id)) allowed = true;
      else if (t.seriesId && purchasedSeriesIds.has(t.seriesId)) allowed = true;
      
      return { ...t, allowed };
    });
    
    // Fetch available series
    const seriesSnap = await db.collection('mockTestSeries').orderBy('createdAt', 'desc').get();
    const series = [];
    seriesSnap.forEach(doc => {
      const s = { id: doc.id, ...doc.data() };
      let allowed = false;
      if (isContentAdmin) allowed = true;
      else if (hasActiveSub) allowed = true;
      else if (purchasedSeriesIds.has(s.id)) allowed = true;
      series.push({ ...s, allowed });
    });
    
    res.json({ ok: true, tests: finalTests, series });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

// ── 4. Fetch Test Details & Questions (Student/Admin) ────────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const testDoc = await db.collection('mockTests').doc(id).get();
    if (!testDoc.exists) return res.status(404).json({ error: 'not_found' });
    
    const testData = testDoc.data();
    
    // Check Access (unless Admin)
    const isContentAdmin = req.user.permissions?.content?.view;
    if (!isContentAdmin && testData.accessType !== 'free') {
      let allowed = false;
      // Global Pass check
      const subDoc = await db.collection('subscriptions').doc(req.user.uid).get();
      if (subDoc.exists && subDoc.data().validUntil.toDate() > new Date()) {
        allowed = true;
      }
      
      // Individual purchase check
      if (!allowed) {
        const purDoc = await db.collection('purchases').doc(`${req.user.uid}_mock_test_${id}`).get();
        if (purDoc.exists && purDoc.data().status === 'success') allowed = true;
      }
      
      // Series purchase check
      if (!allowed && testData.seriesId) {
        const seriesPurDoc = await db.collection('purchases').doc(`${req.user.uid}_mock_test_series_${testData.seriesId}`).get();
        if (seriesPurDoc.exists && seriesPurDoc.data().status === 'success') allowed = true;
      }
      
      if (!allowed) return res.status(403).json({ error: 'access_denied', message: 'You must purchase this test or its series to view it.' });
    }
    
    // Fetch Questions
    const qsSnap = await db.collection('mockTestQuestions').where('testId', '==', id).get();
    const questions = [];
    qsSnap.forEach(doc => {
      const q = doc.data();
      // Hide correct options from students
      if (!isContentAdmin) {
        delete q.correctOptions;
      }
      questions.push({ id: doc.id, ...q });
    });
    
    res.json({ ok: true, test: { id: testDoc.id, ...testData }, questions });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

// ── 5. Submit Answers and AUTO-GRADE (WBJEE LOGIC) ───────────────────────────
router.post('/:id/submit', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { answers, tabViolations } = req.body; // answers format: { questionId: [selectedIndices...] }
    
    // Fetch all correct answers to grade
    const qsSnap = await db.collection('mockTestQuestions').where('testId', '==', id).get();
    let totalScore = 0;
    let scoreCat1 = 0, scoreCat2 = 0, scoreCat3 = 0;
    
    const detailedResults = {};
    
    qsSnap.forEach(doc => {
      const qId = doc.id;
      const q = doc.data();
      const cat = q.category || 1;
      const correctIndices = q.correctOptions || [];
      const studentSelected = answers[qId] || []; // Array of indices
      
      let marksAwarded = 0;
      
      // Calculate WBJEE Marking Scheme
      if (cat === 1) {
        // Cat 1: Single correct (+1, -0.25)
        if (studentSelected.length === 0) {
          marksAwarded = 0;
        } else if (studentSelected.length === 1 && studentSelected[0] === correctIndices[0]) {
          marksAwarded = 1;
        } else {
          marksAwarded = -0.25;
        }
        scoreCat1 += marksAwarded;
      } 
      else if (cat === 2) {
        // Cat 2: Single correct (+2, -0.5)
        if (studentSelected.length === 0) {
          marksAwarded = 0;
        } else if (studentSelected.length === 1 && studentSelected[0] === correctIndices[0]) {
          marksAwarded = 2;
        } else {
          marksAwarded = -0.5;
        }
        scoreCat2 += marksAwarded;
      } 
      else if (cat === 3) {
        // Cat 3: Multiple correct (+2, partial marking (y/x)*2, NO negative)
        if (studentSelected.length === 0) {
          marksAwarded = 0;
        } else {
          // Check if ANY incorrect option is selected
          const hasIncorrectSelection = studentSelected.some(sel => !correctIndices.includes(sel));
          if (hasIncorrectSelection) {
            marksAwarded = 0;
          } else {
            // Partial or full marking
            const x = correctIndices.length; // Total correct options
            const y = studentSelected.length; // Number of correct options selected (since we verified no incorrect)
            marksAwarded = (y / x) * 2;
          }
        }
        scoreCat3 += marksAwarded;
      }
      
      totalScore += marksAwarded;
      detailedResults[qId] = {
        selected: studentSelected,
        correct: correctIndices,
        marks: marksAwarded
      };
    });
    
    // Save Submission
    const submissionRef = db.collection('mockTestSubmissions').doc();
    await submissionRef.set({
      testId: id,
      userId: req.user.uid,
      answers,
      tabViolations: tabViolations || 0,
      scoreDetails: {
        totalScore,
        scoreCat1,
        scoreCat2,
        scoreCat3
      },
      detailedResults, // Keep full granularity
      submittedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ ok: true, score: totalScore, submissionId: submissionRef.id });
  } catch (err) {
    res.status(500).json({ error: 'submit_failed', message: err.message });
  }
});

module.exports = router;
