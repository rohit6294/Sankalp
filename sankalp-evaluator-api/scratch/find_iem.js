const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
});

console.log('Searching for institutes containing "IEM" or "Institute of Engineering & Management" or similar...');

db.all(`
  SELECT DISTINCT institute 
  FROM cutoffs 
  WHERE institute LIKE '%IEM%' 
     OR institute LIKE '%INSTITUTE OF ENGINEERING % MANAGEMENT%'
     OR institute LIKE '%ENGINEERING % MANAGEMENT%'
  ORDER BY institute ASC
`, [], (err, rows) => {
  if (err) {
    console.error('Error running query:', err.message);
    process.exit(1);
  }

  console.log('\nMatching Institutes Found:');
  rows.forEach((row, index) => {
    console.log(`${index + 1}. "${row.institute}"`);
  });
  db.close();
});
