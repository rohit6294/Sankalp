const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken, requireSuperAdmin } = require('../auth');
const { ADMIN_SECTIONS, normalizePermissions } = require('../permissions');

const router = express.Router();

router.use(verifyToken, requireSuperAdmin);

function publicAdmin(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    name: data.name || data.displayName || 'Unknown Admin',
    email: data.email || '',
    isSubAdmin: data.isSubAdmin === true,
    isSuperAdmin: data.isSubAdmin !== true,
    permissions: data.isSubAdmin === true ? normalizePermissions(data.permissions) : null,
    createdAt: data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : null,
    updatedAt: data.updatedAt && typeof data.updatedAt.toMillis === 'function' ? data.updatedAt.toMillis() : null,
  };
}

async function setSubAdminClaims(uid, permissions) {
  await admin.auth().setCustomUserClaims(uid, {
    admin: true,
    role: 'admin',
    isSubAdmin: true,
    permissions: normalizePermissions(permissions),
  });
}

router.get('/sections', (_req, res) => {
  res.json({ sections: ADMIN_SECTIONS });
});

router.get('/', async (_req, res) => {
  try {
    const snap = await db.collection('users').where('role', '==', 'admin').get();
    const admins = snap.docs.map(publicAdmin).sort((a, b) => {
      if (a.isSubAdmin !== b.isSubAdmin) return a.isSubAdmin ? 1 : -1;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });
    res.json({ admins, sections: ADMIN_SECTIONS });
  } catch (err) {
    console.error('Failed to fetch admins:', err);
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const permissions = normalizePermissions(req.body?.permissions);

  if (!name || !email || !password) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Name, email, and password are required.',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({
      error: 'weak_password',
      message: 'Password must be at least 6 characters.',
    });
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    await setSubAdminClaims(userRecord.uid, permissions);

    const payload = {
      name,
      email,
      role: 'admin',
      isSubAdmin: true,
      permissions,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('users').doc(userRecord.uid).set(payload);

    res.status(201).json({
      ok: true,
      message: 'Sub-admin created successfully.',
      admin: {
        id: userRecord.uid,
        ...payload,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  } catch (err) {
    if (userRecord?.uid) {
      await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    }

    console.error('Failed to create sub-admin:', err);
    const status = err.code === 'auth/email-already-exists' ? 409 : 500;
    res.status(status).json({ error: 'creation_failed', message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const name = req.body?.name !== undefined ? String(req.body.name || '').trim() : undefined;
  const password = req.body?.password !== undefined ? String(req.body.password || '') : undefined;
  const hasPermissions = req.body?.permissions !== undefined;
  const permissions = hasPermissions ? normalizePermissions(req.body.permissions) : null;

  if (name !== undefined && !name) {
    return res.status(400).json({ error: 'invalid_name', message: 'Name cannot be empty.' });
  }
  if (password !== undefined && password !== '' && password.length < 6) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  }

  try {
    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'admin_not_found', message: 'Sub-admin account does not exist.' });
    }

    const data = snap.data() || {};
    if (data.isSubAdmin !== true) {
      return res.status(403).json({ error: 'forbidden_update', message: 'Super admin accounts cannot be edited here.' });
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const authUpdate = {};

    if (name !== undefined) {
      updateData.name = name;
      authUpdate.displayName = name;
    }
    if (hasPermissions) {
      updateData.permissions = permissions;
    }
    if (password) {
      authUpdate.password = password;
    }

    await userRef.update(updateData);

    if (Object.keys(authUpdate).length) {
      await admin.auth().updateUser(id, authUpdate);
    }
    if (hasPermissions) {
      await setSubAdminClaims(id, permissions);
    }

    const updated = await userRef.get();
    res.json({
      ok: true,
      message: 'Sub-admin account updated successfully.',
      admin: publicAdmin(updated),
    });
  } catch (err) {
    console.error('Failed to update sub-admin:', err);
    res.status(500).json({ error: 'update_failed', message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (id === req.user.uid) {
    return res.status(400).json({ error: 'self_delete_blocked', message: 'You cannot delete your own admin account.' });
  }

  try {
    const userRef = db.collection('users').doc(id);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'admin_not_found', message: 'Admin account does not exist.' });
    }

    const data = snap.data() || {};
    if (data.isSubAdmin !== true) {
      return res.status(403).json({ error: 'forbidden_deletion', message: 'Super admins cannot be deleted.' });
    }

    await admin.auth().deleteUser(id).catch((err) => {
      if (err.code !== 'auth/user-not-found') throw err;
    });
    await userRef.delete();

    res.json({ ok: true, message: 'Sub-admin deleted successfully.' });
  } catch (err) {
    console.error('Failed to delete sub-admin:', err);
    res.status(500).json({ error: 'deletion_failed', message: err.message });
  }
});

module.exports = router;
