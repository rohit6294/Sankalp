const express = require('express');
const cors = require('cors');

require('./firebase');

const examsRouter = require('./routes/exams');
const submitRouter = require('./routes/submit');
const resultRouter = require('./routes/result');
const rankRouter = require('./routes/rank');

const app = express();

const allowed = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim());

app.use(cors({
  origin: allowed.includes('*') ? true : allowed,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Authorization', 'Content-Type'],
}));
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/exams', examsRouter);
app.use('/api/submit', submitRouter);
app.use('/api/result', resultRouter);
app.use('/api/rank', rankRouter);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`sankalp-evaluator-api listening on :${port}`);
});
