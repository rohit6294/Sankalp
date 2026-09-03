const { db } = require('./firebase');

/**
 * Loads all relevant student data from Firestore for audience segmentation evaluation.
 * Returns an array of normalized student objects with joined data maps.
 */
async function loadAllStudentData() {
  const [usersSnap, purchasesSnap, submissionsSnap, workshopRegsSnap, resetReqsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('purchases').get(),
    db.collection('submissions').get(),
    db.collection('workshopRegistrations').get(),
    db.collection('resetRequests').where('status', '==', 'pending').get()
  ]);

  // Index Purchases by userId
  const purchasesByUserId = {};
  purchasesSnap.forEach(doc => {
    const data = doc.data();
    if (!data || !data.userId) return;
    const uId = data.userId;
    if (!purchasesByUserId[uId]) purchasesByUserId[uId] = [];
    purchasesByUserId[uId].push({
      id: doc.id,
      product: data.product,
      productId: data.productId,
      status: data.status || 'success',
      amount: Number(data.amount || 0),
      purchasedAt: data.purchasedAt ? (data.purchasedAt.toDate ? data.purchasedAt.toDate().getTime() : new Date(data.purchasedAt).getTime()) : 0
    });
  });

  // Index Submissions by userId
  const submissionsByUserId = {};
  submissionsSnap.forEach(doc => {
    const data = doc.data();
    if (!data || !data.userId) return;
    const uId = data.userId;
    if (!submissionsByUserId[uId]) submissionsByUserId[uId] = [];
    submissionsByUserId[uId].push({
      id: doc.id,
      examId: data.examId,
      scores: data.scores || {},
      expectedRank: data.expectedRank || {},
      submittedAt: data.submittedAt ? (data.submittedAt.toDate ? data.submittedAt.toDate().getTime() : new Date(data.submittedAt).getTime()) : 0
    });
  });

  // Index Workshop Registrations by userId
  const workshopsByUserId = {};
  workshopRegsSnap.forEach(doc => {
    const data = doc.data();
    if (!data || !data.userId) return;
    const uId = data.userId;
    if (!workshopsByUserId[uId]) workshopsByUserId[uId] = [];
    const nowMs = Date.now();
    let status = data.status || 'RESERVED';
    if (status === 'RESERVED' && data.expiresAt) {
      const exp = data.expiresAt.toDate ? data.expiresAt.toDate().getTime() : new Date(data.expiresAt).getTime();
      if (exp < nowMs) status = 'EXPIRED';
    }
    workshopsByUserId[uId].push({
      registrationId: doc.id,
      workshopId: data.workshopId,
      status,
      paymentStatus: data.paymentStatus || 'PENDING'
    });
  });

  // Index Reset Requests by userId
  const resetReqsByUserId = {};
  resetReqsSnap.forEach(doc => {
    const data = doc.data();
    if (data && data.userId) resetReqsByUserId[data.userId] = true;
  });

  // Normalize Students List
  const students = [];
  usersSnap.forEach(doc => {
    const uData = doc.data() || {};
    const uid = doc.id;

    const userPurchases = purchasesByUserId[uid] || [];
    const userSubmissions = submissionsByUserId[uid] || [];
    const userWorkshops = workshopsByUserId[uid] || [];

    // Calculate total amount spent
    let totalSpent = 0;
    userPurchases.forEach(p => {
      if (p.status === 'success') totalSpent += p.amount;
    });

    // Best / Recent performance scores & ranks
    let bestEngRank = Infinity;
    let bestBphRank = Infinity;
    let maxEngScore = -Infinity;
    let maxBphScore = -Infinity;
    let maxMathScore = -Infinity;
    let maxPhysScore = -Infinity;
    let maxChemScore = -Infinity;

    userSubmissions.forEach(sub => {
      const s = sub.scores || {};
      const r = sub.expectedRank || {};
      if (r.engineering && r.engineering > 0 && r.engineering < bestEngRank) bestEngRank = r.engineering;
      if (r.bpharma && r.bpharma > 0 && r.bpharma < bestBphRank) bestBphRank = r.bpharma;

      if (s.engineering !== undefined && s.engineering > maxEngScore) maxEngScore = s.engineering;
      if (s.bpharma !== undefined && s.bpharma > maxBphScore) maxBphScore = s.bpharma;
      if (s.math !== undefined && s.math > maxMathScore) maxMathScore = s.math;
      if (s.physics !== undefined && s.physics > maxPhysScore) maxPhysScore = s.physics;
      if (s.chemistry !== undefined && s.chemistry > maxChemScore) maxChemScore = s.chemistry;
    });

    let createdAtMs = 0;
    if (uData.createdAt) {
      createdAtMs = uData.createdAt.toDate ? uData.createdAt.toDate().getTime() : new Date(uData.createdAt).getTime();
    }

    let dobMs = 0;
    let age = 0;
    if (uData.dob || uData.dateOfBirth) {
      const dStr = uData.dob || uData.dateOfBirth;
      const dDate = new Date(dStr);
      if (!isNaN(dDate.getTime())) {
        dobMs = dDate.getTime();
        const ageDiffMs = Date.now() - dobMs;
        age = Math.floor(ageDiffMs / (365.25 * 24 * 60 * 60 * 1000));
      }
    }

    students.push({
      uid,
      name: uData.name || uData.displayName || `${uData.firstName || ''} ${uData.lastName || ''}`.trim() || 'Student',
      email: uData.email ? uData.email.trim() : '',
      phone: uData.phone || '',
      wbjeeYear: String(uData.wbjeeYear || '').trim(),
      gender: uData.gender || '',
      caste: uData.caste || '',
      tfw: uData.tfw || 'No',
      homeState: uData.homeState || '',
      dobMs,
      age,
      createdAtMs,
      isProfileComplete: !!(uData.name && uData.phone && uData.wbjeeYear),
      collegePredictorPaid: uData.collegePredictorPaid === true || uData.predictorAccess === 'paid',
      choiceFillingPaid: uData.choiceFillingPaid === true,
      customTags: Array.isArray(uData.customTags) ? uData.customTags : [],
      customAttributes: uData.customAttributes || {},
      purchases: userPurchases,
      totalSpent,
      submissions: userSubmissions,
      bestEngRank: bestEngRank !== Infinity ? bestEngRank : null,
      bestBphRank: bestBphRank !== Infinity ? bestBphRank : null,
      maxEngScore: maxEngScore !== -Infinity ? maxEngScore : null,
      maxBphScore: maxBphScore !== -Infinity ? maxBphScore : null,
      maxMathScore: maxMathScore !== -Infinity ? maxMathScore : null,
      maxPhysScore: maxPhysScore !== -Infinity ? maxPhysScore : null,
      maxChemScore: maxChemScore !== -Infinity ? maxChemScore : null,
      workshops: userWorkshops,
      hasResetPending: !!resetReqsByUserId[uid]
    });
  });

  return students;
}

/**
 * Evaluates a single condition against a student object.
 */
function evaluateSingleCondition(student, condition) {
  const { field, operator, value } = condition || {};
  if (!field || !operator) return true;

  const nowMs = Date.now();

  switch (field) {
    // ── ACCOUNT & REGISTRATION ──
    case 'account.createdAt': {
      const ts = student.createdAtMs;
      if (!ts) return false;
      if (operator === 'after') return ts > new Date(value).getTime();
      if (operator === 'before') return ts < new Date(value).getTime();
      if (operator === 'between') {
        const [start, end] = Array.isArray(value) ? value : [value.start, value.end];
        return ts >= new Date(start).getTime() && ts <= new Date(end).getTime();
      }
      if (operator === 'within_last_days') {
        const days = Number(value || 0);
        return ts >= (nowMs - days * 24 * 60 * 60 * 1000);
      }
      if (operator === 'more_than_days_ago') {
        const days = Number(value || 0);
        return ts <= (nowMs - days * 24 * 60 * 60 * 1000);
      }
      return false;
    }

    case 'account.profileStatus': {
      const isComplete = student.isProfileComplete;
      if (operator === 'equals') return value === 'complete' ? isComplete : !isComplete;
      if (operator === 'not_equals') return value === 'complete' ? !isComplete : isComplete;
      return false;
    }

    // ── PROFILE & DEMOGRAPHICS ──
    case 'profile.wbjeeYear': {
      const targetYears = Array.isArray(value) ? value.map(String) : [String(value)];
      if (operator === 'in') return targetYears.includes(student.wbjeeYear);
      if (operator === 'not_in') return !targetYears.includes(student.wbjeeYear);
      return false;
    }

    case 'profile.gender': {
      if (operator === 'equals') return student.gender.toLowerCase() === String(value).toLowerCase();
      if (operator === 'not_equals') return student.gender.toLowerCase() !== String(value).toLowerCase();
      return false;
    }

    case 'profile.caste': {
      if (operator === 'equals') return student.caste.toLowerCase() === String(value).toLowerCase();
      if (operator === 'not_equals') return student.caste.toLowerCase() !== String(value).toLowerCase();
      return false;
    }

    case 'profile.tfw': {
      return student.tfw.toLowerCase() === String(value).toLowerCase();
    }

    case 'profile.homeState': {
      return student.homeState.toLowerCase() === String(value).toLowerCase();
    }

    case 'profile.dob': {
      if (operator === 'before') return student.dobMs > 0 && student.dobMs < new Date(value).getTime();
      if (operator === 'after') return student.dobMs > 0 && student.dobMs > new Date(value).getTime();
      if (operator === 'between') {
        const [start, end] = Array.isArray(value) ? value : [value.start, value.end];
        return student.dobMs >= new Date(start).getTime() && student.dobMs <= new Date(end).getTime();
      }
      if (operator === 'age_greater_than') return student.age > Number(value);
      if (operator === 'age_less_than') return student.age > 0 && student.age < Number(value);
      return false;
    }

    // ── PRODUCTS & PURCHASES ──
    case 'purchase.product': {
      const targetProd = String(value || '').trim();
      
      // Check if student purchased target product
      const hasPurchased = student.purchases.some(p => {
        if (p.status !== 'success') return false;
        if (targetProd === 'college_predictor') return p.product === 'college_predictor' || student.collegePredictorPaid;
        if (targetProd === 'choice_filling') return p.product === 'choice_filling' || student.choiceFillingPaid;
        if (targetProd === 'counselling') return p.product === 'counselling';
        if (targetProd.startsWith('mock_test_series:')) {
          const seriesId = targetProd.replace('mock_test_series:', '');
          return p.product === 'mock_test_series' && String(p.productId) === seriesId;
        }
        return p.product === targetProd || p.productId === targetProd;
      });

      if (operator === 'purchased') return hasPurchased;
      if (operator === 'not_purchased') return !hasPurchased;
      return false;
    }

    case 'purchase.totalSpent': {
      const amt = student.totalSpent;
      const target = Number(value || 0);
      if (operator === 'equals') return amt === target;
      if (operator === 'greater_than_or_equal') return amt >= target;
      if (operator === 'less_than_or_equal') return amt <= target;
      if (operator === 'between') {
        const [min, max] = Array.isArray(value) ? value.map(Number) : [Number(value.min), Number(value.max)];
        return amt >= min && amt <= max;
      }
      return false;
    }

    // ── PERFORMANCE & RANKS ──
    case 'performance.predictedRankEng': {
      if (student.bestEngRank === null) return false;
      const target = Number(value || 0);
      if (operator === 'less_than_or_equal') return student.bestEngRank <= target;
      if (operator === 'greater_than_or_equal') return student.bestEngRank >= target;
      if (operator === 'between') {
        const [min, max] = Array.isArray(value) ? value.map(Number) : [Number(value.min), Number(value.max)];
        return student.bestEngRank >= min && student.bestEngRank <= max;
      }
      return false;
    }

    case 'performance.predictedRankBph': {
      if (student.bestBphRank === null) return false;
      const target = Number(value || 0);
      if (operator === 'less_than_or_equal') return student.bestBphRank <= target;
      if (operator === 'greater_than_or_equal') return student.bestBphRank >= target;
      if (operator === 'between') {
        const [min, max] = Array.isArray(value) ? value.map(Number) : [Number(value.min), Number(value.max)];
        return student.bestBphRank >= min && student.bestBphRank <= max;
      }
      return false;
    }

    case 'performance.engineeringScore': {
      if (student.maxEngScore === null) return false;
      const target = Number(value || 0);
      if (operator === 'greater_than_or_equal') return student.maxEngScore >= target;
      if (operator === 'less_than_or_equal') return student.maxEngScore <= target;
      if (operator === 'between') {
        const [min, max] = Array.isArray(value) ? value.map(Number) : [Number(value.min), Number(value.max)];
        return student.maxEngScore >= min && student.maxEngScore <= max;
      }
      return false;
    }

    case 'performance.examAttempted': {
      const targetExamId = String(value || '').trim();
      const hasAttempted = student.submissions.some(s => s.examId === targetExamId);
      if (operator === 'attempted') return hasAttempted;
      if (operator === 'not_attempted') return !hasAttempted;
      return false;
    }

    case 'performance.resetRequested': {
      return student.hasResetPending;
    }

    // ── WORKSHOP ACTIVITY ──
    case 'workshop.status': {
      const targetWorkshopId = condition.workshopId || condition.targetWorkshopId || String(value || '').trim();
      const matchedReg = student.workshops.find(w => !targetWorkshopId || w.workshopId === targetWorkshopId);

      if (operator === 'confirmed_paid') return matchedReg && matchedReg.status === 'CONFIRMED';
      if (operator === 'reserved_checkout') return matchedReg && matchedReg.status === 'RESERVED';
      if (operator === 'expired_checkout') return matchedReg && matchedReg.status === 'EXPIRED';
      if (operator === 'never_registered') return !matchedReg;
      return false;
    }

    // ── CUSTOM TAGS & ATTRIBUTES ──
    case 'custom.tag': {
      const targetTag = String(value || '').toLowerCase().trim();
      const hasTag = student.customTags.some(t => String(t).toLowerCase().includes(targetTag));
      if (operator === 'contains' || operator === 'equals') return hasTag;
      if (operator === 'not_contains') return !hasTag;
      return false;
    }

    default:
      return true;
  }
}

/**
 * Evaluates a rule tree (nested AND/OR/NOT condition groups) recursively against a student.
 */
function evaluateRuleTree(student, node) {
  if (!node) return true;

  // Single condition node
  if (node.field) {
    return evaluateSingleCondition(student, node);
  }

  // Group node (AND / OR / NOT)
  const conjunction = (node.conjunction || 'AND').toUpperCase();
  const conditions = Array.isArray(node.conditions) ? node.conditions : [];

  if (conditions.length === 0) return true;

  if (conjunction === 'AND') {
    return conditions.every(child => evaluateRuleTree(student, child));
  }

  if (conjunction === 'OR') {
    return conditions.some(child => evaluateRuleTree(student, child));
  }

  if (conjunction === 'NOT') {
    return !conditions.every(child => evaluateRuleTree(student, child));
  }

  return true;
}

/**
 * Resolves matching students for a given segment rule tree.
 */
async function evaluateSegmentRules(ruleTree) {
  const allStudents = await loadAllStudentData();

  const matchingStudents = allStudents.filter(student => evaluateRuleTree(student, ruleTree));

  const recipientEmails = Array.from(
    new Set(matchingStudents.map(s => s.email).filter(Boolean))
  );

  return {
    matchingCount: matchingStudents.length,
    matchingStudents,
    recipientEmails
  };
}

module.exports = {
  loadAllStudentData,
  evaluateRuleTree,
  evaluateSegmentRules
};
