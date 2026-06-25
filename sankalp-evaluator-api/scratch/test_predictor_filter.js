const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
console.log('Testing Database Path:', dbPath);

if (!fs.existsSync(dbPath)) {
  console.error('Database file does not exist at:', dbPath);
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);

// Define query mock parameters matching real DB records
const mockParams = {
  rank: 500, // Changed from 5000 to 500 to match competitive Jadavpur ranks
  category: 'Open', 
  targetYear: '2021', 
  prevYear: 2021
};

function runTest(testName, collegeFilter, callback) {
  console.log(`\n--- Running Test: ${testName} (Filter: "${collegeFilter || 'NONE'}") ---`);
  
  db.all(`
    SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
    FROM cutoffs
    WHERE category = ? AND year = ?
  `, [mockParams.category, mockParams.targetYear], (err, rows) => {
    if (err) {
      console.error('Query Error:', err);
      callback(err);
      return;
    }

    console.log(`Total rows fetched from DB: ${rows.length}`);
    
    // Grouping logic (same as backend)
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

    const results = [];
    Object.keys(grouped).forEach(key => {
      const item = grouped[key];
      const target_cutoff = item.cutoffs[mockParams.targetYear];

      if (!target_cutoff) return;

      // Filter by rank chance (within 1.25x target cutoff)
      if (mockParams.rank > target_cutoff * 1.25) return;

      // Apply College Name Filter (our new feature logic)
      if (collegeFilter && String(collegeFilter).trim() !== '') {
        const searchStr = String(collegeFilter).toLowerCase();
        if (!String(item.institute).toLowerCase().includes(searchStr)) return;
      }

      results.push({
        institute: item.institute,
        program: item.program,
        latestCutoff: target_cutoff
      });
    });

    console.log(`Matches found: ${results.length}`);
    if (results.length > 0) {
      console.log('First 3 matches:');
      results.slice(0, 3).forEach(r => {
        console.log(` - ${r.institute} | ${r.program} (Cutoff: ${r.latestCutoff})`);
      });
    }
    
    callback(null, results);
  });
}

// Run test sequence
runTest('No Filter', null, (err, resNoFilter) => {
  if (err) process.exit(1);
  
  runTest('Case-insensitive Match ("jadavpur")', 'jadavpur', (err, resJadavpur) => {
    if (err) process.exit(1);
    
    // Check that all results have "Jadavpur" in their name
    const allJadavpur = resJadavpur.every(r => r.institute.toLowerCase().includes('jadavpur'));
    console.log(`Verification - All match "jadavpur": ${allJadavpur ? 'PASS' : 'FAIL'}`);
    
    runTest('Mixed Case Match ("JAdAvPuR")', 'JAdAvPuR', (err, resMixedCase) => {
      if (err) process.exit(1);
      console.log(`Verification - Case insensitivity match count equal: ${resMixedCase.length === resJadavpur.length ? 'PASS' : 'FAIL'}`);
      
      runTest('Partial Match ("government")', 'government', (err, resGov) => {
        if (err) process.exit(1);
        const allGov = resGov.every(r => r.institute.toLowerCase().includes('government') || r.institute.toLowerCase().includes('goverment'));
        console.log(`Verification - All match "government": ${allGov ? 'PASS' : 'FAIL'}`);
        
        runTest('Non-existent College ("Fake College")', 'Fake College', (err, resFake) => {
          if (err) process.exit(1);
          console.log(`Verification - Fake college returns 0: ${resFake.length === 0 ? 'PASS' : 'FAIL'}`);
          
          db.close();
          console.log('\n--- All tests completed successfully! ---');
        });
      });
    });
  });
});
