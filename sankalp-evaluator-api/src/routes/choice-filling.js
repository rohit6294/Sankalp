const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { db } = require('../firebase');
const { verifyToken } = require('../auth');
const { normalizePredictorSettings } = require('../predictor-settings');

const router = express.Router();

// Initialize SQLite database
const dbPath = path.join(__dirname, '..', '..', 'cutoffs.db');
const sqliteDb = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite cutoffs database inside choice-filling.js:', err.message);
  } else {
    console.log('Connected to SQLite cutoffs database inside choice-filling.js');
  }
});
sqliteDb.configure("busyTimeout", 10000);

// Helper to check if user is admin
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

// Access check for Choice Filling
async function userHasChoiceAccess(req) {
  try {
    if (isAdminEmail(req.user.email) || req.user.admin === true || req.user.role === 'admin') {
      return true;
    }

    const doc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(doc.exists ? doc.data() : {});
    if (!settings.choiceFillingEnabled) {
      return false;
    }
    if (!settings.choiceFillingRequiresPayment) {
      return true;
    }

    // Auto-reconcile payments
    try {
      const { autoReconcileUserPayments } = require('../payment-verifier');
      await autoReconcileUserPayments(req.user.uid);
    } catch (reconcileErr) {
      console.error('Auto-reconcile failed during choice access check:', reconcileErr);
    }

    // Check purchase status in Firestore
    const purchaseDoc = await db.collection('purchases').doc(`${req.user.uid}_choice_filling`).get();
    if (purchaseDoc.exists && purchaseDoc.data().status === 'success') {
      return true;
    }

    // Check user profile attributes
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.role === 'admin' || userData.role === 'evaluator' || userData.choiceFillingUnlocked === true) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('Choice access check failed:', err);
    return false;
  }
}

// Helper to generate a realistic choice code
function generateChoiceCode(institute, program) {
  const cleanInst = institute.toUpperCase()
    .replace(/GOVERNMENT/g, 'GOVT')
    .replace(/INSTITUTE OF TECHNOLOGY/g, 'IT')
    .replace(/AND/g, '&')
    .replace(/[^A-Z0-9& ]/g, '')
    .split(' ')
    .filter(w => w.length > 0);
  
  let instInitials = '';
  if (cleanInst.length >= 2) {
    instInitials = cleanInst.map(w => w[0]).join('').substring(0, 4);
  } else if (cleanInst.length === 1) {
    instInitials = cleanInst[0].substring(0, 4);
  } else {
    instInitials = 'INST';
  }

  let progCode = 'GEN';
  const prog = program.toUpperCase();
  if (prog.includes('COMPUTER SCIENCE') || prog.includes('CSE')) progCode = 'CSE';
  else if (prog.includes('INFORMATION TECHNOLOGY') || prog.includes('IT')) progCode = 'IT';
  else if (prog.includes('ELECTRONICS') || prog.includes('ECE')) progCode = 'ECE';
  else if (prog.includes('ELECTRICAL') || prog.includes('EE')) progCode = 'EE';
  else if (prog.includes('MECHANICAL') || prog.includes('ME')) progCode = 'ME';
  else if (prog.includes('CIVIL') || prog.includes('CE')) progCode = 'CE';
  else if (prog.includes('CHEMICAL') || prog.includes('CH')) progCode = 'CHE';
  else if (prog.includes('PHARMACY') || prog.includes('PHARM')) progCode = 'PHM';

  return `${instInitials}-${progCode}`;
}

// ── 1. Choice Filling Feature Status ──────────────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(doc.exists ? doc.data() : {});
    const hasAccess = settings.choiceFillingEnabled ? await userHasChoiceAccess(req) : false;

    res.json({
      enabled: settings.choiceFillingEnabled,
      requiresPayment: settings.choiceFillingRequiresPayment,
      price: settings.choiceFillingPrice,
      hasAccess
    });
  } catch (err) {
    res.status(500).json({ error: 'cf_status_failed', message: err.message });
  }
});

// ── 2. Generate Optimized Choice Filling List ────────────────────────────────
router.post('/predict', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(doc.exists ? doc.data() : {});

    if (!settings.choiceFillingEnabled) {
      return res.status(403).json({
        error: 'feature_disabled',
        message: 'Choice Filling Preference Assistant is currently disabled.'
      });
    }

    const hasAccess = await userHasChoiceAccess(req);
    if (!hasAccess) {
      return res.status(402).json({
        error: 'payment_required',
        message: 'Please unlock the Choice Filling Preference Assistant to generate your preference list.'
      });
    }

    const { rank, category, quota, tfw, branches, collegeType, maxChoices = 30 } = req.body;
    const R = Number(rank);

    if (isNaN(R) || R <= 0) {
      return res.status(400).json({ error: 'invalid_rank', message: 'Please enter a valid positive GMR rank.' });
    }
    if (!category) {
      return res.status(400).json({ error: 'missing_category', message: 'Please specify your reservation category.' });
    }

    // Query SQLite database for categories
    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
      FROM cutoffs
      WHERE category = ?
    `, [category], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'query_failed', message: err.message });
      }

      const grouped = {};
      rows.forEach(row => {
        const key = `${row.institute}|${row.program}|${row.seat_type}|${row.quota}`;
        if (!grouped[key]) {
          grouped[key] = {
            institute: row.institute,
            program: row.program,
            stream: row.stream,
            college_type: row.college_type,
            seat_type: row.seat_type,
            quota: row.quota,
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

      const processedChoices = [];
      const branchFilters = Array.isArray(branches) ? branches : [];

      Object.keys(grouped).forEach(key => {
        const item = grouped[key];

        // 1. Quota filter
        if (quota && quota !== 'All') {
          if (item.quota !== quota) return;
        }

        // 2. TFW (Tuition Fee Waiver) filter:
        // In WBJEE, TFW is a separate seat_type.
        // If student toggles TFW = Yes, they can select both Open and TFW seats.
        // If TFW = No, they should NOT have TFW seats in their list.
        const isTfwSeat = String(item.seat_type).toUpperCase().includes('TFW');
        if (isTfwSeat && (!tfw || tfw === 'false' || tfw === false)) {
          return; // Exclude TFW seats if student is not eligible
        }

        // 3. College Type filter
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
          if (collegeType === 'PrivateGroup' && !isPrivateType) return;
          if (collegeType !== 'GovtGroup' && collegeType !== 'PrivateGroup' && item.college_type !== collegeType) return;
        }

        // 4. Branch/Stream filter
        if (branchFilters.length > 0) {
          const streamText = String(item.stream || item.program).toUpperCase();
          const matchesBranch = branchFilters.some(b => {
            const bUpper = String(b).toUpperCase();
            if (bUpper === 'CSE') {
              return streamText.includes('COMPUTER SCIENCE') || streamText.includes('CSE') || streamText.includes('COMP. SC.');
            }
            if (bUpper === 'IT') {
              return streamText.includes('INFORMATION TECHNOLOGY') || streamText.includes('IT');
            }
            if (bUpper === 'ECE') {
              return streamText.includes('ELECTRONICS') || streamText.includes('ECE') || streamText.includes('TELECOMMUNICATION');
            }
            if (bUpper === 'EE') {
              return streamText.includes('ELECTRICAL') || streamText.includes('EE');
            }
            if (bUpper === 'ME') {
              return streamText.includes('MECHANICAL') || streamText.includes('ME');
            }
            if (bUpper === 'CE') {
              return streamText.includes('CIVIL') || streamText.includes('CE');
            }
            if (bUpper === 'CHE') {
              return streamText.includes('CHEMICAL') || streamText.includes('CHE');
            }
            if (bUpper === 'PHM') {
              return streamText.includes('PHARMACY') || streamText.includes('PHARMA');
            }
            return streamText.includes(bUpper);
          });

          if (!matchesBranch) return;
        }

        // Get cutoffs for stability calculation
        const yearsWithData = Object.keys(item.cutoffs).map(Number).sort((a, b) => b - a);
        if (yearsWithData.length === 0) return;

        // Base cutoff is the most recent year's cutoff
        const latestYear = yearsWithData[0];
        const baseCutoff = item.cutoffs[latestYear];

        // Multi-year weighted stability cutoff
        let weightedCutoff = baseCutoff;
        if (yearsWithData.length >= 2) {
          const prevYear = yearsWithData[1];
          const prevCutoff = item.cutoffs[prevYear];
          weightedCutoff = Math.round((baseCutoff * 0.7) + (prevCutoff * 0.3));
        }

        // Tier classification:
        // Dream: closing rank is less than student rank (very hard to get)
        // Target: closing rank is close to student rank (up to 15% above student rank)
        // Safety: closing rank is much higher than student rank (more than 15% above)
        let tier = 'Safety';
        let chance = 'High';
        if (baseCutoff < R) {
          tier = 'Dream';
          chance = 'Low';
        } else if (baseCutoff <= R * 1.15) {
          tier = 'Target';
          chance = 'Medium';
        }

        processedChoices.push({
          institute: item.institute,
          program: item.program,
          stream: item.stream,
          collegeType: item.college_type,
          seatType: item.seat_type,
          quota: item.quota,
          baseCutoff,
          weightedCutoff,
          latestYear,
          tier,
          chance,
          choiceCode: generateChoiceCode(item.institute, item.program),
          cutoffs: item.cutoffs
        });
      });

      // Gold Standard Sorting Rule:
      // Sort strictly by baseCutoff ascending (i.e. most competitive first), regardless of tier!
      // Jadavpur CSE (cutoff 80) is ALWAYS above Heritage CSE (cutoff 3200).
      processedChoices.sort((a, b) => a.baseCutoff - b.baseCutoff);

      // Truncate list to the requested size
      const finalChoices = processedChoices.slice(0, Number(maxChoices));

      // Safety Net Auditor: Check if the list contains at least 3 "Safety" choices
      const safetyCount = finalChoices.filter(c => c.tier === 'Safety').length;
      const requiresSafeties = safetyCount < 3;

      // Generate suggested backup choices if needed
      let suggestedBackups = [];
      if (requiresSafeties) {
        // Find all safety choices that were excluded (ranks 1.2x to 2.5x of student rank)
        const allSafeties = processedChoices.filter(c => c.tier === 'Safety');
        suggestedBackups = allSafeties
          .filter(c => !finalChoices.some(fc => fc.institute === c.institute && fc.program === c.program))
          .slice(0, 3);
      }

      res.json({
        ok: true,
        summary: {
          totalGenerated: finalChoices.length,
          dreamCount: finalChoices.filter(c => c.tier === 'Dream').length,
          targetCount: finalChoices.filter(c => c.tier === 'Target').length,
          safetyCount,
          insufficientSafeties: requiresSafeties
        },
        choices: finalChoices,
        suggestedBackups
      });
    });

  } catch (e) {
    res.status(500).json({ error: 'generation_failed', message: e.message });
  }
});

module.exports = router;
