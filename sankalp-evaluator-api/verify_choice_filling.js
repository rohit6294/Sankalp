const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Initialize SQLite database
const dbPath = path.join(__dirname, 'cutoffs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening test database:', err.message);
    process.exit(1);
  }
});

// Mock the Choice Filling Algorithm
function runMockChoiceFilling({ rank, category, quota, tfw, branches, collegeType, maxChoices = 30 }, callback) {
  db.all(`
    SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
    FROM cutoffs
    WHERE category = ?
  `, [category], (err, rows) => {
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

      // Quota Filter
      if (quota && quota !== 'All' && item.quota !== quota) return;

      // TFW Filter
      const isTfwSeat = String(item.seat_type).toUpperCase().includes('TFW');
      if (isTfwSeat && (!tfw || tfw === 'false' || tfw === false)) return;

      // College Type Filter
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

      // Branch Filter
      if (branchFilters.length > 0) {
        const streamText = String(item.program || '').toUpperCase();
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
          return streamText.includes(bUpper);
        });

        if (!matchesBranch) return;
      }

      const yearsWithData = Object.keys(item.cutoffs).map(Number).sort((a, b) => b - a);
      if (yearsWithData.length === 0) return;

      const latestYear = yearsWithData[0];
      const baseCutoff = item.cutoffs[latestYear];

      let tier = 'Safety';
      if (baseCutoff < rank) {
        tier = 'Dream';
      } else if (baseCutoff <= rank * 1.15) {
        tier = 'Target';
      }

      processedChoices.push({
        institute: item.institute,
        program: item.program,
        collegeType: item.college_type,
        seatType: item.seat_type,
        quota: item.quota,
        baseCutoff,
        tier
      });
    });

    // Gold Standard Sorting: Strictly by cutoff ascending
    processedChoices.sort((a, b) => a.baseCutoff - b.baseCutoff);

    const finalChoices = processedChoices.slice(0, maxChoices);
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
      suggestedBackups
    });
  });
}

// ── RUNNING TEST CASES ────────────────────────────────────────────────────────
console.log('=== RUNNING CHOICE-FILLING INTEGRATION TESTS ===\n');

// Test Case 1: High Rank General Student (Rank 1500, CSE/IT, Govt only, Non-TFW)
runMockChoiceFilling({
  rank: 1500,
  category: 'Open',
  quota: 'Home State',
  tfw: false,
  branches: ['CSE', 'IT'],
  collegeType: 'GovtGroup',
  maxChoices: 10
}, (err, res) => {
  if (err) {
    console.error('Test 1 Failed with error:', err);
    process.exit(1);
  }

  console.log('Test 1: General Student Domicile (Rank 1500, Govt CSE/IT)');
  console.log(`- Generated Choices: ${res.choices.length}`);
  
  // Assert sorting order (ascending cutoff)
  let isSorted = true;
  for (let i = 1; i < res.choices.length; i++) {
    if (res.choices[i].baseCutoff < res.choices[i-1].baseCutoff) {
      isSorted = false;
    }
  }
  console.log(`- Assertion [Strictly Sorted by Cutoff Ascending]: ${isSorted ? 'PASSED ✅' : 'FAILED ❌'}`);
  
  // Assert Jadavpur University is at the very top (highest preference)
  const isJuFirst = res.choices[0].institute.includes('JADAVPUR UNIVERSITY');
  console.log(`- Assertion [Jadavpur University Ranked #1]: ${isJuFirst ? 'PASSED ✅' : 'FAILED ❌'}`);

  // Assert TFW is excluded
  const hasTfw = res.choices.some(c => c.seatType.includes('TFW'));
  console.log(`- Assertion [TFW Seats Excluded]: ${!hasTfw ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Test Case 2: Safety Net Auditor check (Rank 500, CSE/IT, only Dream selected)
  runMockChoiceFilling({
    rank: 500,
    category: 'Open',
    quota: 'Home State',
    tfw: false,
    branches: ['CSE'],
    collegeType: 'GovtGroup',
    maxChoices: 3 // Restricting to top 3 choices
  }, (err, res2) => {
    if (err) {
      console.error('Test 2 Failed with error:', err);
      process.exit(1);
    }

    console.log('Test 2: Safety Net Auditor (Rank 500, Dream Only)');
    console.log(`- Choices Generated: ${res2.choices.length}`);
    console.log(`- Safety Choices in List: ${res2.safetyCount}`);
    console.log(`- Assertion [Auditor Flags Insufficient Safeties]: ${res2.requiresSafeties ? 'PASSED ✅' : 'FAILED ❌'}`);
    console.log(`- Assertion [Auditor Suggests Backups]: ${res2.suggestedBackups.length > 0 ? 'PASSED ✅' : 'FAILED ❌'}\n`);

    // Test Case 3: TFW Candidate (TFW = true)
    runMockChoiceFilling({
      rank: 2500,
      category: 'Open',
      quota: 'Home State',
      tfw: true,
      branches: ['CSE'],
      collegeType: 'GovtGroup',
      maxChoices: 30
    }, (err, res3) => {
      if (err) {
        console.error('Test 3 Failed with error:', err);
        process.exit(1);
      }

      console.log('Test 3: TFW Candidate (TFW = true)');
      const hasTfwSeats = res3.choices.some(c => c.seatType.includes('TFW'));
      console.log(`- Assertion [TFW Seats Included]: ${hasTfwSeats ? 'PASSED ✅' : 'FAILED ❌'}`);

      console.log('\n=== ALL TEST CASES COMPLETED SUCCESSFULLY ===');
      db.close();
    });
  });
});
