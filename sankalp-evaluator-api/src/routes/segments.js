const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../auth');
const { RULE_DEFINITIONS, OPERATORS, getDynamicOptions } = require('../segment-registry');
const { evaluateSegmentRules } = require('../segment-engine');

const router = express.Router();

// 1. Get Rule Registry & Dynamic Option Dropdowns
router.get('/registry', verifyToken, requireAdmin, async (req, res) => {
  try {
    const dynamicOptions = await getDynamicOptions();
    res.json({
      ok: true,
      operators: OPERATORS,
      rules: RULE_DEFINITIONS,
      options: dynamicOptions
    });
  } catch (e) {
    console.error('Failed to get segment registry:', e);
    res.status(500).json({ error: 'registry_failed', message: e.message });
  }
});

// 2. List Saved Segments
router.get('/list', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('studentSegments').orderBy('createdAt', 'desc').get();
    const segments = [];

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const evalRes = await evaluateSegmentRules(data.rules || {}).catch(() => ({ matchingCount: 0 }));

      segments.push({
        id: doc.id,
        name: data.name || 'Untitled Segment',
        description: data.description || '',
        rules: data.rules || {},
        matchingCount: evalRes.matchingCount,
        createdBy: data.createdBy || 'Admin',
        createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
        updatedAt: data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt) : null
      });
    }

    res.json({ ok: true, segments });
  } catch (e) {
    console.error('Failed to list segments:', e);
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

// 3. Preview Segment Rule Tree Real-Time
router.post('/preview', verifyToken, requireAdmin, async (req, res) => {
  const { rules } = req.body || {};
  try {
    const evalRes = await evaluateSegmentRules(rules || {});

    // Sample student preview (limit to top 15 for fast UI response)
    const sampleStudents = evalRes.matchingStudents.slice(0, 15).map(s => ({
      uid: s.uid,
      name: s.name,
      email: s.email,
      phone: s.phone,
      wbjeeYear: s.wbjeeYear,
      caste: s.caste,
      gender: s.gender,
      bestEngRank: s.bestEngRank,
      totalSpent: s.totalSpent
    }));

    res.json({
      ok: true,
      matchingCount: evalRes.matchingCount,
      recipientCount: evalRes.recipientEmails.length,
      sampleStudents
    });
  } catch (e) {
    console.error('Failed to preview segment:', e);
    res.status(500).json({ error: 'preview_failed', message: e.message });
  }
});

// 4. Create Saved Segment
router.post('/create', verifyToken, requireAdmin, async (req, res) => {
  const { name, description, rules } = req.body || {};
  if (!name || !rules) {
    return res.status(400).json({ error: 'missing_fields', message: 'Segment name and rules are required.' });
  }

  try {
    const segRef = db.collection('studentSegments').doc();
    const evalRes = await evaluateSegmentRules(rules).catch(() => ({ matchingCount: 0 }));

    await segRef.set({
      name: String(name).trim(),
      description: String(description || '').trim(),
      rules,
      recipientCount: evalRes.matchingCount,
      createdBy: req.user.email || 'Admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true, id: segRef.id, message: 'Segment saved successfully.' });
  } catch (e) {
    console.error('Failed to create segment:', e);
    res.status(500).json({ error: 'create_failed', message: e.message });
  }
});

// 5. Update Saved Segment
router.post('/update', verifyToken, requireAdmin, async (req, res) => {
  const { segmentId, name, description, rules } = req.body || {};
  if (!segmentId) return res.status(400).json({ error: 'missing_segmentId' });

  try {
    const segRef = db.collection('studentSegments').doc(segmentId);
    const docSnap = await segRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: 'not_found', message: 'Segment doc not found.' });
    }

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (name !== undefined) updates.name = String(name).trim();
    if (description !== undefined) updates.description = String(description).trim();
    if (rules !== undefined) {
      updates.rules = rules;
      const evalRes = await evaluateSegmentRules(rules).catch(() => ({ matchingCount: 0 }));
      updates.recipientCount = evalRes.matchingCount;
    }

    await segRef.update(updates);
    res.json({ ok: true, message: 'Segment updated successfully.' });
  } catch (e) {
    console.error('Failed to update segment:', e);
    res.status(500).json({ error: 'update_failed', message: e.message });
  }
});

// 6. Delete Segment
router.post('/delete', verifyToken, requireAdmin, async (req, res) => {
  const { segmentId } = req.body || {};
  if (!segmentId) return res.status(400).json({ error: 'missing_segmentId' });

  try {
    await db.collection('studentSegments').doc(segmentId).delete();
    res.json({ ok: true, message: 'Segment deleted successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed', message: e.message });
  }
});

module.exports = router;
