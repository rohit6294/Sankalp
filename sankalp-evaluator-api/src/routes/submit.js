const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken } = require('../auth');
const { missingAnswerNumbers } = require('../exam-readiness');
const { scoreSubmission, round2 } = require('../scoring/calculate');
const { defaultRankRows, predictRank } = require('../scoring/ranking');
const { sendEmail } = require('../mailer');
const rankRouter = require('./rank');

const router = express.Router();

router.post('/', verifyToken, async (req, res) => {
  const { examId, mathSet, physChemSet, answers } = req.body || {};
  if (!examId || !mathSet || !physChemSet || !answers) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const sets = ['A', 'B', 'C', 'D'];
  if (!sets.includes(mathSet) || !sets.includes(physChemSet)) {
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

    // Backend enforcement: Check if user profile is complete (valid name)
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const nameVal = String(userData.name || userData.displayName || `${userData.firstName || ''} ${userData.lastName || ''}`).trim().toLowerCase();
    const hasEnoughLetters = /[a-z].*[a-z]/i.test(nameVal);
    
    if (nameVal === 'unknown student' || nameVal === '' || !hasEnoughLetters) {
      return res.status(403).json({ 
        error: 'incomplete_profile', 
        message: 'Your profile is incomplete. You must provide a valid full name in your profile settings before submitting an exam.' 
      });
    }

    const examRef = db.collection('exams').doc(examId);
    const examDoc = await examRef.get();
    if (!examDoc.exists || examDoc.data().active !== true) {
      return res.status(404).json({ error: 'exam_not_available' });
    }

    // Fetch the two separate answer key documents
    const mathKeyRef = examRef.collection('answerKeys').doc(`math_${mathSet}`);
    const physChemKeyRef = examRef.collection('answerKeys').doc(`physChem_${physChemSet}`);

    const [mathKeyDoc, physChemKeyDoc] = await Promise.all([
      mathKeyRef.get(),
      physChemKeyRef.get(),
    ]);

    if (!mathKeyDoc.exists || !physChemKeyDoc.exists) {
      return res.status(404).json({ error: 'answer_key_not_found' });
    }

    const mathData = mathKeyDoc.data() || {};
    const physChemData = physChemKeyDoc.data() || {};

    const keys = {
      math: mathData.math || {},
      physics: physChemData.physics || {},
      chemistry: physChemData.chemistry || {},
    };

    const missingMath = missingAnswerNumbers('math', keys.math);
    const missingPhysics = missingAnswerNumbers('physics', keys.physics);
    const missingChemistry = missingAnswerNumbers('chemistry', keys.chemistry);
    if (missingMath.length || missingPhysics.length || missingChemistry.length) {
      const problems = [];
      if (missingMath.length) problems.push(`math missing ${missingMath.length}`);
      if (missingPhysics.length) problems.push(`physics missing ${missingPhysics.length}`);
      if (missingChemistry.length) problems.push(`chemistry missing ${missingChemistry.length}`);
      return res.status(400).json({
        error: 'incomplete_answer_key',
        message: `Answer key is incomplete: ${problems.join(', ')}`,
      });
    }

    const { scores, analytics, perSubject } = scoreSubmission(answers, keys);

    // Compute Engineering and B-Pharma scores
    scores.engineering = scores.total;
    scores.bpharma = round2(scores.physics + scores.chemistry);

    // Fetch both rank tables
    const engRankRef = examRef.collection('rankTable').doc('engineering');
    const bphRankRef = examRef.collection('rankTable').doc('bpharma');

    const [engRankDoc, bphRankDoc] = await Promise.all([
      engRankRef.get(),
      bphRankRef.get(),
    ]);

    const engineeringRows = engRankDoc.exists ? (engRankDoc.data().rows || []) : defaultRankRows('engineering');
    const bpharmaRows = bphRankDoc.exists ? (bphRankDoc.data().rows || []) : defaultRankRows('bpharma');
    const expectedRank = {
      engineering: predictRank(scores.engineering, engineeringRows),
      bpharma: predictRank(scores.bpharma, bpharmaRows),
    };

    const payload = {
      userId: uid,
      examId,
      examName: examDoc.data().name || examId,
      mathSet,
      physChemSet,
      answers,
      scores,
      analytics,
      perSubject,
      expectedRank,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      locked: true,
    };
    await subRef.create(payload);

    // Bust the community rank cache for this exam so subsequent rank views reflect the new submission immediately
    if (rankRouter && typeof rankRouter.bustExamTotalsCache === 'function') {
      rankRouter.bustExamTotalsCache(examId);
    }

    // Send Exam Submission Receipt Email
    if (userData.email) {
      const examName = examDoc.data().name || examId;
      const totalScore = (scores.engineering || 0);
      const mathScore = (scores.math || 0);
      const physicsScore = (scores.physics || 0);
      const chemistryScore = (scores.chemistry || 0);
      const rankText = expectedRank ? `\nYour Expected WBJEE Rank:\n- Engineering Rank: ${expectedRank.engineering || 'N/A'}\n- B.Pharma Rank: ${expectedRank.bpharma || 'N/A'}` : '';
      
      sendEmail({
        to: userData.email,
        subject: `Exam Submission Receipt: ${examName} - Sankalp Learning`,
        text: `Hello ${userData.name || 'Student'},\n\nYour submission for "${examName}" has been successfully recorded.\n\nScore Breakdown:\n- Total Score: ${totalScore}\n- Math: ${mathScore}\n- Physics: ${physicsScore}\n- Chemistry: ${chemistryScore}${rankText}\n\nLog in to your dashboard to view detailed analytics and performance insights.\n\nBest of luck,\nSankalp Learning Team`
      }).catch(err => console.error('Submission receipt email failed:', err));
    }

    res.json({ ok: true, scores, analytics, expectedRank });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(e.message || '')) {
      return res.status(409).json({ error: 'already_submitted' });
    }
    res.status(500).json({ error: 'submit_failed', message: e.message });
  }
});

module.exports = router;
