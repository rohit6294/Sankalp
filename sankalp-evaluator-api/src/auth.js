const { auth, db } = require('./firebase');
const { allPermissions, hasPermission, normalizePermissions } = require('./permissions');

const DEFAULT_ADMIN_EMAILS = [
  'rohitgupta6294@gmail.com',
  'rahulgupta6294@gmail.com',
];

function adminEmailSet() {
  const emails = new Set(DEFAULT_ADMIN_EMAILS.map((email) => email.trim().toLowerCase()));
  if (process.env.ADMIN_EMAILS) {
    process.env.ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
      .forEach((email) => emails.add(email));
  }
  return emails;
}

function isSuperAdminEmail(email) {
  return !!email && adminEmailSet().has(String(email).trim().toLowerCase());
}

async function getAdminProfile(user) {
  if (!user) return null;

  const email = String(user.email || '').toLowerCase();
  if (isSuperAdminEmail(email)) {
    return {
      uid: user.uid,
      email,
      name: user.name || user.displayName || email.split('@')[0],
      role: 'admin',
      isSubAdmin: false,
      isSuperAdmin: true,
      permissions: allPermissions(),
    };
  }

  const snap = await db.collection('users').doc(user.uid).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (data.role !== 'admin' && user.admin !== true && user.role !== 'admin') {
    return null;
  }

  const isSubAdmin = data.isSubAdmin === true || user.isSubAdmin === true;
  return {
    uid: user.uid,
    email: data.email || email,
    name: data.name || data.displayName || user.name || user.displayName || email.split('@')[0],
    role: 'admin',
    isSubAdmin,
    isSuperAdmin: !isSubAdmin,
    permissions: isSubAdmin ? normalizePermissions(data.permissions || user.permissions) : allPermissions(),
  };
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
    const profile = await getAdminProfile(req.user);
    if (!profile) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.adminProfile = profile;
    next();
  } catch (e) {
    res.status(500).json({ error: 'role_check_failed' });
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    const profile = req.adminProfile || await getAdminProfile(req.user);
    if (!profile || profile.isSuperAdmin !== true) {
      return res.status(403).json({
        error: 'forbidden_super_admin',
        message: 'Only Super Admins can perform this action.',
      });
    }
    req.adminProfile = profile;
    next();
  } catch (e) {
    res.status(500).json({ error: 'super_admin_check_failed' });
  }
}

function requirePermission(section, action) {
  return async (req, res, next) => {
    try {
      const profile = req.adminProfile || await getAdminProfile(req.user);
      if (!profile) {
        return res.status(403).json({ error: 'forbidden' });
      }
      req.adminProfile = profile;

      // Super Admins have all permissions implicitly
      if (profile.isSuperAdmin === true) {
        return next();
      }

      if (hasPermission(profile.permissions, section, action)) {
        return next();
      }

      res.status(403).json({
        error: 'forbidden_permission',
        message: `Access denied. You do not have permission to ${action} this section (${section}).`
      });
    } catch (e) {
      console.error(`Permission check failed for ${section}:${action}:`, e);
      res.status(500).json({ error: 'permission_check_failed', message: e.message });
    }
  };
}

module.exports = {
  DEFAULT_ADMIN_EMAILS,
  adminEmailSet,
  isSuperAdminEmail,
  getAdminProfile,
  verifyToken,
  requireAdmin,
  requireSuperAdmin,
  requirePermission,
};
