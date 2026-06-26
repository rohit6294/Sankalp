const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
});

console.log('Searching Jadavpur University electronics-related records in cutoffs.db...');

db.all(`
  SELECT DISTINCT program, stream, seat_type 
  FROM cutoffs 
  WHERE institute LIKE '%Jadavpur University%' 
    AND (program LIKE '%ELECTRONICS%' OR stream LIKE '%ELECTRONICS%' OR program LIKE '%ECE%' OR stream LIKE '%ECE%' OR program LIKE '%ETCE%' OR stream LIKE '%ETCE%')
`, [], (err, rows) => {
  if (err) {
    console.error('Error running query:', err.message);
    process.exit(1);
  }

  console.log('\nMatching Records for Jadavpur University:');
  rows.forEach((row, index) => {
    console.log(`${index + 1}. Program: "${row.program}" | Stream: "${row.stream}" | Seat Type: "${row.seat_type}"`);
  });
  db.close();
});
