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

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`sankalp-evaluator-api listening on :${port}`);
});
