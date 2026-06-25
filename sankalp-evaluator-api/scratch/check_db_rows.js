const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath);

db.all(`SELECT DISTINCT category FROM cutoffs LIMIT 20`, [], (err, rows) => {
  if (err) {
    console.error('Error fetching categories:', err);
    db.close();
    return;
  }
  console.log('Categories in DB:', rows.map(r => r.category));
  
  db.all(`SELECT * FROM cutoffs LIMIT 5`, [], (err, rows) => {
    if (err) {
      console.error('Error fetching rows:', err);
    } else {
      console.log('Sample Rows:', rows);
    }
    db.close();
  });
});
