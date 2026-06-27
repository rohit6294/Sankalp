const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { db, admin } = require('../firebase');
const { verifyToken } = require('../auth');
const { normalizePredictorSettings } = require('../predictor-settings');
const { getCollegeMetadata } = require('../college-metadata');

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
    // Admins and evaluators always have access
    if (isAdminEmail(req.user.email) || req.user.admin === true || req.user.role === 'admin' || req.user.role === 'evaluator') {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    const doc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(doc.exists ? doc.data() : {});
    if (!settings.choiceFillingEnabled) {
      return { hasAccess: false, unlimited: false, attemptsLeft: 0 };
    }
    
    // Choice filling is free if predictor paywall is disabled or choice filling paywall is disabled
    if (!settings.requiresPayment || !settings.choiceFillingRequiresPayment) {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    // Auto-reconcile any pending payments for the user
    try {
      const { autoReconcileUserPayments } = require('../payment-verifier');
      await autoReconcileUserPayments(req.user.uid);
    } catch (reconcileErr) {
      console.error('Auto-reconcile failed during choice access check:', reconcileErr);
    }

    // Check if they have purchased or unlocked the College Predictor in the purchases collection
    const predPurchaseDoc = await db.collection('purchases').doc(`${req.user.uid}_college_predictor`).get();
    if (predPurchaseDoc.exists && predPurchaseDoc.data().status === 'success') {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    // Check user profile attributes
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    // Check if they have purchased or unlocked the College Predictor via user doc flags
    if (userData.predictorPurchased === true || userData.predictorUnlocked === true) {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    if (userData.role === 'admin' || userData.role === 'evaluator') {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    // Check if they have unlimited access (legacy choice filling purchase)
    if (userData.choiceFillingUnlimited === true || userData.choiceFillingAttemptsLeft === -1) {
      return { hasAccess: true, unlimited: true, attemptsLeft: 9999 };
    }

    // Check if they have attempts left (legacy choice filling purchase)
    let attemptsLeft = (userData.choiceFillingAttemptsLeft !== undefined && userData.choiceFillingAttemptsLeft !== null)
      ? Number(userData.choiceFillingAttemptsLeft)
      : null;

    if (attemptsLeft !== null && attemptsLeft > 0) {
      return { hasAccess: true, unlimited: false, attemptsLeft };
    }

    // If attemptsLeft is null or 0, check if they have a successful legacy choice filling purchase
    const purchaseDoc = await db.collection('purchases').doc(`${req.user.uid}_choice_filling`).get();
    if (purchaseDoc.exists && purchaseDoc.data().status === 'success') {
      // If they have a purchase, but attemptsLeft is null, initialize it to the configured attempts!
      if (attemptsLeft === null) {
        const maxAttempts = settings.choiceFillingMaxAttempts || 30;
        await db.collection('users').doc(req.user.uid).set({
          choiceFillingUnlocked: true,
          choiceFillingAttemptsLeft: maxAttempts
        }, { merge: true });
        return { hasAccess: true, unlimited: false, attemptsLeft: maxAttempts };
      }
    }

    return { hasAccess: false, unlimited: false, attemptsLeft: 0 };
  } catch (err) {
    console.error('Choice access check failed:', err);
    return { hasAccess: false, unlimited: false, attemptsLeft: 0 };
  }
}

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

// Helper to match a normalized program name to its standard abbreviation
function getBranchCode(normalizedProgram) {
  const p = normalizedProgram.toUpperCase().trim();
  
  const mappings = {
    'COMPUTER SCIENCE & ENGINEERING': 'CSE',
    'COMPUTER SCIENCE AND ENGINEERING': 'CSE',
    'COMPUTER SCIENCE & TECHNOLOGY': 'CST',
    'COMPUTER SCIENCE AND TECHNOLOGY': 'CST',
    'INFORMATION TECHNOLOGY': 'IT',
    'CIVIL ENGINEERING': 'CE',
    'CIVIL & ENVIRONMENTAL ENGINEERING': 'CEE',
    'CIVIL AND ENVIRONMENTAL ENGINEERING': 'CEE',
    'CHEMICAL ENGINEERING': 'CHE',
    'MECHANICAL ENGINEERING': 'ME',
    'ELECTRICAL ENGINEERING': 'EE',
    'ELECTRICAL & ELECTRONICS ENGINEERING': 'EEE',
    'ELECTRICAL AND ELECTRONICS ENGINEERING': 'EEE',
    'ELECTRONICS & COMMUNICATION ENGINEERING': 'ECE',
    'ELECTRONICS AND COMMUNICATION ENGINEERING': 'ECE',
    'ELECTRONICS & COMMUNICATION ENGINEERING (INDUSTRY INTEGRATED)': 'ECE-II',
    'ELECTRONICS & COMMUNICATION ENGINEERING (VLSI DESIGN)': 'ECE-VLSI',
    'ELECTRONICS & TELECOMMUNICATION ENGINEERING': 'ETCE',
    'ELECTRONICS AND TELECOMMUNICATION ENGINEERING': 'ETCE',
    'ELECTRONICS & TELE-COMMUNICATION ENGINEERING': 'ETCE',
    'ELECTRONICS AND TELE-COMMUNICATION ENGINEERING': 'ETCE',
    'APPLIED ELECTRONICS & INSTRUMENTATION ENGINEERING': 'AEIE',
    'APPLIED ELECTRONICS AND INSTRUMENTATION ENGINEERING': 'AEIE',
    'ELECTRONICS & INSTRUMENTATION ENGINEERING': 'EIE',
    'ELECTRONICS AND INSTRUMENTATION ENGINEERING': 'EIE',
    'ELECTRONICS & COMPUTER SCIENCE': 'ECS',
    'ELECTRONICS AND COMPUTER SCIENCE': 'ECS',
    'ELECTRONICS AND COMPUTER SCIENCE (ECS)': 'ECS',
    'ELECTRONICS AND COMPUTER SCIENCE (ESC)': 'ECS',
    'ELECTRONICS ENGINEERING (VLSI DESIGN AND TECHNOLOGY)': 'VLSI',
    'INSTRUMENTATION ENGINEERING': 'IE',
    'INSTRUMENTATION ENGINEERING/INSTRUMENTATION & ELECTRONICS ENGINEERING': 'IEE',
    'INSTRUMENTATION & ELECTRONICS ENGINEERING': 'IEE',
    'INSTRUMENTATION AND ELECTRONICS ENGINEERING': 'IEE',
    'INSTRUMENTATION & ELECTRONICS': 'IEE',
    'PRODUCTION ENGINEERING': 'PE',
    'POWER ENGINEERING': 'PWR',
    'POWER ENGINEERING/POWER PLANT ENGINEERING': 'PWR',
    'PRINTING ENGINEERING': 'PTE',
    'PRINTING ENGINEERING/PRINTING TECHNOLOGY': 'PTE',
    'PRINTING TECHNOLOGY': 'PTE',
    'FOOD TECHNOLOGY & BIOCHEMICAL ENGINEERING': 'FTBE',
    'FOOD TECHNOLOGY AND BIO CHEMICAL ENGINEERING': 'FTBE',
    'FOOD TECHNOLOGY': 'FT',
    'FOOD ENGINEERING AND TECHNOLOGY': 'FT',
    'CONSTRUCTION ENGINEERING': 'CON',
    'METALLURGICAL & MATERIALS ENGINEERING': 'MET',
    'METALLURGICAL AND MATERIALS ENGINEERING': 'MET',
    'METALLURGICAL ENGINEERING': 'MET',
    'CERAMIC ENGINEERING & TECHNOLOGY': 'CER',
    'CERAMIC ENGINEERING AND TECHNOLOGY': 'CER',
    'CERAMIC ENGINERING AND TECHNOLOGY': 'CER',
    'BIOTECHNOLOGY': 'BT',
    'BIOMEDICAL ENGINEERING': 'BME',
    'B.PHARM/PHARMACEUTICAL TECHNOLOGY': 'PHM',
    'PHARMACEUTICAL TECHNOLOGY': 'PHM',
    'PHARMACY': 'PHM',
    'AGRICULTURAL ENGINEERING': 'AGE',
    'AUTOMOBILE ENGINEERING': 'AUTO',
    'MARINE ENGINEERING': 'MRE',
    'MARINE ENGINEERING/MARINE TECHNOLOGY': 'MRE',
    'MECHATRONICS ENGINEERING': 'MCT',
    'TEXTILE TECHNOLOGY': 'TXT',
    'LEATHER TECHNOLOGY': 'LTH',
    'JUTE & FIBRE TECHNOLOGY': 'JFT',
    'POLYMER SCIENCE & TECHNOLOGY': 'PST',
    'DAIRY TECHNOLOGY': 'DT',
    'ARCHITECTURE': 'ARCH',
    'B ARCH': 'ARCH',
    'B. PLANNING': 'PLAN',
    'ARTIFICIAL INTELLIGENCE': 'AI',
    'ARTIFICIAL INTELLIGENCE (AI)': 'AI',
    'ARTIFICIAL INTELLIGENCE & DATA SCIENCE': 'AIDS',
    'ARTIFICIAL INTELLIGENCE AND DATA SCIENCE': 'AIDS',
    'ARTIFICIAL INTELLIGENCE & MACHINE LEARNING': 'AIML',
    'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING': 'AIML',
    'COMPUTER SCIENCE & BUSINESS SYSTEM': 'CSBS',
    'COMPUTER SCIENCE AND BUSINESS SYSTEM': 'CSBS',
    'COMPUTER SCIENCE & ENGINEERING (ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING)': 'CSE-AIML',
    'COMPUTER SCIENCE & ENGINEERING (ARTIFICIAL INTELLIGENCE)': 'CSE-AI',
    'COMPUTER SCIENCE & ENGINEERING (CYBER SECURITY)': 'CSE-CS',
    'COMPUTER SCIENCE & ENGINEERING (DATA SCIENCE)': 'CSE-DS',
    'COMPUTER SCIENCE & ENGINEERING (IOT)': 'CSE-IOT',
    'COMPUTER SCIENCE & ENGINEERING (IOT )': 'CSE-IOT',
    'COMPUTER SCIENCE & ENGINEERING (INTERNET OF THINGS)': 'CSE-IOT',
    'COMPUTER SCIENCE & ENGINEERING (INTERNET OF THINGS AND CYBER SECURITY INCLUDING BLOCK CHAIN TECHNOLOGY)': 'CSE-ICB',
    'COMPUTER SCIENCE & ENGINEERING (ROBOTICS AND ARTIFICIAL INTELLIGENCE)': 'CSE-RAI',
    'COMPUTER SCIENCE & ENGINEERING (NETWORKS)': 'CSE-NET',
    'COMPUTER SCIENCE AND DESIGN': 'CSD',
    'COMPUTER SCIENCE AND APPLIED MATHEMATICS': 'CSAM',
    'COMPUTER SCIENCE AND INFORMATION TECHNOLOGY': 'CSIT',
    'CLOUD COMPUTING': 'CLD',
    '5G': '5G',
    'AUGMENTED REALITY': 'AR',
    'VIRTUAL REALITY (AR/VR)': 'VR',
    'ROBOTICS': 'ROB',
    'ROBOTICS & ARTIFICIAL INTELLIGENCE': 'RAI',
    'ROBOTICS AND AUTOMATION ENGINEERING': 'RAE',
    'ROBOTIC ENGINEERING': 'ROB',
    'SEMICONDUCTOR TECHNOLOGY': 'SMC'
  };

  if (mappings[p]) return mappings[p];

  const clean = p
    .replace(/ENGINEERING/g, '')
    .replace(/TECHNOLOGY/g, '')
    .replace(/AND/g, '')
    .replace(/&/g, '')
    .replace(/[^A-Z0-9 ]/g, '')
    .split(' ')
    .map(w => w.trim())
    .filter(Boolean);

  if (clean.length >= 2) {
    return clean.map(w => w[0]).join('').substring(0, 4);
  } else if (clean.length === 1) {
    return clean[0].substring(0, 3);
  }
  return 'GEN';
}

// Helper to generate a realistic choice code with premium overrides
function generateChoiceCode(institute, normalizedProgram) {
  const cleanInst = institute.toUpperCase()
    .replace(/GOVERNMENT/g, 'GOVT')
    .replace(/INSTITUTE OF TECHNOLOGY/g, 'IT')
    .replace(/AND/g, ' ')
    .replace(/&/g, ' ')
    .replace(/[^A-Z0-9 ]/g, '')
    .split(' ')
    .map(w => w.trim())
    .filter(w => w.length > 1);
  
  let instInitials = '';
  if (cleanInst.length >= 2) {
    instInitials = cleanInst.map(w => w[0]).join('').substring(0, 4);
  } else if (cleanInst.length === 1) {
    instInitials = cleanInst[0].substring(0, 4);
  } else {
    instInitials = 'INST';
  }

  // Premium overrides for famous colleges
  const instUpper = institute.toUpperCase();
  if (instUpper.includes('JADAVPUR UNIVERSITY')) {
    instInitials = 'JU';
  } else if (instUpper.includes('UNIVERSITY OF CALCUTTA')) {
    instInitials = 'UOC';
  } else if (instUpper.includes('JALPAIGURI GOVERMENT ENGINEERING COLLEGE') || instUpper.includes('JALPAIGURI GOVERNMENT ENGINEERING COLLEGE')) {
    instInitials = 'JGEC';
  } else if (instUpper.includes('KALYANI GOVERMENT ENGINEERING COLLEGE') || instUpper.includes('KALYANI GOVERNMENT ENGINEERING COLLEGE')) {
    instInitials = 'KGEC';
  } else if (instUpper.includes('HERITAGE INSTITUTE OF TECHNOLOGY')) {
    instInitials = 'HIT';
  } else if (instUpper.includes('HALDIA INSTITUTE OF TECHNOLOGY')) {
    instInitials = 'HIT-H';
  } else if (instUpper.includes('TECHNO INDIA UNIVERSITY')) {
    instInitials = 'TIU';
  } else if (instUpper.includes('TECHNO MAIN SALT LAKE') || instUpper.includes('TECHNO INDIA MAIN')) {
    instInitials = 'TMSL';
  } else if (instUpper.includes('CERAMIC TECHNOLOGY')) {
    instInitials = 'GCECT';
  } else if (instUpper.includes('LEATHER TECHNOLOGY')) {
    instInitials = 'GCELT';
  } else if (instUpper.includes('TEXTILE TECHNOLOGY, SERAMPORE')) {
    instInitials = 'GCETTS';
  } else if (instUpper.includes('TEXTILE TECHNOLOGY, BERHAMPORE')) {
    instInitials = 'GCETTB';
  }

  const progCode = getBranchCode(normalizedProgram);
  return `${instInitials}-${progCode}`;
}

// ── 1. Choice Filling Feature Status ──────────────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(doc.exists ? doc.data() : {});
    const access = settings.choiceFillingEnabled ? await userHasChoiceAccess(req) : { hasAccess: false, unlimited: false, attemptsLeft: 0 };

    res.json({
      enabled: settings.choiceFillingEnabled,
      requiresPayment: settings.requiresPayment,
      price: settings.price,
      maxAttempts: 9999,
      hasAccess: access.hasAccess,
      unlimited: access.unlimited,
      attemptsLeft: access.attemptsLeft,
      tiers: null
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

    const userIsAdmin = isAdminEmail(req.user.email) || req.user.admin === true || req.user.role === 'admin' || req.user.role === 'evaluator';
    if (!settings.choiceFillingEnabled && !userIsAdmin) {
      return res.status(403).json({
        error: 'feature_disabled',
        message: 'Choice Filling Preference Assistant is currently disabled.'
      });
    }

    const access = await userHasChoiceAccess(req);
    if (!access.hasAccess) {
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

    const categoriesToQuery = [category];
    if (tfw === 'true' || tfw === true) {
      categoriesToQuery.push('Tuition Fee Waiver');
    }
    const placeholders = categoriesToQuery.map(() => '?').join(',');

    // Query SQLite database for categories
    // IMPORTANT: Exclude JEE(Main) Seats — they use JEE Main AIR ranks (a completely
    // different ranking system) that cannot be compared against WBJEE GMR ranks.
    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
      FROM cutoffs
      WHERE category IN (${placeholders})
        AND seat_type != 'JEE(Main) Seats'
    `, categoriesToQuery, (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'query_failed', message: err.message });
      }

      const grouped = {};
      rows.forEach(row => {
        const instUpper = String(row.institute || '').toUpperCase().trim();
        if (instUpper.startsWith('INSTITUTE OF ENGINEERING & MANAGEMENT') || 
            instUpper.startsWith('INSTITUTE OF ENGINEERING AND MANAGEMENT')) {
          return; // Exclude IEM from choice filling!
        }

        const norm = getNormalizedProgram(row.program, row.institute);
        const normalizedProgramName = norm.name;
        const isRowTfw = norm.isTfw || String(row.category).toUpperCase().includes('TFW') || String(row.seat_type).toUpperCase().includes('TFW');
        
        // Consistent key ensuring case normalization and separate TFW vs Open choices
        const key = `${row.institute}|${normalizedProgramName}|${isRowTfw ? 'TFW' : 'OPEN'}|${row.quota}`;
        
        if (!grouped[key]) {
          grouped[key] = {
            institute: row.institute,
            program: normalizedProgramName,
            stream: row.stream,
            college_type: row.college_type,
            seat_type: isRowTfw ? 'TFW' : 'WBJEE Seats',
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

      const processedChoices = [];
      const branchFilters = Array.isArray(branches) ? branches : [];

      Object.keys(grouped).forEach(key => {
        const item = grouped[key];

        // 1. Quota filter
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

        // 2. TFW (Tuition Fee Waiver) filter:
        // In WBJEE, TFW is a separate seat_type.
        // If student toggles TFW = Yes, they can select both Open and TFW seats.
        // If TFW = No, they should NOT have TFW seats in their list.
        if (item.isTfw && (!tfw || tfw === 'false' || tfw === false)) {
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
          const streamText = String(item.program || '').toUpperCase();
          const matchesBranch = branchFilters.some(b => {
            const bUpper = String(b).toUpperCase();
            if (bUpper === 'CSE') {
              return streamText.includes('COMPUTER SCIENCE') || streamText.includes('CSE') || streamText.includes('CST') || streamText.includes('COMP. SC.');
            }
            if (bUpper === 'IT') {
              return streamText.includes('INFORMATION TECHNOLOGY') || streamText.includes('IT');
            }
            if (bUpper === 'AI_ML_DS') {
              return streamText.includes('ARTIFICIAL') || streamText.includes('DATA SCIENCE') || streamText.includes('MACHINE LEARNING') || streamText.includes('DATASCIENCE');
            }
            if (bUpper === 'CS_BS') {
              return streamText.includes('BUSINESS SYSTEM') || streamText.includes('CSBS');
            }
            if (bUpper === 'ECE') {
              return streamText.includes('ELECTRONICS') || streamText.includes('ECE') || streamText.includes('TELECOMMUNICATION');
            }
            if (bUpper === 'EE') {
              return streamText.includes('ELECTRICAL') || streamText.includes('EE') || streamText.includes('EEE');
            }
            if (bUpper === 'AEIE') {
              return streamText.includes('INSTRUMENTATION') || streamText.includes('AEIE') || streamText.includes('EIE') || streamText.includes('APPLIED ELECTRONICS');
            }
            if (bUpper === 'ME') {
              return streamText.includes('MECHANICAL') || streamText.includes('ME') || streamText.includes('AUTOMOBILE');
            }
            if (bUpper === 'CE') {
              return streamText.includes('CIVIL') || streamText.includes('CE') || streamText.includes('CONSTRUCTION');
            }
            if (bUpper === 'CHE') {
              return streamText.includes('CHEMICAL') || streamText.includes('CHE');
            }
            if (bUpper === 'BT') {
              return streamText.includes('BIOTECHNOLOGY') || streamText.includes('BIOMEDICAL') || streamText.includes('BIO-TECHNOLOGY');
            }
            if (bUpper === 'PHM') {
              return streamText.includes('PHARMACY') || streamText.includes('PHARMA') || streamText.includes('PHM') || streamText.includes('B.PHARM');
            }
            if (bUpper === 'ALLIED') {
              // Matches other minor/allied branches that do not fall into the main categories
              const isMainCategory = 
                streamText.includes('COMPUTER SCIENCE') || streamText.includes('CSE') || streamText.includes('CST') || streamText.includes('COMP. SC.') ||
                streamText.includes('INFORMATION TECHNOLOGY') || streamText.includes('IT') ||
                streamText.includes('ARTIFICIAL') || streamText.includes('DATA SCIENCE') || streamText.includes('MACHINE LEARNING') || streamText.includes('DATASCIENCE') ||
                streamText.includes('BUSINESS SYSTEM') || streamText.includes('CSBS') ||
                streamText.includes('ELECTRONICS') || streamText.includes('ECE') || streamText.includes('TELECOMMUNICATION') ||
                streamText.includes('ELECTRICAL') || streamText.includes('EE') || streamText.includes('EEE') ||
                streamText.includes('INSTRUMENTATION') || streamText.includes('AEIE') || streamText.includes('EIE') || streamText.includes('APPLIED ELECTRONICS') ||
                streamText.includes('MECHANICAL') || streamText.includes('ME') || streamText.includes('AUTOMOBILE') ||
                streamText.includes('CIVIL') || streamText.includes('CE') || streamText.includes('CONSTRUCTION') ||
                streamText.includes('CHEMICAL') || streamText.includes('CHE') ||
                streamText.includes('BIOTECHNOLOGY') || streamText.includes('BIOMEDICAL') || streamText.includes('BIO-TECHNOLOGY') ||
                streamText.includes('PHARMACY') || streamText.includes('PHARMA') || streamText.includes('PHM') || streamText.includes('B.PHARM');
              return !isMainCategory;
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

        const metadata = getCollegeMetadata(item.institute, item.program, item.seat_type);

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
          cutoffs: item.cutoffs,
          tuitionFee: metadata.tuitionFee,
          averagePackage: metadata.averagePackage,
          isTfw: metadata.isTfw
        });
      });

      // Gold Standard Sorting Rule with optional TFW Prioritization:
      const isTfwPrioritized = req.body.tfwPrioritized === 'true' || req.body.tfwPrioritized === true;
      if (isTfwPrioritized) {
        processedChoices.sort((a, b) => {
          if (a.isTfw && !b.isTfw) return -1;
          if (!a.isTfw && b.isTfw) return 1;
          return a.baseCutoff - b.baseCutoff;
        });
      } else {
        processedChoices.sort((a, b) => a.baseCutoff - b.baseCutoff);
      }

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

      // Decrement attempts if not unlimited
      if (access && !access.unlimited) {
        db.collection('users').doc(req.user.uid).update({
          choiceFillingAttemptsLeft: admin.firestore.FieldValue.increment(-1)
        }).catch(updateErr => {
          console.error('[Choice Filling] Failed to decrement attempts:', updateErr);
        });
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

// ── 3. Get All Saved Choice Filling Drafts ───────────────────────────────────
router.get('/drafts', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const draftsSnapshot = await db.collection('users')
      .doc(userId)
      .collection('choice_filling_drafts')
      .orderBy('updatedAt', 'desc')
      .get();

    const drafts = [];
    draftsSnapshot.forEach(doc => {
      const data = doc.data();
      drafts.push({
        draftId: doc.id,
        name: data.name,
        rank: data.rank,
        category: data.category,
        quota: data.quota,
        tfw: data.tfw,
        tfwPrioritized: data.tfwPrioritized,
        branches: data.branches,
        collegeType: data.collegeType,
        maxChoices: data.maxChoices,
        choices: data.choices,
        createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
        updatedAt: data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt) : null,
      });
    });

    res.json({ ok: true, drafts });
  } catch (err) {
    console.error('Error fetching choice-filling drafts:', err);
    res.status(500).json({ error: 'fetch_drafts_failed', message: err.message });
  }
});

// ── 4. Save or Update Choice Filling Draft ───────────────────────────────────
router.post('/drafts', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      draftId,
      name,
      rank,
      category,
      quota,
      tfw,
      tfwPrioritized,
      branches,
      collegeType,
      maxChoices,
      choices
    } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'invalid_name', message: 'Please provide a valid name for your draft.' });
    }

    const draftData = {
      name: name.trim(),
      rank: Number(rank) || 0,
      category: category || '',
      quota: quota || '',
      tfw: tfw === true || tfw === 'true',
      tfwPrioritized: tfwPrioritized === true || tfwPrioritized === 'true',
      branches: Array.isArray(branches) ? branches : [],
      collegeType: collegeType || '',
      maxChoices: Number(maxChoices) || 30,
      choices: Array.isArray(choices) ? choices : [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    let targetDoc;
    let isNew = false;

    if (draftId) {
      targetDoc = db.collection('users')
        .doc(userId)
        .collection('choice_filling_drafts')
        .doc(draftId);
      
      const checkDoc = await targetDoc.get();
      if (!checkDoc.exists) {
        return res.status(404).json({ error: 'draft_not_found', message: 'The specified draft was not found.' });
      }
    } else {
      targetDoc = db.collection('users')
        .doc(userId)
        .collection('choice_filling_drafts')
        .doc(); // auto-generate ID
      draftData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      isNew = true;
    }

    await targetDoc.set(draftData, { merge: true });

    res.json({
      ok: true,
      draftId: targetDoc.id,
      message: isNew ? 'Draft saved successfully.' : 'Draft updated successfully.'
    });
  } catch (err) {
    console.error('Error saving choice-filling draft:', err);
    res.status(500).json({ error: 'save_draft_failed', message: err.message });
  }
});

// ── 5. Delete Choice Filling Draft ───────────────────────────────────────────
router.delete('/drafts/:draftId', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const draftId = req.params.draftId;

    if (!draftId) {
      return res.status(400).json({ error: 'missing_draft_id', message: 'Please provide a draft ID to delete.' });
    }

    const draftDoc = db.collection('users')
      .doc(userId)
      .collection('choice_filling_drafts')
      .doc(draftId);

    const checkDoc = await draftDoc.get();
    if (!checkDoc.exists) {
      return res.status(404).json({ error: 'draft_not_found', message: 'The specified draft was not found.' });
    }

    await draftDoc.delete();

    res.json({ ok: true, message: 'Draft deleted successfully.' });
  } catch (err) {
    console.error('Error deleting choice-filling draft:', err);
    res.status(500).json({ error: 'delete_draft_failed', message: err.message });
  }
});

router.userHasChoiceAccess = userHasChoiceAccess;
module.exports = router;
