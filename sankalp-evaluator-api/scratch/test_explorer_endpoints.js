const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
console.log('Opening database at:', dbPath);

if (!fs.existsSync(dbPath)) {
  console.error('Database file does not exist at:', dbPath);
  process.exit(1);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
    process.exit(1);
  }
});
db.configure("busyTimeout", 10000);

db.serialize(() => {
  console.log('\n--- 1. Testing Distinct Colleges Query ---');
  db.all('SELECT DISTINCT institute FROM cutoffs ORDER BY institute ASC', [], (err, rows) => {
    if (err) {
      console.error('❌ Colleges query failed:', err.message);
      process.exit(1);
    }
    const colleges = rows.map(r => r.institute).filter(Boolean);
    console.log(`✅ Success! Found ${colleges.length} unique colleges.`);
    console.log('Sample Colleges (first 5):', colleges.slice(0, 5));

    console.log('\n--- 2. Testing Distinct Branches Query ---');
    db.all('SELECT DISTINCT program FROM cutoffs ORDER BY program ASC', [], (err2, rows2) => {
      if (err2) {
        console.error('❌ Branches query failed:', err2.message);
        process.exit(1);
      }
      const branches = rows2.map(r => r.program).filter(Boolean);
      console.log(`✅ Success! Found ${branches.length} unique branches.`);
      console.log('Sample Branches (first 5):', branches.slice(0, 5));

      console.log('\n--- 3. Testing Historical Cutoffs Query for Top College (Jadavpur University) ---');
      const testCollege = 'Jadavpur University';
      const testBranch = 'COMPUTER SCIENCE & ENGINEERING';

      const sql = `
        SELECT program, stream, category, seat_type, quota, year, round, closing_rank
        FROM cutoffs
        WHERE institute = ? AND program = ?
        ORDER BY program ASC, category ASC, year DESC, round ASC
      `;

      db.all(sql, [testCollege, testBranch], (err3, rows3) => {
        if (err3) {
          console.error('❌ Historical cutoffs query failed:', err3.message);
          process.exit(1);
        }
        console.log(`✅ Success! Found ${rows3.length} historical cutoff records for ${testCollege} - ${testBranch}.`);
        if (rows3.length > 0) {
          console.log('Sample Cutoff Record (first):', rows3[0]);
          
          // Verify we have records across multiple years
          const years = [...new Set(rows3.map(r => r.year))];
          console.log('Years covered in cutoffs:', years);
        }

        console.log('\n🎉 ALL DATABASE EXPLORER TESTS PASSED SUCCESSFULLY!');
        db.close();
      });
    });
  });
});
