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

// ── WBJEE 2026 ORCR Public Routes ──────────────────────────────────────────
router.get('/orcr2026/colleges', async (_req, res) => {
  sqliteDb.all('SELECT DISTINCT institute FROM orcr2026 ORDER BY institute ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'load_colleges_failed', message: err.message });
    res.json({ colleges: rows.map(r => r.institute).filter(Boolean) });
  });
});

router.get('/orcr2026/branches', async (req, res) => {
  const { college } = req.query;
  let sql = 'SELECT DISTINCT program FROM orcr2026';
  const params = [];
  if (college && college !== 'All') {
    sql += ' WHERE institute = ?';
    params.push(college);
  }
  sql += ' ORDER BY program ASC';

  sqliteDb.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'load_branches_failed', message: err.message });
    res.json({ branches: rows.map(r => r.program).filter(Boolean) });
  });
});

router.get('/orcr2026/categories', async (req, res) => {
  const { college, branch } = req.query;
  let sql = 'SELECT DISTINCT category FROM orcr2026 WHERE 1=1';
  const params = [];
  if (college && college !== 'All') {
    sql += ' AND institute = ?';
    params.push(college);
  }
  if (branch && branch !== 'All') {
    sql += ' AND program = ?';
    params.push(branch);
  }
  sql += ' ORDER BY category ASC';

  sqliteDb.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'load_categories_failed', message: err.message });
    res.json({ categories: rows.map(r => r.category).filter(Boolean) });
  });
});

router.get('/orcr2026/cutoffs', async (req, res) => {
  const { college, branch, category } = req.query;
  let sql = 'SELECT * FROM orcr2026 WHERE 1=1';
  const params = [];
  if (college && college !== 'All') {
    sql += ' AND institute = ?';
    params.push(college);
  }
  if (branch && branch !== 'All') {
    sql += ' AND program = ?';
    params.push(branch);
  }
  if (category && category !== 'All') {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY institute ASC, program ASC, category ASC, round ASC';

  sqliteDb.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'load_cutoffs_failed', message: err.message });
    res.json({ cutoffs: rows });
  });
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
  // Exclude JEE(Main) Seats — different ranking system, not comparable with WBJEE GMR
  sqliteDb.all("SELECT DISTINCT seat_type FROM cutoffs WHERE seat_type != 'JEE(Main) Seats' ORDER BY seat_type ASC", [], (err, rows) => {
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

// ── 4b. Get Unique Years (Dynamic) ──────────────────────────────────────────
router.get('/years', verifyToken, async (req, res) => {
  sqliteDb.all('SELECT DISTINCT year FROM cutoffs ORDER BY year DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'years_load_failed', message: err.message });
    }
    const years = rows.map(r => r.year).filter(y => y !== null && y !== undefined);
    res.json({ years });
  });
});

// Helper to normalize program names to a standard clean display name and TFW status
function getNormalizedProgram(rawProgram, institute = '') {
  if (!rawProgram) return { name: 'General', isTfw: false };

  let p = rawProgram.toUpperCase().trim().replace(/\s+/g, ' ');
  
  // Detect TFW from program name
  const isTfw = p.includes('TFW') || p.includes('TUITION FEE WAIVER');
  
  // Strip TFW indicators
  p = p.replace(/\(?\s*TFW\s*\)?/g, '');
  p = p.replace(/WITH\s*TFW/g, '');
  p = p.replace(/-\s*$/g, ''); // strip trailing dash if any
  p = p.trim();

  // If the college is Jadavpur University, force Electronics & Communication (ECE) / Electronics & Telecommunication (ETCE)
  // to normalize to "Electronics & Telecommunication Engineering" (ETCE).
  const instUpper = String(institute || '').toUpperCase().trim();
  const isJu = instUpper.includes('JADAVPUR UNIVERSITY');
  if (isJu) {
    if (p.includes('ELECTRONICS & COMMUNICATION') || p.includes('ELECTRONICS AND COMMUNICATION') ||
        p.includes('ELECTRONICS & TELECOMMUNICATION') || p.includes('ELECTRONICS AND TELECOMMUNICATION') ||
        p.includes('ELECTRONICS & TELE-COMMUNICATION') || p.includes('ELECTRONICS AND TELE-COMMUNICATION')) {
      return { name: 'Electronics & Telecommunication Engineering', isTfw };
    }
  }

  // Normalize specific names to standard forms
  if (p === 'COMPUTER SCIENCE & ENGINEERING' || p === 'COMPUTER SCIENCE AND ENGINEERING') {
    return { name: 'Computer Science & Engineering', isTfw };
  }
  if (p === 'COMPUTER SCIENCE & TECHNOLOGY' || p === 'COMPUTER SCIENCE AND TECHNOLOGY') {
    return { name: 'Computer Science & Technology', isTfw };
  }
  if (p === 'INFORMATION TECHNOLOGY') {
    return { name: 'Information Technology', isTfw };
  }
  if (p === 'CIVIL ENGINEERING') {
    return { name: 'Civil Engineering', isTfw };
  }
  if (p === 'CIVIL AND ENVIRONMENTAL ENGINEERING') {
    return { name: 'Civil & Environmental Engineering', isTfw };
  }
  if (p === 'CHEMICAL ENGINEERING') {
    return { name: 'Chemical Engineering', isTfw };
  }
  if (p === 'MECHANICAL ENGINEERING') {
    return { name: 'Mechanical Engineering', isTfw };
  }
  if (p === 'ELECTRICAL ENGINEERING' || p === 'ELECTRICAL') {
    return { name: 'Electrical Engineering', isTfw };
  }
  if (p === 'ELECTRICAL & ELECTRONICS ENGINEERING' || p === 'ELECTRICAL AND ELECTRONICS ENGINEERING') {
    return { name: 'Electrical & Electronics Engineering', isTfw };
  }
  if (p === 'PRODUCTION ENGINEERING') {
    return { name: 'Production Engineering', isTfw };
  }
  
  // ECE and ETCE
  if (p.includes('ELECTRONICS & COMMUNICATION') || p.includes('ELECTRONICS AND COMMUNICATION')) {
    if (p.includes('VLSI')) {
      return { name: 'Electronics & Communication Engineering (VLSI Design)', isTfw };
    }
    if (p.includes('INDUSTRY')) {
      return { name: 'Electronics & Communication Engineering (Industry Integrated)', isTfw };
    }
    return { name: 'Electronics & Communication Engineering', isTfw };
  }
  if (p.includes('ELECTRONICS & TELECOMMUNICATION') || p.includes('ELECTRONICS AND TELECOMMUNICATION') || 
      p.includes('ELECTRONICS & TELE-COMMUNICATION') || p.includes('ELECTRONICS AND TELE-COMMUNICATION')) {
    return { name: 'Electronics & Telecommunication Engineering', isTfw };
  }
  
  // AEIE & EIE
  if (p.includes('APPLIED ELECTRONICS') && p.includes('INSTRUMENTATION')) {
    return { name: 'Applied Electronics & Instrumentation Engineering', isTfw };
  }
  if (p.includes('ELECTRONICS') && p.includes('INSTRUMENTATION')) {
    return { name: 'Electronics & Instrumentation Engineering', isTfw };
  }
  
  // Instrumentation & Electronics (JU specific and others)
  if (p.includes('INSTRUMENTATION ENGINEERING') || p.includes('INSTRUMENTATION & ELECTRONICS') || p.includes('INSTRUMENTATION AND ELECTRONICS')) {
    if (p.includes('ELECTRONICS')) {
      return { name: 'Instrumentation & Electronics Engineering', isTfw };
    }
    return { name: 'Instrumentation Engineering', isTfw };
  }

  // Printing
  if (p.includes('PRINTING')) {
    return { name: 'Printing Engineering', isTfw };
  }

  // Food
  if (p.includes('FOOD')) {
    if (p.includes('BIO CHEMICAL') || p.includes('BIOCHEMICAL')) {
      return { name: 'Food Technology & Biochemical Engineering', isTfw };
    }
    return { name: 'Food Technology', isTfw };
  }

  // Power
  if (p.includes('POWER')) {
    return { name: 'Power Engineering', isTfw };
  }

  // Construction
  if (p.includes('CONSTRUCTION')) {
    return { name: 'Construction Engineering', isTfw };
  }

  // Metallurgical
  if (p.includes('METALLURGICAL')) {
    return { name: 'Metallurgical & Materials Engineering', isTfw };
  }

  // Ceramic
  if (p.includes('CERAMIC')) {
    return { name: 'Ceramic Engineering & Technology', isTfw };
  }

  // Biotechnology & Biomedical
  if (p.includes('BIOTECHNOLOGY')) {
    return { name: 'Biotechnology', isTfw };
  }
  if (p.includes('BIOMEDICAL')) {
    return { name: 'Biomedical Engineering', isTfw };
  }

  // Pharmacy
  if (p.includes('PHARMACY') || p.includes('PHARMACEUTICAL') || p.includes('B.PHARM')) {
    return { name: 'Pharmaceutical Technology', isTfw };
  }

  // AI & DS / ML
  if (p.includes('ARTIFICIAL INTELLIGENCE') || p.includes('DATA SCIENCE') || p.includes('MACHINE LEARNING')) {
    const hasAi = p.includes('ARTIFICIAL') || p.includes('AI');
    const hasDs = p.includes('DATA SCIENCE') || p.includes('DS');
    const hasMl = p.includes('MACHINE LEARNING') || p.includes('ML');
    
    if (hasAi && hasDs) return { name: 'Artificial Intelligence & Data Science', isTfw };
    if (hasAi && hasMl) return { name: 'Artificial Intelligence & Machine Learning', isTfw };
    if (hasAi) return { name: 'Artificial Intelligence', isTfw };
    if (hasDs) return { name: 'Data Science', isTfw };
  }

  // CS specializations
  if (p.includes('COMPUTER SCIENCE')) {
    if (p.includes('BUSINESS') || p.includes('CSBS')) {
      return { name: 'Computer Science & Business System', isTfw };
    }
    if (p.includes('DESIGN')) {
      return { name: 'Computer Science & Design', isTfw };
    }
    if (p.includes('APPLIED MATHEMATICS')) {
      return { name: 'Computer Science & Applied Mathematics', isTfw };
    }
    if (p.includes('INFORMATION TECHNOLOGY')) {
      return { name: 'Computer Science & Information Technology', isTfw };
    }
    if (p.includes('CYBER')) {
      return { name: 'Computer Science & Engineering (Cyber Security)', isTfw };
    }
    if (p.includes('IOT') || p.includes('INTERNET OF THINGS')) {
      if (p.includes('BLOCK') || p.includes('CHAIN')) {
        return { name: 'Computer Science & Engineering (IoT & Cyber Security)', isTfw };
      }
      return { name: 'Computer Science & Engineering (IoT)', isTfw };
    }
    if (p.includes('ROBOTICS')) {
      return { name: 'Computer Science & Engineering (Robotics & AI)', isTfw };
    }
    if (p.includes('NETWORKS')) {
      return { name: 'Computer Science & Engineering (Networks)', isTfw };
    }
  }

  // Standard Title Case helper for any others
  return { 
    name: p.split(' ')
           .map(w => w.charAt(0) + w.slice(1).toLowerCase())
           .join(' '), 
    isTfw 
  };
}

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

    const { rank, category, courseType, collegeType, seatType, quota, year } = req.query;
    let targetYear = year ? String(year).trim() : '2025';
    const yearMatch = targetYear.match(/^(\d{4})\b/);
    let parsedYear = 2025;
    if (yearMatch) {
      parsedYear = parseInt(yearMatch[1], 10);
    } else {
      targetYear = '2025';
    }
    const prevYear = parsedYear - 1;
    const R = Number(rank);
    if (isNaN(R) || R <= 0) {
      return res.status(400).json({ error: 'invalid_rank', message: 'Please enter a valid positive rank number.' });
    }
    if (!category) {
      return res.status(400).json({ error: 'missing_category', message: 'Please specify a reservation category.' });
    }

    // IMPORTANT: Exclude JEE(Main) Seats — they use JEE Main AIR ranks (a completely
    // different ranking system) that cannot be compared against WBJEE GMR ranks.
    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
      FROM cutoffs
      WHERE category = ?
        AND seat_type != 'JEE(Main) Seats'
    `, [category], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'prediction_failed', message: err.message });
      }

      const grouped = {};
      rows.forEach(row => {
        const norm = getNormalizedProgram(row.program, row.institute);
        const normalizedProgramName = norm.name;
        const isRowTfw = norm.isTfw || String(row.category).toUpperCase().includes('TFW') || String(row.seat_type).toUpperCase().includes('TFW');
        
        // Consistent key ensuring case normalization and separate TFW vs Open choices
        const key = `${row.institute}|${normalizedProgramName}|${isRowTfw ? 'TFW' : 'OPEN'}|${row.quota}`;
        
        if (!grouped[key]) {
          grouped[key] = {
            institute: row.institute,
            program: normalizedProgramName,
            stream: (row.stream || '').replace('/JEE(Main) Seats', '').replace('(JEE(Main) Seats)', '').replace('()', '').trim(),
            college_type: row.college_type,
            seat_type: isRowTfw ? 'TFW' : row.seat_type,
            quota: row.quota,
            isTfw: isRowTfw,
            cutoffs: {},
            rounds: {}
          };
        }
        
        const currentCutoff = row.closing_rank;
        const currentRound = row.round || 0;
        const existingRound = grouped[key].rounds[row.year] || 0;
        
        if (grouped[key].cutoffs[row.year] === undefined || 
            (currentRound === 2 && existingRound !== 2) || 
            (currentRound > existingRound && existingRound !== 2)) {
          grouped[key].cutoffs[row.year] = currentCutoff;
          grouped[key].rounds[row.year] = currentRound;
        }
      });

      const results = [];
      let totalMatches = 0;
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;

      Object.keys(grouped).forEach(key => {
        const item = grouped[key];
        const target_cutoff = item.cutoffs[targetYear];
        const prev_cutoff = item.cutoffs[prevYear];

        if (!target_cutoff) return;

        // Apply filters
        // Course Type: B.Tech, B.Pharm, All
        if (courseType && courseType !== 'All') {
          const isPharm = String(item.stream).toLowerCase().includes('pharma') || String(item.program).toLowerCase().includes('pharma');
          if (courseType === 'B.Pharm' && !isPharm) return;
          if (courseType === 'B.Tech' && isPharm) return;
        }

        // College Type Filters: GovtGroup, PrivateGroup, specific types, All
        if (collegeType && collegeType !== 'All') {
          const isGovtType = [
            'University/University Department',
            'State Government Engineering College',
            'State Government Pharmacy College',
            'Central Government Engineering College'
          ].includes(item.college_type);
          
          const isPrivateType = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(item.college_type);
          
          if (collegeType === 'GovtGroup' && !isGovtType) return;
          else if (collegeType === 'PrivateGroup' && !isPrivateType) return;
          else if (collegeType !== 'GovtGroup' && collegeType !== 'PrivateGroup' && item.college_type !== collegeType) return;
        }

        // Seat Type Filter: Specific, or All
        if (seatType && seatType !== 'All') {
          if (seatType === 'WBJEE Seats') {
            if (item.seat_type !== 'WBJEE Seats' && item.seat_type !== 'TFW') return;
          } else {
            if (item.seat_type !== seatType) return;
          }
        }

        // Quota Filter: Specific, or All
        // Private colleges are accessible to both Home State and All India students
        // (general seats in private colleges don't require WB domicile).
        if (quota && quota !== 'All') {
          const isPrivateCollege = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(item.college_type);

          if (!isPrivateCollege && item.quota !== quota) return;
        }

        // Probability prediction logic:
        let chance = '';
        let chanceSort = 0;
        
        if (R <= target_cutoff) {
          chance = 'High';
          chanceSort = 1;
          highCount++;
        } else if (R <= target_cutoff * 1.10) {
          chance = 'Medium';
          chanceSort = 2;
          mediumCount++;
        } else if (R <= target_cutoff * 1.25) {
          chance = 'Low';
          chanceSort = 3;
          lowCount++;
        } else {
          return; // Exclude if too high
        }

        totalMatches++;

        results.push({
          institute: item.institute,
          program: item.program,
          stream: item.stream,
          collegeType: item.college_type,
          seatType: item.seat_type,
          quota: item.quota,
          selectedYear: targetYear,
          prevYear: prevYear,
          closingRank2025: target_cutoff || '—',
          closingRank2024: prev_cutoff || '—',
          latestCutoff: target_cutoff,
          cutoffs: item.cutoffs,
          chance,
          chanceSort
        });
      });

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
