const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'cutoffs.db'));

db.all(
  `SELECT college_type, quota, seat_type, COUNT(*) as cnt 
   FROM cutoffs 
   GROUP BY college_type, quota, seat_type 
   ORDER BY college_type, quota`,
  (err, rows) => {
    if (err) { console.error(err); return; }
    console.log('=== College Type | Quota | Seat Type | Count ===');
    rows.forEach(r => console.log(`${r.college_type} | ${r.quota} | ${r.seat_type} | ${r.cnt}`));
    
    // Also check: private colleges with Home State quota
    db.all(
      `SELECT DISTINCT institute, quota, seat_type 
       FROM cutoffs 
       WHERE college_type IN ('Private University','Private Engineering College','Stand Alone Private Pharmacy College')
       ORDER BY institute, quota`,
      (err2, rows2) => {
        if (err2) { console.error(err2); return; }
        console.log('\n=== Private Colleges - Institute | Quota | Seat Type ===');
        let lastInst = '';
        rows2.forEach(r => {
          if (r.institute !== lastInst) {
            console.log(`\n${r.institute}:`);
            lastInst = r.institute;
          }
          console.log(`  ${r.quota} | ${r.seat_type}`);
        });
        db.close();
      }
    );
  }
);
