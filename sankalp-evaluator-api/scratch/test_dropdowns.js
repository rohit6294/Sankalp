const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
console.log('Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  // 1. Categories
  db.all('SELECT DISTINCT category FROM cutoffs ORDER BY category ASC', [], (err, rows) => {
    if (err) {
      console.error('Categories query failed:', err.message);
    } else {
      console.log('Categories found in DB:', rows.map(r => r.category).filter(Boolean));
    }
  });

  // 2. Seat Types
  db.all('SELECT DISTINCT seat_type FROM cutoffs ORDER BY seat_type ASC', [], (err, rows) => {
    if (err) {
      console.error('Seat types query failed:', err.message);
    } else {
      console.log('Seat types found in DB:', rows.map(r => r.seat_type).filter(Boolean));
    }
  });

  // 3. Quotas
  db.all('SELECT DISTINCT quota FROM cutoffs ORDER BY quota ASC', [], (err, rows) => {
    if (err) {
      console.error('Quotas query failed:', err.message);
    } else {
      console.log('Quotas found in DB:', rows.map(r => r.quota).filter(Boolean));
    }
  });

  // 4. Years
  db.all('SELECT DISTINCT year FROM cutoffs ORDER BY year DESC', [], (err, rows) => {
    if (err) {
      console.error('Years query failed:', err.message);
    } else {
      console.log('Years found in DB:', rows.map(r => r.year).filter(y => y !== null));
      db.close();
    }
  });
});
