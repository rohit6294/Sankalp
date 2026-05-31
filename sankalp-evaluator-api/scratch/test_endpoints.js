const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 10000);

console.log('Testing categories query...');
db.all('SELECT DISTINCT category FROM cutoffs ORDER BY category ASC', [], (err, rows) => {
  if (err) {
    console.error('Categories Error:', err);
  } else {
    console.log(`Categories Success! Found ${rows.length} categories.`);
    console.log('Sample:', rows.slice(0, 5).map(r => r.category));
  }

  console.log('\nTesting seat-types query...');
  db.all('SELECT DISTINCT seat_type FROM cutoffs ORDER BY seat_type ASC', [], (err2, rows2) => {
    if (err2) {
      console.error('Seat Types Error:', err2);
    } else {
      console.log(`Seat Types Success! Found ${rows2.length} seat types.`);
      console.log('Sample:', rows2.map(r => r.seat_type));
    }

    console.log('\nTesting quotas query...');
    db.all('SELECT DISTINCT quota FROM cutoffs ORDER BY quota ASC', [], (err3, rows3) => {
      if (err3) {
        console.error('Quotas Error:', err3);
      } else {
        console.log(`Quotas Success! Found ${rows3.length} quotas.`);
        console.log('Sample:', rows3.map(r => r.quota));
      }
      db.close();
    });
  });
});
