const { db } = require('./firebase');

// Operator Definitions
const OPERATORS = {
  equals: { label: 'Equals (=)', types: ['text', 'select', 'number'] },
  not_equals: { label: 'Not Equals (≠)', types: ['text', 'select', 'number'] },
  contains: { label: 'Contains', types: ['text'] },
  not_contains: { label: 'Does Not Contain', types: ['text'] },
  greater_than: { label: 'Greater Than (>)', types: ['number'] },
  greater_than_or_equal: { label: 'Greater Than or Equal (>=)', types: ['number'] },
  less_than: { label: 'Less Than (<)', types: ['number'] },
  less_than_or_equal: { label: 'Less Than or Equal (<=)', types: ['number'] },
  between: { label: 'Between Range', types: ['number', 'date'] },
  in: { label: 'Is One Of (Any of)', types: ['multi_select'] },
  not_in: { label: 'Is None Of', types: ['multi_select'] },
  before: { label: 'Before Date', types: ['date'] },
  after: { label: 'After Date', types: ['date'] },
  within_last_days: { label: 'Within Last X Days', types: ['days'] },
  more_than_days_ago: { label: 'More Than X Days Ago', types: ['days'] },
  age_greater_than: { label: 'Age Greater Than (Years)', types: ['number'] },
  age_less_than: { label: 'Age Less Than (Years)', types: ['number'] },
  purchased: { label: 'Has Purchased', types: ['product_status'] },
  not_purchased: { label: 'Has NOT Purchased (Free User)', types: ['product_status'] },
  confirmed_paid: { label: 'Registered & Paid (Confirmed)', types: ['workshop_status'] },
  reserved_checkout: { label: 'Reserved Seat (Locked)', types: ['workshop_status'] },
  expired_checkout: { label: 'Lock Expired (Unpaid)', types: ['workshop_status'] },
  never_registered: { label: 'Never Registered', types: ['workshop_status'] },
  attempted: { label: 'Has Attempted Exam', types: ['exam_status'] },
  not_attempted: { label: 'Has NOT Attempted Exam', types: ['exam_status'] },
  exists: { label: 'Field Exists / Set', types: ['exists'] },
  not_exists: { label: 'Field Missing / Not Set', types: ['exists'] }
};

// Static Rule Categories & Definitions
const RULE_DEFINITIONS = [
  // ── ACCOUNT RULES ──
  {
    id: 'account.createdAt',
    category: 'Account & Registration',
    label: 'Account Created Date',
    dataType: 'date',
    operators: ['after', 'before', 'between', 'within_last_days', 'more_than_days_ago']
  },
  {
    id: 'account.profileStatus',
    category: 'Account & Registration',
    label: 'Profile Completion Status',
    dataType: 'select',
    operators: ['equals', 'not_equals'],
    options: [
      { value: 'complete', label: 'Profile Completed' },
      { value: 'incomplete', label: 'Profile Incomplete' }
    ]
  },

  // ── PROFILE & DEMOGRAPHICS ──
  {
    id: 'profile.wbjeeYear',
    category: 'Profile & Demographics',
    label: 'Target WBJEE Year',
    dataType: 'multi_select',
    operators: ['in', 'not_in'],
    dynamicProvider: 'years'
  },
  {
    id: 'profile.gender',
    category: 'Profile & Demographics',
    label: 'Gender',
    dataType: 'select',
    operators: ['equals', 'not_equals'],
    options: [
      { value: 'Male', label: 'Male' },
      { value: 'Female', label: 'Female' },
      { value: 'Other', label: 'Other' }
    ]
  },
  {
    id: 'profile.caste',
    category: 'Profile & Demographics',
    label: 'Category / Caste',
    dataType: 'select',
    operators: ['equals', 'not_equals'],
    options: [
      { value: 'General', label: 'General' },
      { value: 'SC', label: 'SC' },
      { value: 'ST', label: 'ST' },
      { value: 'OBC-A', label: 'OBC-A' },
      { value: 'OBC-B', label: 'OBC-B' },
      { value: 'EWS', label: 'EWS' }
    ]
  },
  {
    id: 'profile.tfw',
    category: 'Profile & Demographics',
    label: 'Tuition Fee Waiver (TFW) Status',
    dataType: 'select',
    operators: ['equals'],
    options: [
      { value: 'Yes', label: 'Yes (TFW Applied)' },
      { value: 'No', label: 'No' }
    ]
  },
  {
    id: 'profile.homeState',
    category: 'Profile & Demographics',
    label: 'Home State Status',
    dataType: 'select',
    operators: ['equals'],
    options: [
      { value: 'West Bengal', label: 'West Bengal Resident' },
      { value: 'Other State', label: 'Other State Resident' }
    ]
  },
  {
    id: 'profile.dob',
    category: 'Profile & Demographics',
    label: 'Date of Birth / Age',
    dataType: 'date',
    operators: ['before', 'after', 'between', 'age_greater_than', 'age_less_than']
  },

  // ── PRODUCTS & PURCHASES ──
  {
    id: 'purchase.product',
    category: 'Products & Purchases',
    label: 'Product Purchase Status',
    dataType: 'product_status',
    operators: ['purchased', 'not_purchased'],
    dynamicProvider: 'products'
  },
  {
    id: 'purchase.totalSpent',
    category: 'Products & Purchases',
    label: 'Total Amount Spent (₹)',
    dataType: 'number',
    operators: ['equals', 'greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'purchase.date',
    category: 'Products & Purchases',
    label: 'Purchase Date',
    dataType: 'date',
    operators: ['after', 'before', 'between', 'within_last_days']
  },

  // ── PERFORMANCE & RANKS ──
  {
    id: 'performance.predictedRankEng',
    category: 'Performance & Ranks',
    label: 'Predicted Engineering Rank',
    dataType: 'number',
    operators: ['less_than_or_equal', 'greater_than_or_equal', 'between']
  },
  {
    id: 'performance.predictedRankBph',
    category: 'Performance & Ranks',
    label: 'Predicted B-Pharma Rank',
    dataType: 'number',
    operators: ['less_than_or_equal', 'greater_than_or_equal', 'between']
  },
  {
    id: 'performance.engineeringScore',
    category: 'Performance & Ranks',
    label: 'Engineering Total Score',
    dataType: 'number',
    operators: ['greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'performance.bpharmaScore',
    category: 'Performance & Ranks',
    label: 'B-Pharma Total Score',
    dataType: 'number',
    operators: ['greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'performance.mathScore',
    category: 'Performance & Ranks',
    label: 'Mathematics Subject Score',
    dataType: 'number',
    operators: ['greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'performance.physicsScore',
    category: 'Performance & Ranks',
    label: 'Physics Subject Score',
    dataType: 'number',
    operators: ['greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'performance.chemScore',
    category: 'Performance & Ranks',
    label: 'Chemistry Subject Score',
    dataType: 'number',
    operators: ['greater_than_or_equal', 'less_than_or_equal', 'between']
  },
  {
    id: 'performance.examAttempted',
    category: 'Performance & Ranks',
    label: 'Specific Exam Attempt Status',
    dataType: 'exam_status',
    operators: ['attempted', 'not_attempted'],
    dynamicProvider: 'exams'
  },
  {
    id: 'performance.resetRequested',
    category: 'Performance & Ranks',
    label: 'Score Reset Request Status',
    dataType: 'select',
    operators: ['equals'],
    options: [
      { value: 'pending', label: 'Pending Reset Request' }
    ]
  },

  // ── WORKSHOP ACTIVITY ──
  {
    id: 'workshop.status',
    category: 'Workshops',
    label: 'Workshop Registration & Payment Status',
    dataType: 'workshop_status',
    operators: ['confirmed_paid', 'reserved_checkout', 'expired_checkout', 'never_registered'],
    dynamicProvider: 'workshops'
  },

  // ── CUSTOM TAGS & ATTRIBUTES ──
  {
    id: 'custom.tag',
    category: 'Custom Tags & Attributes',
    label: 'Student Custom Tag',
    dataType: 'text',
    operators: ['contains', 'not_contains', 'equals']
  },
  {
    id: 'custom.attributeKey',
    category: 'Custom Tags & Attributes',
    label: 'Custom Attribute Key (e.g. source, counsellor)',
    dataType: 'text',
    operators: ['equals', 'contains', 'exists']
  }
];

// Helper to fetch dynamic option dropdowns from Firestore
async function getDynamicOptions() {
  const years = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 1; y <= currentYear + 3; y++) {
    years.push({ value: String(y), label: `WBJEE ${y}` });
  }

  // Dynamic Products List
  const products = [
    { value: 'college_predictor', label: 'College Predictor (Full Access)' },
    { value: 'choice_filling', label: 'Choice Filling Tool' },
    { value: 'counselling', label: '1-on-1 Personal Counselling' }
  ];

  try {
    const seriesSnap = await db.collection('mockTestSeries').orderBy('title', 'asc').get();
    seriesSnap.forEach(doc => {
      const data = doc.data();
      products.push({
        value: `mock_test_series:${doc.id}`,
        label: `Mock Test Series: ${data.title || doc.id}`
      });
    });
  } catch (e) {
    console.warn('Failed to fetch mock test series options:', e.message);
  }

  // Dynamic Workshops List
  const workshops = [];
  try {
    const wSnap = await db.collection('workshops').get();
    wSnap.forEach(doc => {
      const data = doc.data();
      workshops.push({
        value: doc.id,
        label: `${data.name || 'Workshop'} (${data.date || ''})`
      });
    });
  } catch (e) {
    console.warn('Failed to fetch workshop options:', e.message);
  }

  // Dynamic Exams List
  const exams = [];
  try {
    const exSnap = await db.collection('exams').get();
    exSnap.forEach(doc => {
      const data = doc.data();
      exams.push({
        value: doc.id,
        label: data.title || data.name || doc.id
      });
    });
  } catch (e) {
    console.warn('Failed to fetch exam options:', e.message);
  }

  return {
    years,
    products,
    workshops,
    exams
  };
}

module.exports = {
  OPERATORS,
  RULE_DEFINITIONS,
  getDynamicOptions
};
