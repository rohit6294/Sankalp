const { auth } = require('./firebase');

const DEFAULT_ADMIN_EMAILS = [
  'rohitgupta6294@gmail.com',
  'rahulgupta6294@gmail.com',
];

function adminEmailSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS.join(','))
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.user = await auth.verifyIdToken(token);
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid_token' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const email = String(req.user.email || '').toLowerCase();
    if (email && adminEmailSet().has(email)) {
      return next();
    }

    if (req.user.admin === true || req.user.role === 'admin') {
      return next();
    }

    const { db } = require('./firebase');
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists || snap.data().role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'role_check_failed' });
  }
}

module.exports = { verifyToken, requireAdmin };
