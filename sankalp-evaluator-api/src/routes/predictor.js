const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { db } = require('../firebase');
const { verifyToken } = require('../auth');
const { normalizePredictorSettings } = require('../predictor-settings');

const router = express.Router();

// ── Server-side settings cache (60-second TTL) ────────────────────────────────
// settings/college_predictor almost never changes, so we cache it in memory.
// On cache miss or after 60 s the value is re-read from Firestore.
let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_TTL_MS = 60_000; // 60 seconds

async function getCachedPredictorSettings() {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheAt) < SETTINGS_TTL_MS) {
    return _settingsCache;
  }
  const doc = await db.collection('settings').doc('college_predictor').get();
  _settingsCache = normalizePredictorSettings(doc.exists ? doc.data() : {});
  _settingsCacheAt = now;
  return _settingsCache;
}

// Call this after admin saves new settings so the cache refreshes immediately.
function bustSettingsCache() {
  _settingsCache = null;
  _settingsCacheAt = 0;
}

// Initialize SQLite database
const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
const sqliteDb = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite cutoffs database inside predictor.js:', err.message);
  } else {
    console.log('Connected to SQLite cutoffs database inside predictor.js');
  }
});
sqliteDb.configure("busyTimeout", 10000); // 10 seconds busy timeout to avoid SQLITE_BUSY


// Helper to check if a user is an admin or evaluator
function isAdminEmail(email) {
  const emails = new Set([
    'rohitgupta6294@gmail.com',
    'rahulgupta6294@gmail.com'
  ]);
  if (process.env.ADMIN_EMAILS) {
    process.env.ADMIN_EMAILS.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
      .forEach(e => emails.add(e));
  }
  return emails.has(String(email || '').toLowerCase());
}

async function userHasAccess(req) {
  try {
    // Admins and evaluators always have bypass access
    if (isAdminEmail(req.user.email) || req.user.admin === true || req.user.role === 'admin') {
      return true;
    }

    // Query settings (served from cache — see getCachedPredictorSettings)
    const data = await getCachedPredictorSettings();
    // If payment is not required, everyone has access
    if (!data.requiresPayment) {
      return true;
    }

    // Auto-reconcile any pending payments for the user
    try {
      const { autoReconcileUserPayments } = require('../payment-verifier');
      await autoReconcileUserPayments(req.user.uid);
    } catch (reconcileErr) {
      console.error('Auto-reconcile failed during access check:', reconcileErr);
    }

    // Check if user has a valid purchase document in Firestore
    const purchaseDoc = await db.collection('purchases').doc(`${req.user.uid}_college_predictor`).get();
    if (purchaseDoc.exists && purchaseDoc.data().status === 'success') {
      return true;
    }

    // Check if the user document itself designates them as admin or having purchased access
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.role === 'admin' || userData.role === 'evaluator' || userData.predictorUnlocked === true) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('Access check failed:', err);
    return false;
  }
}

// ── 1. Check Predictor Paywall & Access Status ────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const { enabled, requiresPayment, price } = await getCachedPredictorSettings();

    const hasAccess = enabled ? await userHasAccess(req) : false;

    res.json({
      enabled,
      requiresPayment,
      price,
      hasAccess
    });
  } catch (err) {
    res.status(500).json({ error: 'status_check_failed', message: err.message });
  }
});

// ── 2. Get Unique Caste Categories (Dynamic) ──────────────────────────────────
router.get('/categories', verifyToken, async (req, res) => {
  // Quick access check (can read categories list before paying to populate dropdown)
  sqliteDb.all('SELECT DISTINCT category FROM cutoffs ORDER BY category ASC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'categories_load_failed', message: err.message });
    }
    const categories = rows.map(r => r.category).filter(Boolean);
    res.json({ categories });
  });
});

// ── 3. Get Unique Seat Types (Dynamic) ────────────────────────────────────────
router.get('/seat-types', verifyToken, async (req, res) => {
  sqliteDb.all('SELECT DISTINCT seat_type FROM cutoffs ORDER BY seat_type ASC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'seat_types_load_failed', message: err.message });
    }
    const seatTypes = rows.map(r => r.seat_type).filter(Boolean);
    res.json({ seatTypes });
  });
});

// ── 4. Get Unique Quotas (Dynamic) ────────────────────────────────────────────
router.get('/quotas', verifyToken, async (req, res) => {
  sqliteDb.all('SELECT DISTINCT quota FROM cutoffs ORDER BY quota ASC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'quotas_load_failed', message: err.message });
    }
    const quotas = rows.map(r => r.quota).filter(Boolean);
    res.json({ quotas });
  });
});

// ── 5. Main Prediction Route with Access Safeguard ───────────────────────────
router.get('/predict', verifyToken, async (req, res) => {
  try {
    const { enabled } = await getCachedPredictorSettings();
    if (enabled === false) {
      return res.status(403).json({
        error: 'feature_disabled',
        message: 'College Predictor is currently disabled by the administrator.'
      });
    }

    const hasAccess = await userHasAccess(req);
    if (!hasAccess) {
      return res.status(402).json({
        error: 'payment_required',
        message: 'Please unlock the Premium College Predictor to perform predictions.'
      });
    }

    const { rank, category, courseType, collegeType, seatType, quota } = req.query;
    const R = Number(rank);
    if (isNaN(R) || R <= 0) {
      return res.status(400).json({ error: 'invalid_rank', message: 'Please enter a valid positive rank number.' });
    }
    if (!category) {
      return res.status(400).json({ error: 'missing_category', message: 'Please specify a reservation category.' });
    }

    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota,
             COALESCE(MAX(CASE WHEN year = 2025 AND round = 2 THEN closing_rank END),
                      MAX(CASE WHEN year = 2025 AND round = 1 THEN closing_rank END),
                      MAX(CASE WHEN year = 2025 THEN closing_rank END)) AS closing_rank_2025,
             COALESCE(MAX(CASE WHEN year = 2024 AND round = 2 THEN closing_rank END),
                      MAX(CASE WHEN year = 2024 AND round = 1 THEN closing_rank END),
                      MAX(CASE WHEN year = 2024 THEN closing_rank END)) AS closing_rank_2024
      FROM cutoffs
      WHERE category = ?
      GROUP BY institute, program, seat_type, quota
    `, [category], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'prediction_failed', message: err.message });
      }

      const results = [];
      let totalMatches = 0;
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;

      for (const row of rows) {
        const c2025 = row.closing_rank_2025;
        const c2024 = row.closing_rank_2024;
        const latest_cutoff = c2025 !== null && c2025 !== undefined ? c2025 : c2024;

        if (!latest_cutoff) continue;

        // Apply filters
        // Course Type: B.Tech, B.Pharm, All
        if (courseType && courseType !== 'All') {
          const isPharm = String(row.stream).toLowerCase().includes('pharma') || String(row.program).toLowerCase().includes('pharma');
          if (courseType === 'B.Pharm' && !isPharm) continue;
          if (courseType === 'B.Tech' && isPharm) continue;
        }

        // College Type Filters: GovtGroup, PrivateGroup, specific types, All
        if (collegeType && collegeType !== 'All') {
          const isGovtType = [
            'University/University Department',
            'State Government Engineering College',
            'State Government Pharmacy College',
            'Central Government Engineering College'
          ].includes(row.college_type);
          
          const isPrivateType = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(row.college_type);
          
          if (collegeType === 'GovtGroup' && !isGovtType) continue;
          else if (collegeType === 'PrivateGroup' && !isPrivateType) continue;
          else if (collegeType !== 'GovtGroup' && collegeType !== 'PrivateGroup' && row.college_type !== collegeType) continue;
        }

        // Seat Type Filter: Specific, or All
        if (seatType && seatType !== 'All') {
          if (row.seat_type !== seatType) continue;
        }

        // Quota Filter: Specific, or All
        if (quota && quota !== 'All') {
          if (row.quota !== quota) continue;
        }

        // Probability prediction logic:
        let chance = '';
        let chanceSort = 0;
        
        if (R <= latest_cutoff) {
          chance = 'High';
          chanceSort = 1;
          highCount++;
        } else if (R <= latest_cutoff * 1.10) {
          chance = 'Medium';
          chanceSort = 2;
          mediumCount++;
        } else if (R <= latest_cutoff * 1.25) {
          chance = 'Low';
          chanceSort = 3;
          lowCount++;
        } else {
          continue; // Exclude if too high
        }

        totalMatches++;

        results.push({
          institute: row.institute,
          program: row.program,
          stream: row.stream,
          collegeType: row.college_type,
          seatType: row.seat_type,
          quota: row.quota,
          closingRank2025: c2025 || '—',
          closingRank2024: c2024 || '—',
          latestCutoff: latest_cutoff,
          chance,
          chanceSort
        });
      }

      // Sort purely by latest closing rank ascending (closest rank shows first)
      results.sort((a, b) => a.latestCutoff - b.latestCutoff);

      res.json({
        ok: true,
        stats: {
          totalMatches,
          highCount,
          mediumCount,
          lowCount
        },
        results
      });
    });
  } catch (e) {
    res.status(500).json({ error: 'prediction_failed', message: e.message });
  }
});

router.bustSettingsCache = bustSettingsCache;
module.exports = router;
