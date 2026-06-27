const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'cutoffs.db');
const sqliteDb = new sqlite3.Database(dbPath);

async function simulateChoiceFilling(rank, category, quota, tfw, collegeType, branches = []) {
  return new Promise((resolve, reject) => {
    const categoriesToQuery = [category];
    if (tfw) categoriesToQuery.push('Tuition Fee Waiver');
    const placeholders = categoriesToQuery.map(() => '?').join(',');

    sqliteDb.all(`
      SELECT institute, program, stream, college_type, seat_type, quota, year, closing_rank, round
      FROM cutoffs
      WHERE category IN (${placeholders})
        AND seat_type != 'JEE(Main) Seats'
    `, categoriesToQuery, (err, rows) => {
      if (err) return reject(err);

      const grouped = {};
      rows.forEach(row => {
        const instUpper = String(row.institute || '').toUpperCase().trim();
        if (instUpper.startsWith('INSTITUTE OF ENGINEERING & MANAGEMENT') || 
            instUpper.startsWith('INSTITUTE OF ENGINEERING AND MANAGEMENT')) {
          return;
        }

        // TFW check
        const p = row.program.toUpperCase();
        let isRowTfw = p.includes('TFW') || p.includes('TUITION FEE WAIVER') || String(row.category).toUpperCase().includes('TFW') || String(row.seat_type).toUpperCase().includes('TFW');
        
        const key = `${row.institute}|${row.program}|${isRowTfw ? 'TFW' : 'OPEN'}|${row.quota}`;
        
        if (!grouped[key]) {
          grouped[key] = {
            institute: row.institute,
            program: row.program,
            stream: (row.stream || '').replace('/JEE(Main) Seats', '').replace('(JEE(Main) Seats)', '').replace('()', '').trim(),
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
      Object.keys(grouped).forEach(key => {
        const item = grouped[key];

        // Quota
        if (quota && quota !== 'All') {
          const isPrivateCollege = [
            'Private University',
            'Private Engineering College',
            'Stand Alone Private Pharmacy College'
          ].includes(item.college_type);
          if (!isPrivateCollege && item.quota !== quota) return;
        }

        // TFW
        if (item.isTfw && !tfw) return;

        // Base cutoff
        const yearsWithData = Object.keys(item.cutoffs).map(Number).sort((a, b) => b - a);
        if (yearsWithData.length === 0) return;
        const baseCutoff = item.cutoffs[yearsWithData[0]];

        processedChoices.push({
          institute: item.institute,
          program: item.program,
          quota: item.quota,
          baseCutoff
        });
      });

      resolve(processedChoices);
    });
  });
}

async function runAudit() {
  console.log('Auditing data logic...');
  
  const results = await simulateChoiceFilling(5000, 'Open', 'All India', false, 'All', []);
  
  // Find Heritage CSE
  const heritageCse = results.filter(r => r.institute.includes('Heritage') && r.program.includes('Computer Science & Engineering'));
  console.log('\\nHeritage CSE records found in output:');
  console.table(heritageCse);

  // Check for any insanely high cutoffs for famous colleges
  const famousAnomalies = results.filter(r => 
    (r.institute.includes('Jadavpur') || r.institute.includes('Heritage') || r.institute.includes('Kalyani'))
    && r.baseCutoff > 25000
    && r.program === 'Computer Science & Engineering'
  );
  if (famousAnomalies.length > 0) {
    console.log('\\n⚠️ WARNING: Found anomalous high cutoffs for top colleges (leak suspected):');
    console.table(famousAnomalies);
  } else {
    console.log('\\n✅ No anomalous high cutoffs found for top colleges.');
  }

  // Check for private colleges with Home State selected
  const hsResults = await simulateChoiceFilling(5000, 'Open', 'Home State', false, 'All', []);
  const pvtInHs = hsResults.filter(r => r.institute.includes('Heritage') || r.institute.includes('Techno'));
  if (pvtInHs.length > 0) {
    console.log('\\n✅ Private colleges correctly appear for Home State filter.');
  } else {
    console.log('\\n⚠️ WARNING: Private colleges missing in Home State filter.');
  }

  db.close();
}

runAudit();
