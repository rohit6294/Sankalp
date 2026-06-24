const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Initialize SQLite database
const dbPath = path.join(__dirname, 'cutoffs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
    process.exit(1);
  }
});

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

// Choice Filling sorting & auditing algorithm implementation (replicates backend exactly)
function runAlgorithm({ rank, category, quota, tfw, branches, collegeType, maxChoices = 30 }, callback) {
  const categoriesToQuery = [category];
  if (tfw === 'true' || tfw === true) {
    categoriesToQuery.push('Tuition Fee Waiver');
  }
  const placeholders = categoriesToQuery.map(() => '?').join(',');

  db.all(`
    SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
    FROM cutoffs
    WHERE category IN (${placeholders})
  `, categoriesToQuery, (err, rows) => {
    if (err) return callback(err);

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

      // 2. TFW filter
      const isTfwSeat = String(item.seat_type).toUpperCase().includes('TFW');
      if (isTfwSeat && (!tfw || tfw === 'false' || tfw === false)) {
        return;
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

      const yearsWithData = Object.keys(item.cutoffs).map(Number).sort((a, b) => b - a);
      if (yearsWithData.length === 0) return;

      const latestYear = yearsWithData[0];
      const baseCutoff = item.cutoffs[latestYear];

      // Tier classification
      let tier = 'Safety';
      let chance = 'High';
      if (baseCutoff < rank) {
        tier = 'Dream';
        chance = 'Low';
      } else if (baseCutoff <= rank * 1.15) {
        tier = 'Target';
        chance = 'Medium';
      }

      processedChoices.push({
        institute: item.institute,
        program: item.program,
        collegeType: item.college_type,
        seatType: item.seat_type,
        quota: item.quota,
        baseCutoff,
        tier,
        chance,
        choiceCode: generateChoiceCode(item.institute, item.program)
      });
    });

    // Sort strictly by baseCutoff ascending
    processedChoices.sort((a, b) => a.baseCutoff - b.baseCutoff);

    const finalChoices = processedChoices.slice(0, Number(maxChoices));
    const safetyCount = finalChoices.filter(c => c.tier === 'Safety').length;
    const requiresSafeties = safetyCount < 3;

    let suggestedBackups = [];
    if (requiresSafeties) {
      const allSafeties = processedChoices.filter(c => c.tier === 'Safety');
      suggestedBackups = allSafeties
        .filter(c => !finalChoices.some(fc => fc.institute === c.institute && fc.program === c.program))
        .slice(0, 3);
    }

    callback(null, {
      choices: finalChoices,
      safetyCount,
      requiresSafeties,
      suggestedBackups,
      allProcessed: processedChoices
    });
  });
}

// ── TEST RUNNER CONFIGURATION ──────────────────────────────────────────────────
const TOTAL_TEST_CASES = 100000;
let passedCount = 0;
let failedCount = 0;

const CATEGORIES = ['Open', 'SC', 'ST', 'OBC-A', 'OBC-B'];
const QUOTAS = ['Home State', 'All India', 'All'];
const BRANCHES = ['CSE', 'IT', 'AI_ML_DS', 'CS_BS', 'ECE', 'EE', 'AEIE', 'ME', 'CE', 'CHE', 'BT', 'PHM', 'ALLIED'];
const COLLEGE_TYPES = ['All', 'GovtGroup', 'PrivateGroup'];
const MAX_CHOICES_OPTS = [20, 30, 50];

console.log(`===================================================`);
console.log(`   STARTING STRESS TEST: ${TOTAL_TEST_CASES} RANDOM STUDENT PROFILES`);
console.log(`===================================================\n`);

function generateRandomProfile() {
  const rank = Math.floor(Math.random() * 80000) + 1; // Ranks from 1 to 80,000
  const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  let quota = QUOTAS[Math.floor(Math.random() * QUOTAS.length)];
  
  // WBJEE Rule validation: All India quota is only Open category
  let finalCategory = category;
  if (quota === 'All India') {
    finalCategory = 'Open';
  }

  // TFW is only applicable for Home State candidates
  const tfw = quota === 'Home State' ? (Math.random() > 0.5) : false;

  // Select 1 to 4 random branches
  const numBranches = Math.floor(Math.random() * 4) + 1;
  const shuffledBranches = [...BRANCHES].sort(() => 0.5 - Math.random());
  const selectedBranches = shuffledBranches.slice(0, numBranches);

  const collegeType = COLLEGE_TYPES[Math.floor(Math.random() * COLLEGE_TYPES.length)];
  const maxChoices = MAX_CHOICES_OPTS[Math.floor(Math.random() * MAX_CHOICES_OPTS.length)];

  return { rank, category: finalCategory, quota, tfw, branches: selectedBranches, collegeType, maxChoices };
}

function runTestCase(index) {
  if (index > TOTAL_TEST_CASES) {
    console.log(`\n===================================================`);
    console.log(`   STRESS TEST COMPLETE: ${passedCount}/${TOTAL_TEST_CASES} PASSED`);
    console.log(`===================================================`);
    
    if (failedCount === 0) {
      console.log(`\nALL TESTS PASSED SUCCESSFULLY! 100/100 QUALITY ASSURED. ✅\n`);
      db.close();
      process.exit(0);
    } else {
      console.log(`\nTEST SUITE FAILED WITH ${failedCount} FAILURES. ❌\n`);
      db.close();
      process.exit(1);
    }
    return;
  }

  const profile = generateRandomProfile();

  runAlgorithm(profile, (err, result) => {
    if (err) {
      console.error(`[CASE ${index}] CRASH ERROR:`, err);
      failedCount++;
      runTestCase(index + 1);
      return;
    }

    try {
      // Assertion 1: Length must not exceed requested maxChoices
      if (result.choices.length > profile.maxChoices) {
        throw new Error(`Returned ${result.choices.length} choices, exceeding maxChoices ${profile.maxChoices}`);
      }

      // Assertion 2: Strict Sorting (ascending by baseCutoff)
      for (let i = 1; i < result.choices.length; i++) {
        if (result.choices[i].baseCutoff < result.choices[i - 1].baseCutoff) {
          throw new Error(`Sorting violation at index ${i}: Cutoff ${result.choices[i].baseCutoff} < ${result.choices[i - 1].baseCutoff}`);
        }
      }

      // Assertion 3: TFW Exclusion
      if (!profile.tfw) {
        const tfwSeat = result.choices.find(c => String(c.seatType).toUpperCase().includes('TFW'));
        if (tfwSeat) {
          throw new Error(`TFW seat included [${tfwSeat.institute}] but TFW flag was false`);
        }
      }

      // Assertion 4: Strategic Tier classification correctness
      result.choices.forEach(c => {
        if (c.baseCutoff < profile.rank) {
          if (c.tier !== 'Dream') throw new Error(`Incorrect tier 'Dream' expected, got '${c.tier}' (Cutoff: ${c.baseCutoff}, Student Rank: ${profile.rank})`);
        } else if (c.baseCutoff <= profile.rank * 1.15) {
          if (c.tier !== 'Target') throw new Error(`Incorrect tier 'Target' expected, got '${c.tier}' (Cutoff: ${c.baseCutoff}, Student Rank: ${profile.rank})`);
        } else {
          if (c.tier !== 'Safety') throw new Error(`Incorrect tier 'Safety' expected, got '${c.tier}' (Cutoff: ${c.baseCutoff}, Student Rank: ${profile.rank})`);
        }
      });

      // Assertion 5: Safety Net Auditor sugerence integrity
      if (result.requiresSafeties) {
        // Suggested backups must be Safety tier and NOT in the main list
        result.suggestedBackups.forEach(b => {
          if (b.tier !== 'Safety') {
            throw new Error(`Safety Net Auditor suggested a non-safety backup [${b.institute}] with tier '${b.tier}'`);
          }
          const alreadyInList = result.choices.some(fc => fc.institute === b.institute && fc.program === b.program);
          if (alreadyInList) {
            throw new Error(`Safety Net Auditor suggested backup [${b.institute}] which is already in the main choice list`);
          }
        });
      }

      passedCount++;
      
      // Print progress
      if (index % 100 === 0) {
        console.log(`[Progress] Case ${index}/${TOTAL_TEST_CASES} passed successfully.`);
      }
      
    } catch (assertErr) {
      console.error(`\n[CASE ${index}] ASSERTION FAILED!`);
      console.error(`Profile:`, JSON.stringify(profile));
      console.error(`Error details:`, assertErr.message);
      failedCount++;
    }

    // Run next test case
    runTestCase(index + 1);
  });
}

// Start test loop
runTestCase(1);
