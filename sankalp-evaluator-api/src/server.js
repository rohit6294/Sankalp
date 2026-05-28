const express = require('express');
const cors = require('cors');

require('./firebase');

const examsRouter = require('./routes/exams');
const submitRouter = require('./routes/submit');
const resultRouter = require('./routes/result');
const rankRouter = require('./routes/rank');
const adminRouter = require('./routes/admin');
const { verifyToken } = require('./auth');
const { db } = require('./firebase');
const { sendEmail } = require('./mailer');

const app = express();

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type'],
}));
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/exams', examsRouter);
app.use('/api/submit', submitRouter);
app.use('/api/result', resultRouter);
app.use('/api/rank', rankRouter);
app.use('/api/admin', adminRouter);

// Student-accessible settings: any authenticated user can read mandatory fields
app.get('/api/settings/mandatory-fields', verifyToken, async (_req, res) => {
  try {
    const doc = await db.collection('settings').doc('mandatory_fields').get();
    res.json({ settings: doc.exists ? doc.data() : {} });
  } catch (e) {
    res.status(500).json({ error: 'settings_load_failed', message: e.message });
  }
});

// Student profile update — uses Admin SDK to bypass Firestore client-side permission rules
app.put('/api/profile', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { firstName, lastName, email, phone, wbjeeYear, gender, caste, tfw, bio } = req.body || {};
  const update = {};
  if (firstName !== undefined) update.firstName = String(firstName).trim();
  if (lastName  !== undefined) update.lastName  = String(lastName).trim();
  if (firstName !== undefined || lastName !== undefined) {
    update.name = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
    if (update.name && !/[a-z].*[a-z]/i.test(update.name)) {
      return res.status(400).json({ error: 'Name must contain at least 2 alphabet characters.' });
    }
  }
  if (email !== undefined && email !== '') update.email = String(email).trim();
  if (phone     !== undefined) update.phone     = String(phone).trim();
  if (wbjeeYear !== undefined) update.wbjeeYear = String(wbjeeYear).trim();
  if (gender    !== undefined) update.gender    = String(gender).trim();
  if (caste     !== undefined) update.caste     = String(caste).trim();
  if (tfw       !== undefined) update.tfw       = String(tfw).trim();
  if (bio       !== undefined) update.bio       = String(bio).trim();
  if (!Object.keys(update).length) return res.status(400).json({ error: 'no_fields' });
  try {
    const userDocRef = db.collection('users').doc(uid);
    const existingUser = await userDocRef.get();
    const isFirstTime = !existingUser.exists || !existingUser.data().name;

    await userDocRef.set(update, { merge: true });

    // Send Welcome Email if it is their first time completing the profile
    if (isFirstTime && update.email) {
      sendEmail({
        to: update.email,
        subject: 'Welcome to Sankalp Learning!',
        text: `Hello ${update.name || 'Student'},\n\nWelcome to Sankalp Learning!\nWe are thrilled to have you on board.\n\nMake sure to subscribe to our YouTube channel (@sankalp_wbjee12) for updates and tips.\nYou can now take mock tests and view detailed analytics on your dashboard.\n\nBest of luck with your preparation,\nSankalp Learning Team`
      }).catch(err => console.error('Welcome email failed:', err));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'profile_save_failed', message: e.message });
  }
});

// ── Reset Submission Request (Student → Admin) ──────────────────────────

// Student sends a reset request
app.post('/api/submit/reset-request', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { examId, reason } = req.body || {};
  if (!examId) return res.status(400).json({ error: 'missing_examId' });
  if (!reason || String(reason).trim().length < 15) {
    return res.status(400).json({ error: 'missing_reason', message: 'Please provide a detailed reason (minimum 15 characters).' });
  }

  const docId = `${uid}_${examId}`;
  try {
    const subDoc = await db.collection('submissions').doc(docId).get();
    if (!subDoc.exists) return res.status(404).json({ error: 'no_submission' });

    // Check if already requested
    const existing = await db.collection('resetRequests').doc(docId).get();
    if (existing.exists && existing.data().status === 'pending') {
      return res.status(409).json({ error: 'already_requested' });
    }

    await db.collection('resetRequests').doc(docId).set({
      userId: uid,
      examId,
      reason: reason ? String(reason).trim().substring(0, 500) : '',
      status: 'pending',
      requestedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
    });

    // Check automation settings and send email if enabled
    try {
      const settingsDoc = await db.collection('settings').doc('email_automations').get();
      if (settingsDoc.exists) {
        const automations = settingsDoc.data();
        if (automations.notifyAdminResetReq && automations.adminEmail) {
          const userDoc = await db.collection('users').doc(uid).get();
          const studentName = userDoc.exists ? (userDoc.data().name || userDoc.data().displayName || 'A student') : 'A student';
          
          await sendEmail({
            to: automations.adminEmail,
            subject: 'New Reset Request - Sankalp Learning',
            text: `Hello Admin,\n\nA new reset request has been submitted.\n\nStudent: ${studentName}\nExam ID: ${examId}\nReason: ${reason || 'No reason provided'}\n\nPlease check the admin panel to approve or reject this request.\n\nBest regards,\nSankalp Learning Automation`
          });
        }
      }
    } catch (err) {
      console.error('Failed to process reset request email automation:', err);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reset_request_failed', message: e.message });
  }
});

// Student checks their reset request status
app.get('/api/submit/reset-status/:examId', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const docId = `${uid}_${req.params.examId}`;
  try {
    const doc = await db.collection('resetRequests').doc(docId).get();
    if (!doc.exists) return res.json({ requested: false });
    const data = doc.data();
    res.json({ requested: true, status: data.status, reason: data.reason || '' });
  } catch (e) {
    res.status(500).json({ error: 'status_check_failed', message: e.message });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`sankalp-evaluator-api listening on :${port}`);
});
