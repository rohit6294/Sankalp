const express = require('express');
const cors = require('cors');

require('dotenv').config();
require('./firebase');

const { restoreDatabaseBackups } = require('./database-backup');
restoreDatabaseBackups().catch(console.error);
// Redeploy triggered to force database restore from Firestore backups
const examsRouter = require('./routes/exams');
const submitRouter = require('./routes/submit');
const resultRouter = require('./routes/result');
const rankRouter = require('./routes/rank');
const adminRouter = require('./routes/admin');
const paymentRouter = require('./routes/payment');
const predictorRouter = require('./routes/predictor');
const subadminsRouter = require('./routes/subadmins');
const notesRouter = require('./routes/notes');
const testsRouter = require('./routes/tests');
const prepRouter = require('./routes/prep');
const choiceFillingRouter = require('./routes/choice-filling');
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

app.get('/api/debug-routes', (_req, res) => {
  const routes = [];
  function print(path, layer) {
    if (layer.route) {
      layer.route.stack.forEach(print.bind(null, path + (layer.route.path || '')));
    } else if (layer.name === 'router' && layer.handle.stack) {
      let routerPath = path;
      if (layer.regexp.toString().includes('admin')) routerPath += '/api/admin';
      else if (layer.regexp.toString().includes('predictor')) routerPath += '/api/predictor';
      else if (layer.regexp.toString().includes('choice-filling')) routerPath += '/api/choice-filling';
      else if (layer.regexp.toString().includes('exams')) routerPath += '/api/exams';
      else if (layer.regexp.toString().includes('submit')) routerPath += '/api/submit';
      else if (layer.regexp.toString().includes('result')) routerPath += '/api/result';
      else if (layer.regexp.toString().includes('rank')) routerPath += '/api/rank';
      else if (layer.regexp.toString().includes('payment')) routerPath += '/api/payment';
      
      layer.handle.stack.forEach(print.bind(null, routerPath));
    } else if (layer.method) {
      routes.push(`${layer.method.toUpperCase()} ${path}`);
    }
  }
  app._router.stack.forEach(print.bind(null, ''));
  res.json({ routes });
});


app.use('/api/exams', examsRouter);
app.use('/api/submit', submitRouter);
app.use('/api/result', resultRouter);
app.use('/api/rank', rankRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/sub-admins', subadminsRouter);
app.use('/api/payment', paymentRouter);
// Standard Razorpay endpoint aliases: /api/create-order and /api/verify-payment.
app.use('/api', paymentRouter);
app.use('/api/predictor', predictorRouter);
app.use('/api/choice-filling', choiceFillingRouter);
app.use('/api/notes', notesRouter);
app.use('/api/tests', testsRouter);
app.use('/api/prep', prepRouter);

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
  const { firstName, lastName, email, phone, wbjeeYear, gender, caste, tfw, homeState, bio } = req.body || {};
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
  if (homeState !== undefined) update.homeState = String(homeState).trim();
  if (bio       !== undefined) update.bio       = String(bio).trim();
  if (!Object.keys(update).length) return res.status(400).json({ error: 'no_fields' });
  try {
    const userDocRef = db.collection('users').doc(uid);
    const existingUser = await userDocRef.get();
    const isFirstTime = !existingUser.exists || !existingUser.data().name;

    await userDocRef.set(update, { merge: true });

    // Send Welcome Email if it is their first time completing the profile
    if (isFirstTime && update.email) {
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
          <h2 style="color: #C94E1F; margin-top: 0;">Welcome to Sankalp Aspirant!</h2>
          <p>Hello ${update.name || 'Student'},</p>
          <p>Welcome to Sankalp Aspirant! We are thrilled to have you on board.</p>
          <p>Make sure to subscribe to our <a href="https://www.youtube.com/@Sankalp_Wbjee12" target="_blank" style="color: #C94E1F; font-weight: bold; text-decoration: underline;">YouTube channel (@sankalp_wbjee12)</a> for updates and tips.</p>
          <p>You can now take mock tests and view detailed analytics on your dashboard.</p>
          <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 20px 0;">
          <p style="font-size: 12px; color: #777777; margin-bottom: 0;">Best of luck with your preparation,<br><strong>Sankalp Aspirant Team</strong></p>
        </div>
      `;

      sendEmail({
        to: update.email,
        subject: 'Welcome to Sankalp Aspirant!',
        text: `Hello ${update.name || 'Student'},\n\nWelcome to Sankalp Aspirant!\nWe are thrilled to have you on board.\n\nMake sure to subscribe to our YouTube channel (@sankalp_wbjee12) here: https://www.youtube.com/@Sankalp_Wbjee12 for updates and tips.\nYou can now take mock tests and view detailed analytics on your dashboard.\n\nBest of luck with your preparation,\nSankalp Aspirant Team`,
        html: htmlBody
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
          
          sendEmail({
            to: automations.adminEmail,
            subject: 'New Reset Request - Sankalp Learning',
            text: `Hello Admin,\n\nA new reset request has been submitted.\n\nStudent: ${studentName}\nExam ID: ${examId}\nReason: ${reason || 'No reason provided'}\n\nPlease check the admin panel to approve or reject this request.\n\nBest regards,\nSankalp Learning Automation`
          }).catch(console.error);
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
