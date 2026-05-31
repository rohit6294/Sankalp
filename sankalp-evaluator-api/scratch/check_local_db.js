const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
    return;
  }
  console.log('Database opened successfully.');
});

db.serialize(() => {
  // Check if cutoffs table exists
  db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cutoffs'", (err, row) => {
    if (err) {
      console.error('Error checking table:', err);
      return;
    }
    if (!row) {
      console.log('Table cutoffs does NOT exist!');
      return;
    }
    console.log('Table cutoffs exists.');

    // Count total records
    db.get("SELECT count(*) as count FROM cutoffs", (err, countRow) => {
      if (err) {
        console.error('Error counting records:', err);
      } else {
        console.log('Total records in cutoffs:', countRow.count);
      }
    });

    // Count by year
    db.all("SELECT year, count(*) as count, count(distinct institute) as colleges FROM cutoffs GROUP BY year", (err, rows) => {
      if (err) {
        console.error('Error counting by year:', err);
      } else {
        console.log('Records by year:', rows);
      }
      db.close();
    });
  });
});
