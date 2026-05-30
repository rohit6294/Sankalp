const STATE_GOVERNMENT_ENGINEERING_COLLEGES = [
  'alipurduar government engineering and management college',
  'cooch behar government engineering college',
  'government college of engineering and leather technology',
  'govt college of engg and textile technology berhampore',
  'government college of engineering and textile technology berhampore',
  'govt college of engineering and ceramic technology',
  'government college of engineering and ceramic technology',
  'govt college of engineering and textile technology serampore',
  'government college of engineering and textile technology serampore',
  'jalpaiguri government engineering college',
  'kalyani government engineering college',
  'ramkrishna mahato government engineering college',
];

const CENTRAL_GOVERNMENT_ENGINEERING_COLLEGES = [
  'ghani khan choudhury institute of engineering and technology',
];

const STATE_GOVERNMENT_PHARMACY_COLLEGES = [
  'institute of pharmacy jalpaiguri',
];

const PRIVATE_UNIVERSITIES = [
  'adamas university',
  'brainware university',
  'university of engineering and management kolkata',
  'institute of engineering and management kolkata under university of engineering and management kolkata',
  'jis university',
  'school of pharmacy techno india university salt lake',
  'seacom skills university',
  'sister nivedita university',
  'swami vivekananda university',
  'the neotia university',
  'neotia university',
  'techno india university salt lake',
];

const STANDALONE_PRIVATE_PHARMACY_COLLEGES = [
  'anand college of education debra paschim medinipur',
  'bcda college of pharmacy and technology hridaypur barasat',
  'bcda college of pharmacy and technology hridaypur madhyamgram',
  'bcda college of pharmacy and technology campus 2 madhyamgram',
  'belarani institute of medical science onda bankura',
  'bengal college of pharmaceutical technology dubrajpur birbhum',
  'bengal college of pharmaceutical science and research durgapur',
  'bengal school of technology sugandha hooghly',
  'bharat technology uluberia howrah',
  'birbhum pharmacy school hetampur birbhum',
  'calcutta institute of pharmaceutical tech and allied health sciences uluberia',
  'derozio pharma institute gopalchak moyna purba medinipur',
  'derozio pharma institute',
  'dr b c roy college of pharmacy and allied health sciences durgapur',
  'dmbh institute of medical science hooghly',
  'east west education institute purba bardhaman',
  'east west education institute',
  'eminent college of pharmaceutical technology barasat',
  'gandhari college school of pharmacy bhupatinagar purba medinipur',
  'gandhari college school of pharmacy',
  'gitanjali college of pharmacy lohapur birbhum',
  'global college of pharmaceutical technology krishnanagar',
  'gupta college of technological sciences asansol burdwan',
  'guru nanak institute of pharmaceutical science and technology sodepur',
  'haldia institute of pharmacy haldia',
  'iq city institute of pharmaceutical sciences durgapur',
  'iq city institute of pharmaceutical sciences',
  'jakir hossain institute of pharmacy raghunathganj',
  'jakir hossain institute of pharmacy',
  'm r collge of pharmaceitical science and research bira ashoknagar',
  'm r college of pharmaceutical science and research bira ashoknagar',
  'netaji subhas chandra bose institute of pharmacy chakdah nadia',
  'netaji subhash chandra bose institute of pharmacy chakdah nadia',
  'nshm institute of pharmaceutical technology durgapur',
  'nshm knowledge campus kolkata group of institutions kolkata',
  'p g institute of medical sciences chandrakona',
  'pandaveswar school of pharmacy',
  'rangamati college of pharmacy nalhati birbhum',
  'rashbehari pharmaceutical institute panskura',
  'rashbehari pharmaceutical institute',
  'seacom pharmacy college',
  'skm institute of pharmaceutical sciences and research',
  'tarifa memorial institute of pharmacy hariharpara murshidabad',
  'tarifa memorial institute of pharmacy',
  'vidyasagar pharmaceutical college of education simurali nadia',
  'vidyasagar pharmaceutical college of education',
];

function normalizeInstituteName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bgoverment\b/g, 'government')
    .replace(/\bgovt\.?\b/g, 'government')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isKnownCollege(institute, knownColleges) {
  const normalized = normalizeInstituteName(institute);
  return knownColleges.some((college) => {
    const known = normalizeInstituteName(college);
    return normalized === known || normalized.includes(known);
  });
}

function isKnownStateGovernmentEngineeringCollege(institute) {
  return isKnownCollege(institute, STATE_GOVERNMENT_ENGINEERING_COLLEGES);
}

function isKnownCentralGovernmentEngineeringCollege(institute) {
  return isKnownCollege(institute, CENTRAL_GOVERNMENT_ENGINEERING_COLLEGES);
}

function isKnownStateGovernmentPharmacyCollege(institute) {
  return isKnownCollege(institute, STATE_GOVERNMENT_PHARMACY_COLLEGES);
}

function isKnownPrivateUniversity(institute) {
  return isKnownCollege(institute, PRIVATE_UNIVERSITIES);
}

function isKnownStandalonePrivatePharmacyCollege(institute) {
  return isKnownCollege(institute, STANDALONE_PRIVATE_PHARMACY_COLLEGES);
}

function hasKnownCollegeTypeOverride(institute) {
  return isKnownCentralGovernmentEngineeringCollege(institute)
    || isKnownStateGovernmentEngineeringCollege(institute)
    || isKnownStateGovernmentPharmacyCollege(institute)
    || isKnownPrivateUniversity(institute)
    || isKnownStandalonePrivatePharmacyCollege(institute);
}

function classifyCollegeType(institute, program = '') {
  const normalized = normalizeInstituteName(institute);
  const programText = normalizeInstituteName(program);
  const isPharmacy = normalized.includes('pharmacy') || programText.includes('pharma');
  const hasGovernmentMarker = normalized.includes('government');

  if (isKnownCentralGovernmentEngineeringCollege(institute)) {
    return 'Central Government Engineering College';
  }

  if (isKnownStateGovernmentEngineeringCollege(institute)) {
    return 'State Government Engineering College';
  }

  if (isKnownStateGovernmentPharmacyCollege(institute) || (isPharmacy && hasGovernmentMarker)) {
    return 'State Government Pharmacy College';
  }

  if (isKnownPrivateUniversity(institute) || normalized.includes('private university')) {
    return 'Private University';
  }

  if (isKnownStandalonePrivatePharmacyCollege(institute)) {
    return 'Stand Alone Private Pharmacy College';
  }

  if (
    normalized.includes('jadavpur university')
    || normalized.startsWith('jadavpur university')
    || normalized.includes('university of calcutta')
    || normalized.includes('calcutta university')
    || normalized.includes('university of kalyani')
    || normalized.includes('kalyani university')
    || normalized.includes('university')
  ) {
    return 'University/University Department';
  }

  if (hasGovernmentMarker) {
    return 'State Government Engineering College';
  }

  if (isPharmacy) {
    return 'Stand Alone Private Pharmacy College';
  }

  return 'Private Engineering College';
}

function resolveCollegeType(institute, program = '', suppliedType = '') {
  const computedType = classifyCollegeType(institute, program);
  if (hasKnownCollegeTypeOverride(institute)) {
    return computedType;
  }

  const cleanSuppliedType = String(suppliedType || '').trim();
  return cleanSuppliedType || computedType;
}

module.exports = {
  CENTRAL_GOVERNMENT_ENGINEERING_COLLEGES,
  PRIVATE_UNIVERSITIES,
  STANDALONE_PRIVATE_PHARMACY_COLLEGES,
  STATE_GOVERNMENT_ENGINEERING_COLLEGES,
  STATE_GOVERNMENT_PHARMACY_COLLEGES,
  classifyCollegeType,
  resolveCollegeType,
  isKnownCentralGovernmentEngineeringCollege,
  isKnownPrivateUniversity,
  isKnownStateGovernmentPharmacyCollege,
  isKnownStandalonePrivatePharmacyCollege,
  isKnownStateGovernmentEngineeringCollege,
  normalizeInstituteName,
};
